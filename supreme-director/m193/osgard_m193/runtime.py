"""M193: production-inert CRM extension of the M192 local Director.

No outbound calls, payments or production integrations. All writes are tenant
bound, permission checked, transactional and idempotent.
"""
from __future__ import annotations

from collections import Counter
import json
import sqlite3

from osgard_m192.runtime import (
    Director as Director192, ROLES, WRITES, Invalid, Unauthorized, Conflict,
    KEY_RE, STAGES, canonical, _secret_hash, _uid, _text, _object, _identifier,
)

EXTRA_OPS = {
    'titan.session.get': ROLES,
    'commerce.crm.customers.list': ROLES,
    'commerce.crm.customers.update': {'owner', 'operator'},
    'commerce.crm.deals.list': ROLES,
    'commerce.crm.deals.update': {'owner', 'operator'},
    'commerce.crm.activities.create': {'owner', 'operator'},
    'commerce.crm.activities.list': ROLES,
    'commerce.crm.activities.complete': {'owner', 'operator'},
    'commerce.crm.overview': ROLES,
}
EXTRA_WRITES = frozenset(op for op in EXTRA_OPS if op.endswith('.update') or
                          op.endswith('.create') or op.endswith('.complete'))
ACTIVITY_TYPES = frozenset({'call', 'email', 'meeting', 'note'})
TRANSITIONS = {
    'new': {'qualified', 'lost'},
    'qualified': {'proposal', 'lost'},
    'proposal': {'won', 'lost'},
    'won': set(),
    'lost': set(),
}


def _version(value):
    if type(value) is not int or value < 1 or value > 2**31 - 1:
        raise Invalid('expected_version must be a positive integer')
    return value


def _amount(value):
    if type(value) is not int or not 0 <= value <= 10**12:
        raise Invalid('amount_minor must be an integer in range 0..10^12')
    return value


class Director193(Director192):
    def initialize(self):
        super().initialize()
        with self.connect() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS crm_customer_meta (
              tenant_id TEXT NOT NULL,
              customer_id TEXT NOT NULL,
              version INTEGER NOT NULL CHECK(version >= 2),
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(tenant_id, customer_id));
            CREATE TABLE IF NOT EXISTS crm_deal_meta (
              tenant_id TEXT NOT NULL,
              deal_id TEXT NOT NULL,
              version INTEGER NOT NULL CHECK(version >= 2),
              updated_at INTEGER NOT NULL,
              PRIMARY KEY(tenant_id, deal_id));
            CREATE TABLE IF NOT EXISTS crm_activities (
              id TEXT PRIMARY KEY,
              tenant_id TEXT NOT NULL,
              customer_id TEXT NOT NULL,
              deal_id TEXT,
              kind TEXT NOT NULL CHECK(kind IN ('call','email','meeting','note')),
              details TEXT NOT NULL,
              due_at INTEGER,
              status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
              version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
              created_at INTEGER NOT NULL,
              completed_at INTEGER);
            CREATE INDEX IF NOT EXISTS crm_activities_tenant_due
              ON crm_activities(tenant_id,status,due_at,id);
            CREATE INDEX IF NOT EXISTS crm_activities_customer
              ON crm_activities(tenant_id,customer_id,created_at);
            ''')

    def execute(self, token, op, payload, idem_key=None):
        if op not in EXTRA_OPS:
            return super().execute(token, op, payload, idem_key)
        if not isinstance(payload, dict):
            raise Invalid('payload must be object')
        write = op in EXTRA_WRITES
        if write and (not isinstance(idem_key, str) or not KEY_RE.fullmatch(idem_key)):
            raise Invalid('writes require 8..100 character idempotency key')
        with self.connect(transaction=True) as db:
            identity = self._identity(db, token)
            if identity['role'] not in EXTRA_OPS[op]:
                raise Unauthorized('permission denied')
            tenant, actor = identity['tenant_id'], identity['actor']
            if write:
                try:
                    request_sha = _secret_hash(canonical({'op': op, 'payload': payload}))
                except (TypeError, ValueError) as exc:
                    raise Invalid('invalid non-JSON payload value') from exc
                cached = db.execute('SELECT op,request_sha,response_json FROM requests WHERE tenant_id=? AND idem_key=?',
                                    (tenant, idem_key)).fetchone()
                if cached:
                    if cached['op'] != op or cached['request_sha'] != request_sha:
                        raise Conflict('idempotency key reused with different request')
                    return json.loads(cached['response_json'])
            result = self._apply_extra(db, tenant, identity, op, payload)
            if write:
                db.execute('INSERT INTO requests VALUES (?,?,?,?,?)',
                           (tenant, idem_key, op, request_sha, canonical(result)))
                db.execute('INSERT INTO audit(tenant_id,actor,operation,request_sha,recorded_at) VALUES (?,?,?,?,?)',
                           (tenant, actor, op, request_sha, self.clock()))
            return result

    def _owns_deal(self, db, tenant, deal_id):
        _identifier(deal_id, 'deal id')
        deal = db.execute('SELECT * FROM deals WHERE tenant_id=? AND id=?',
                          (tenant, deal_id)).fetchone()
        if deal is None:
            raise Invalid('deal not found for tenant')
        return deal

    def _apply_extra(self, db, tenant, identity, op, p):
        now = self.clock()
        if op == 'titan.session.get':
            _object(p, set())
            return {'tenant_id': tenant, 'actor': identity['actor'],
                    'role': identity['role'], 'environment': 'LOCAL_ONLY'}
        if op == 'commerce.crm.customers.list':
            _object(p, set())
            rows = db.execute('''SELECT c.id,c.name,c.contact,c.created_at,
                COALESCE(m.version,1) AS version
                FROM customers c LEFT JOIN crm_customer_meta m
                  ON m.tenant_id=c.tenant_id AND m.customer_id=c.id
                WHERE c.tenant_id=? ORDER BY c.created_at DESC,c.id DESC LIMIT 300''', (tenant,))
            return {'customers': [dict(x) for x in rows]}
        if op == 'commerce.crm.customers.update':
            _object(p, {'customer_id','expected_version'}, {'name','contact'})
            if not ('name' in p or 'contact' in p):
                raise Invalid('at least one customer field required')
            self._owns_customer(db, tenant, p['customer_id'])
            expected = _version(p['expected_version'])
            current = db.execute('''SELECT c.name,c.contact,COALESCE(m.version,1) AS version
                FROM customers c LEFT JOIN crm_customer_meta m
                ON c.tenant_id=m.tenant_id AND c.id=m.customer_id
                WHERE c.tenant_id=? AND c.id=?''', (tenant,p['customer_id'])).fetchone()
            if current['version'] != expected:
                raise Conflict('stale customer version')
            name = _text(p['name'], 'name') if 'name' in p else current['name']
            contact = _text(p['contact'], 'contact',200) if 'contact' in p else current['contact']
            db.execute('UPDATE customers SET name=?, contact=? WHERE tenant_id=? AND id=?',
                       (name,contact,tenant,p['customer_id']))
            db.execute('''INSERT INTO crm_customer_meta(tenant_id,customer_id,version,updated_at)
                VALUES (?,?,?,?) ON CONFLICT(tenant_id,customer_id)
                DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at''',
                       (tenant,p['customer_id'],expected+1,now))
            return {'id':p['customer_id'],'name':name,'contact':contact,'version':expected+1}
        if op == 'commerce.crm.deals.list':
            _object(p, set())
            rows = db.execute('''SELECT d.id,d.customer_id,d.title,d.amount_minor,d.stage,
                d.created_at,COALESCE(m.version,1) AS version,
                c.name AS customer_name FROM deals d
                JOIN customers c ON c.id=d.customer_id AND c.tenant_id=d.tenant_id
                LEFT JOIN crm_deal_meta m ON m.tenant_id=d.tenant_id AND m.deal_id=d.id
                WHERE d.tenant_id=? ORDER BY d.created_at DESC,d.id DESC LIMIT 300''',(tenant,))
            return {'deals':[dict(x) for x in rows], 'stages':sorted(STAGES)}
        if op == 'commerce.crm.deals.update':
            _object(p, {'deal_id','expected_version'}, {'title','amount_minor','stage'})
            if not any(key in p for key in ('title','amount_minor','stage')):
                raise Invalid('at least one deal field required')
            current = self._owns_deal(db,tenant,p['deal_id'])
            expected = _version(p['expected_version'])
            row = db.execute('SELECT version FROM crm_deal_meta WHERE tenant_id=? AND deal_id=?',
                             (tenant,p['deal_id'])).fetchone()
            actual = row['version'] if row else 1
            if actual != expected:
                raise Conflict('stale deal version')
            stage = current['stage']
            if 'stage' in p:
                if p['stage'] not in STAGES:
                    raise Invalid('invalid deal stage')
                if p['stage'] != stage and p['stage'] not in TRANSITIONS[stage]:
                    raise Conflict('deal stage transition not allowed')
                stage = p['stage']
            title = _text(p['title'],'title') if 'title' in p else current['title']
            amount = _amount(p['amount_minor']) if 'amount_minor' in p else current['amount_minor']
            db.execute('UPDATE deals SET title=?,amount_minor=?,stage=? WHERE tenant_id=? AND id=?',
                       (title,amount,stage,tenant,p['deal_id']))
            db.execute('''INSERT INTO crm_deal_meta(tenant_id,deal_id,version,updated_at)
                VALUES (?,?,?,?) ON CONFLICT(tenant_id,deal_id)
                DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at''',
                       (tenant,p['deal_id'],expected+1,now))
            return {'id':p['deal_id'],'title':title,'amount_minor':amount,
                    'stage':stage,'version':expected+1}
        if op == 'commerce.crm.activities.create':
            _object(p, {'customer_id','kind','details'}, {'deal_id','due_at'})
            self._owns_customer(db,tenant,p['customer_id'])
            kind = p['kind']
            if not isinstance(kind,str) or kind not in ACTIVITY_TYPES:
                raise Invalid('unsupported activity kind')
            deal_id = p.get('deal_id')
            if deal_id is not None:
                deal = self._owns_deal(db,tenant,deal_id)
                if deal['customer_id'] != p['customer_id']:
                    raise Invalid('deal does not belong to customer')
            due_at = p.get('due_at')
            if due_at is not None and (type(due_at) is not int or
                                      not now-86400*365 <= due_at <= now+86400*366):
                raise Invalid('invalid activity due_at')
            details = _text(p['details'],'details',800)
            value = {'id':_uid(),'customer_id':p['customer_id'],'deal_id':deal_id,
                     'kind':kind,'details':details,'due_at':due_at,'status':'open','version':1}
            db.execute('''INSERT INTO crm_activities(
              id,tenant_id,customer_id,deal_id,kind,details,due_at,status,version,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?)''',
                       (value['id'],tenant,p['customer_id'],deal_id,kind,details,due_at,'open',1,now))
            return value
        if op == 'commerce.crm.activities.list':
            _object(p,set(),{'customer_id','status'})
            sql = '''SELECT a.id,a.customer_id,a.deal_id,a.kind,a.details,
                a.due_at,a.status,a.version,a.created_at,a.completed_at,
                c.name AS customer_name FROM crm_activities a
                JOIN customers c ON c.id=a.customer_id AND c.tenant_id=a.tenant_id
                WHERE a.tenant_id=?'''
            params = [tenant]
            if 'customer_id' in p:
                self._owns_customer(db,tenant,p['customer_id'])
                sql += ' AND a.customer_id=?'
                params.append(p['customer_id'])
            if 'status' in p:
                if p['status'] not in ('open','done'):
                    raise Invalid('invalid activity status filter')
                sql += ' AND a.status=?'
                params.append(p['status'])
            sql += ' ORDER BY a.created_at DESC,a.id DESC LIMIT 300'
            return {'activities':[dict(x) for x in db.execute(sql,params)]}
        if op == 'commerce.crm.activities.complete':
            _object(p,{'activity_id','expected_version'})
            _identifier(p['activity_id'],'activity id')
            expected=_version(p['expected_version'])
            row=db.execute('SELECT status,version FROM crm_activities WHERE tenant_id=? AND id=?',
                           (tenant,p['activity_id'])).fetchone()
            if row is None:
                raise Invalid('activity not found for tenant')
            if row['version'] != expected:
                raise Conflict('stale activity version')
            if row['status'] != 'open':
                raise Conflict('activity already completed')
            db.execute('''UPDATE crm_activities SET status='done',version=?,completed_at=?
                WHERE tenant_id=? AND id=?''',(expected+1,now,tenant,p['activity_id']))
            return {'id':p['activity_id'],'status':'done','version':expected+1,
                    'completed_at':now}
        if op == 'commerce.crm.overview':
            _object(p,set())
            customer_count = db.execute('SELECT COUNT(*) FROM customers WHERE tenant_id=?',
                                        (tenant,)).fetchone()[0]
            rows = db.execute('SELECT stage,COUNT(*) AS cnt,COALESCE(SUM(amount_minor),0) AS amount\n'
                              ' FROM deals WHERE tenant_id=? GROUP BY stage',(tenant,))
            grouped = {r['stage']:{'count':r['cnt'],'amount_minor':r['amount']} for r in rows}
            return {
                'customers':customer_count,
                'deals':sum(v['count'] for v in grouped.values()),
                'pipeline':{stage:grouped.get(stage,{'count':0,'amount_minor':0})
                            for stage in ('new','qualified','proposal','won','lost')},
                'open_activities':db.execute('''SELECT COUNT(*) FROM crm_activities
                    WHERE tenant_id=? AND status='open' ''',(tenant,)).fetchone()[0],
                'overdue_activities':db.execute('''SELECT COUNT(*) FROM crm_activities
                    WHERE tenant_id=? AND status='open' AND due_at IS NOT NULL AND due_at<?''',
                    (tenant,now)).fetchone()[0],
                'bookings':db.execute('''SELECT COUNT(*) FROM bookings WHERE tenant_id=? AND state='confirmed' ''',
                    (tenant,)).fetchone()[0],
                'simulated':False,
            }
        raise Invalid('operation not implemented in M193')
