"""M194 local operational CRM: bulk import/export, follow-ups and sales analytics.

Extends M193 without changing the historical 180-task acceptance or production gate.
Tenant and role are derived exclusively from an authenticated bearer token.
"""
from __future__ import annotations

from collections import Counter
import csv
from hashlib import sha256
import io
import json

from osgard_m192.runtime import (
    ROLES, KEY_RE, Invalid, Conflict, Unauthorized, canonical, _secret_hash,
    _text, _identifier, _uid, _object,
)
from osgard_m193.runtime import Director193, _version

OPS194 = {
    'commerce.crm.import.preview': {'owner', 'operator'},
    'commerce.crm.import.commit': {'owner', 'operator'},
    'commerce.crm.export.csv': {'owner'},
    'commerce.crm.followups.queue': ROLES,
    'commerce.crm.followups.reschedule': {'owner', 'operator'},
    'commerce.crm.followups.bulk_complete': {'owner', 'operator'},
    'commerce.crm.pipeline.metrics': ROLES,
}
WRITES194 = frozenset({
    'commerce.crm.import.commit',
    'commerce.crm.followups.reschedule',
    'commerce.crm.followups.bulk_complete',
})
STAGES = ('new', 'qualified', 'proposal', 'won', 'lost')
IMPORT_LIMIT = 200
CSV_BYTE_LIMIT = 64 * 1024


def _csv_rows(source):
    if not isinstance(source, str) or not source or len(source.encode('utf-8')) > CSV_BYTE_LIMIT:
        raise Invalid('CSV must be UTF-8 text up to 64 KiB')
    if '\x00' in source:
        raise Invalid('NUL character in CSV')
    try:
        reader = csv.reader(io.StringIO(source.lstrip('\ufeff'), newline=''), strict=True)
        header = next(reader)
        if header != ['name', 'contact']:
            raise Invalid('CSV header must be exactly name,contact')
        records, seen = [], set()
        for values in reader:
            if len(values) != 2:
                raise Invalid('CSV row must contain exactly two columns')
            name = _text(values[0], 'name')
            contact = _text(values[1], 'contact', 200)
            key = (name.casefold(), contact.casefold())
            if key in seen:
                raise Invalid('duplicate customer in CSV')
            seen.add(key)
            records.append({'name': name, 'contact': contact})
            if len(records) > IMPORT_LIMIT:
                raise Invalid('CSV import is limited to 200 records')
    except (csv.Error, StopIteration) as exc:
        raise Invalid('malformed CSV') from exc
    if not records:
        raise Invalid('CSV has no data rows')
    return records


def _csv_digest(rows):
    return sha256(canonical(rows).encode('utf-8')).hexdigest()


def _existing(db, tenant):
    return {(r['name'].casefold(), r['contact'].casefold()) for r in
            db.execute('SELECT name,contact FROM customers WHERE tenant_id=?', (tenant,))}


def _safe_cell(s):
    # Neutralize spreadsheet formulas even when prefixed with whitespace.
    return "'" + s if s.lstrip().startswith(('=', '+', '-', '@')) else s


class Director194(Director193):
    def execute(self, token, op, payload, idem_key=None):
        if op not in OPS194:
            return super().execute(token, op, payload, idem_key)
        if not isinstance(payload, dict):
            raise Invalid('payload must be an object')
        write = op in WRITES194
        if write and (not isinstance(idem_key, str) or not KEY_RE.fullmatch(idem_key)):
            raise Invalid('writes require an idempotency key of 8..100 characters')
        with self.connect(transaction=True) as db:
            identity = self._identity(db, token)
            if identity['role'] not in OPS194[op]:
                raise Unauthorized('permission denied')
            tenant, actor = identity['tenant_id'], identity['actor']
            if write:
                try:
                    request_sha = _secret_hash(canonical({'op': op, 'payload': payload}))
                except (TypeError, ValueError) as exc:
                    raise Invalid('invalid request JSON values') from exc
                cached = db.execute(
                    'SELECT op,request_sha,response_json FROM requests WHERE tenant_id=? AND idem_key=?',
                    (tenant, idem_key)).fetchone()
                if cached is not None:
                    if cached['op'] != op or cached['request_sha'] != request_sha:
                        raise Conflict('idempotency key reused with different request')
                    return json.loads(cached['response_json'])
            output = self._apply_194(db, tenant, op, payload)
            if write:
                db.execute('INSERT INTO requests VALUES (?,?,?,?,?)',
                           (tenant, idem_key, op, request_sha, canonical(output)))
                db.execute('INSERT INTO audit(tenant_id,actor,operation,request_sha,recorded_at) VALUES (?,?,?,?,?)',
                           (tenant, actor, op, request_sha, self.clock()))
            return output

    def _apply_194(self, db, tenant, op, p):
        now = self.clock()
        if op in ('commerce.crm.import.preview', 'commerce.crm.import.commit'):
            required = {'csv'} if op.endswith('.preview') else {'csv', 'preview_sha256'}
            _object(p, required)
            rows = _csv_rows(p['csv'])
            digest = _csv_digest(rows)
            existing = _existing(db, tenant)
            overlap = sum((x['name'].casefold(), x['contact'].casefold()) in existing for x in rows)
            if op.endswith('.preview'):
                return {'rows': len(rows), 'already_exists': overlap, 'to_create': len(rows)-overlap,
                        'preview_sha256': digest, 'can_commit': overlap == 0,
                        'source': 'LOCAL_CSV_ONLY'}
            if not isinstance(p['preview_sha256'], str) or p['preview_sha256'] != digest:
                raise Conflict('CSV no longer matches preview')
            if overlap:
                raise Conflict('one or more customers already exist; recheck import preview')
            ids = []
            for x in rows:
                ident = _uid()
                db.execute('INSERT INTO customers VALUES (?,?,?,?,?)',
                           (ident, tenant, x['name'], x['contact'], now))
                ids.append(ident)
            return {'created': len(ids), 'customer_ids': ids, 'preview_sha256': digest}
        if op == 'commerce.crm.export.csv':
            _object(p, set())
            buf = io.StringIO(newline='')
            writer = csv.writer(buf, lineterminator='\r\n')
            writer.writerow(('name', 'contact'))
            rows = list(db.execute('SELECT name,contact FROM customers WHERE tenant_id=? ORDER BY created_at,id',
                                   (tenant,)))
            if len(rows) > 5000:
                raise Invalid('CSV export limit is 5000 customers')
            for row in rows:
                writer.writerow((_safe_cell(row['name']), _safe_cell(row['contact'])))
            return {'csv': buf.getvalue(), 'count': len(rows), 'formula_escaped': True,
                    'source': 'LOCAL_TENANT_ONLY'}
        if op == 'commerce.crm.followups.queue':
            _object(p, set(), {'days', 'limit', 'include_unscheduled'})
            days = p.get('days', 14)
            limit = p.get('limit', 200)
            unscheduled = p.get('include_unscheduled', True)
            if type(days) is not int or not 1 <= days <= 90:
                raise Invalid('days must be an integer 1..90')
            if type(limit) is not int or not 1 <= limit <= 200:
                raise Invalid('limit must be an integer 1..200')
            if type(unscheduled) is not bool:
                raise Invalid('include_unscheduled must be boolean')
            horizon = now + days * 86400
            # Include all open activities in tally, bounded response rows.
            counts = {'overdue': 0, 'upcoming': 0, 'unscheduled': 0, 'beyond_horizon': 0}
            for row in db.execute('SELECT due_at FROM crm_activities WHERE tenant_id=? AND status=?',
                                  (tenant, 'open')):
                due = row['due_at']
                key = ('unscheduled' if due is None else 'overdue' if due < now else
                       'upcoming' if due <= horizon else 'beyond_horizon')
                counts[key] += 1
            sql = '''SELECT a.id,a.customer_id,a.deal_id,a.kind,a.details,a.due_at,a.version,
                            c.name AS customer_name, d.title AS deal_title
                     FROM crm_activities a
                     JOIN customers c ON c.id=a.customer_id AND c.tenant_id=a.tenant_id
                     LEFT JOIN deals d ON d.id=a.deal_id AND d.tenant_id=a.tenant_id
                     WHERE a.tenant_id=? AND a.status='open' AND
                     (a.due_at<=?'''
            if unscheduled:
                sql += ' OR a.due_at IS NULL'
            sql += ''') ORDER BY (a.due_at IS NULL),a.due_at,a.created_at,a.id LIMIT ?'''
            results = []
            for row in db.execute(sql, (tenant, horizon, limit)):
                item = dict(row)
                item['urgency'] = ('unscheduled' if item['due_at'] is None else
                                   'overdue' if item['due_at'] < now else 'upcoming')
                results.append(item)
            return {'items': results, 'counts': counts, 'truncated':
                    counts['overdue']+counts['upcoming']+(counts['unscheduled'] if unscheduled else 0)>len(results),
                    'as_of': now, 'days': days}
        if op == 'commerce.crm.followups.reschedule':
            _object(p, {'activity_id', 'expected_version', 'due_at'})
            _identifier(p['activity_id'], 'activity id')
            expected = _version(p['expected_version'])
            due = p['due_at']
            if due is not None and (type(due) is not int or
                                    not now-365*86400 <= due <= now+366*86400):
                raise Invalid('invalid due_at range')
            row = db.execute('SELECT status,version FROM crm_activities WHERE tenant_id=? AND id=?',
                             (tenant, p['activity_id'])).fetchone()
            if row is None:
                raise Invalid('activity not found in tenant')
            if row['version'] != expected or row['status'] != 'open':
                raise Conflict('stale or completed activity')
            db.execute('UPDATE crm_activities SET due_at=?,version=? WHERE tenant_id=? AND id=?',
                       (due, expected+1, tenant, p['activity_id']))
            return {'id': p['activity_id'], 'due_at': due, 'version': expected+1}
        if op == 'commerce.crm.followups.bulk_complete':
            _object(p, {'activities'})
            items = p['activities']
            if not isinstance(items, list) or not 1 <= len(items) <= 50:
                raise Invalid('activities must contain 1..50 records')
            seen = set()
            validated = []
            for record in items:
                _object(record, {'activity_id', 'expected_version'})
                ident = _identifier(record['activity_id'], 'activity id')
                if ident in seen:
                    raise Invalid('duplicate activity in batch')
                seen.add(ident)
                expected = _version(record['expected_version'])
                row = db.execute('SELECT status,version FROM crm_activities WHERE tenant_id=? AND id=?',
                                 (tenant, ident)).fetchone()
                if row is None:
                    raise Invalid('activity not found in tenant')
                if row['status'] != 'open' or row['version'] != expected:
                    raise Conflict('stale or completed activity in batch')
                validated.append((ident, expected))
            result = []
            for ident, expected in validated:
                db.execute('UPDATE crm_activities SET status=?,version=?,completed_at=? '
                           'WHERE tenant_id=? AND id=?',
                           ('done', expected+1, now, tenant, ident))
                result.append({'id': ident, 'version': expected+1})
            return {'completed': len(result), 'activities': result}
        if op == 'commerce.crm.pipeline.metrics':
            _object(p, set())
            groups = {x: {'count': 0, 'amount_minor': 0} for x in STAGES}
            for row in db.execute('SELECT stage,COUNT(*) AS n,SUM(amount_minor) AS amount '
                                  'FROM deals WHERE tenant_id=? GROUP BY stage', (tenant,)):
                groups[row['stage']] = {'count': row['n'], 'amount_minor': row['amount'] or 0}
            total = sum(x['count'] for x in groups.values())
            closed = groups['won']['count']+groups['lost']['count']
            return {'stages': groups, 'total_deals': total,
                    'active_amount_minor': sum(groups[s]['amount_minor'] for s in STAGES[:3]),
                    'won_amount_minor': groups['won']['amount_minor'],
                    'closed_deals': closed,
                    'win_rate_percent': round(groups['won']['count']*100/closed, 1) if closed else None,
                    'win_rate_denominator': 'closed_won_plus_lost',
                    'source': 'LOCAL_SQLITE_AGGREGATE_NOT_FORECAST'}
        raise Invalid('unknown M194 operation')
