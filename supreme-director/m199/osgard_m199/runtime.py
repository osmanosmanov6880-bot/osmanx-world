"""M199: local, tenant-scoped portfolio finance and deterministic cash calendar.

Read-only over M198's SQLite. Integer kopecks only. Cash receipts are manually
observed entries, not bank transactions. Pending receivables are forecasts.
"""
from __future__ import annotations

import csv
from collections import Counter, defaultdict
from datetime import datetime, timezone
from io import StringIO
import re

from osgard_m192.runtime import Invalid, Unauthorized, _object
from osgard_m198.runtime import Director198, _summary

OPS199 = frozenset({
    'commerce.portfolio.overview',
    'commerce.portfolio.calendar',
    'commerce.portfolio.export',
})
PROJECT_LIMIT = 1000  # Fail closed: avoid presenting misleading partial totals.
MONTH_MAX = 18
MAX_OUTPUT_MINOR = 9_000_000_000_000_000_000
VALID_STATES = frozenset({'planned', 'active', 'completed', 'cancelled'})
EXPECTED_KEYS = {'project_state', 'as_of'}


def _amount(total: int) -> int:
    if type(total) is not int or abs(total) > MAX_OUTPUT_MINOR:
        raise Invalid('aggregate money outside safe integer range')
    return total


def _epoch(value, name='as_of'):
    if type(value) is not int or not 946684800 <= value <= 4102444799:
        raise Invalid(f'{name} must be a UTC epoch second between 2000 and 2099')
    return value


def _time_month(value: int) -> str:
    return datetime.fromtimestamp(value, timezone.utc).strftime('%Y-%m')


def _month_list(as_of: int, months: int) -> list[str]:
    first = datetime.fromtimestamp(as_of, timezone.utc)
    value = first.year * 12 + (first.month - 1)
    return [f'{(value+i)//12:04d}-{(value+i)%12+1:02d}' for i in range(months)]


def _parameters(payload, now, *, calendar=False):
    if not isinstance(payload, dict):
        raise Invalid('portfolio payload must be a JSON object')
    _object(payload, set(), EXPECTED_KEYS | ({'months'} if calendar else set()))
    as_of = _epoch(payload.get('as_of', now))
    project_state = payload.get('project_state')
    if project_state is not None and (not isinstance(project_state, str) or project_state not in VALID_STATES):
        raise Invalid('unknown project_state')
    months = payload.get('months', 6) if calendar else None
    if calendar and (type(months) is not int or not 1 <= months <= MONTH_MAX):
        raise Invalid('months must be an integer from 1 to 18')
    return as_of, project_state, months


def _projects(db, identity, state):
    if identity['role'] == 'viewer':
        raise Unauthorized('portfolio finance forbidden to viewer')
    if identity['role'] not in ('owner', 'operator'):
        raise Unauthorized('portfolio finance requires owner or project creator')
    tenant = identity['tenant_id']
    statement = '''SELECT p.id,p.title,p.state,p.created_by,p.deal_id,p.customer_id,
       p.created_at,p.updated_at,c.name AS customer_name,
       d.title AS deal_title FROM delivery_projects p
       JOIN customers c ON c.tenant_id=p.tenant_id AND c.id=p.customer_id
       JOIN deals d ON d.tenant_id=p.tenant_id AND d.id=p.deal_id
       WHERE p.tenant_id=?'''
    bindings = [tenant]
    if identity['role'] == 'operator':
        statement += ' AND p.created_by=?'
        bindings.append(identity['actor'])
    if state is not None:
        statement += ' AND p.state=?'
        bindings.append(state)
    statement += ' ORDER BY p.created_at DESC,p.id DESC LIMIT ?'
    bindings.append(PROJECT_LIMIT + 1)
    entries = [dict(row) for row in db.execute(statement, bindings)]
    if len(entries) > PROJECT_LIMIT:
        raise Invalid('over 1000 accessible projects: refusing partial financial report')
    return entries


def _cash_rows(db, tenant, project_ids):
    """Use tenant and project predicates even after authorization checks."""
    for pid in project_ids:
        for row in db.execute('''SELECT state,amount_minor,due_at,resolved_at
            FROM delivery_finance_receivables
            WHERE tenant_id=? AND project_id=?''', (tenant, pid)):
            yield 'receivable', dict(row)
        for row in db.execute('''SELECT kind,state,amount_minor,updated_at
            FROM delivery_finance_expenses
            WHERE tenant_id=? AND project_id=?''', (tenant, pid)):
            yield 'expense', dict(row)


def _portfolio_overview(db, identity, entries, as_of):
    tenant = identity['tenant_id']
    cards = []
    totals = Counter()
    risks = Counter()
    budgets_known = 0
    for project in entries:
        summary = _summary(db, tenant, project['id'], as_of)
        if summary['budget_minor'] is not None:
            budgets_known += 1
            totals['budget_minor'] += summary['budget_minor']
        else:
            totals['projects_without_budget'] += 1
        for key in ('actual_cost_minor', 'planned_cost_minor', 'forecast_cost_minor',
                    'expected_receivables_minor', 'pending_receivables_minor',
                    'manually_recorded_receivables_minor', 'estimated_margin_minor'):
            totals[key] += summary[key]
        totals['overdue_receivables_count'] += summary['overdue_receivables_count']
        risks[summary['risk']] += 1
        cards.append({
            'project_id': project['id'], 'project_title': project['title'],
            'customer_name': project['customer_name'], 'deal_title': project['deal_title'],
            'state': project['state'], 'created_by': project['created_by'],
            'summary': summary,
        })
    for name, total in totals.items():
        if name.endswith('_minor'):
            _amount(total)
    for key in ('budget_minor', 'actual_cost_minor', 'planned_cost_minor',
                'forecast_cost_minor', 'expected_receivables_minor',
                'pending_receivables_minor', 'manually_recorded_receivables_minor',
                'estimated_margin_minor', 'overdue_receivables_count',
                'projects_without_budget'):
        totals.setdefault(key, 0)
    totals['project_count'] = len(entries)
    totals['projects_with_budget'] = budgets_known
    # Only the covered projects contribute to budget sum; variance across uncovered
    # projects would be misleading. Keep all-project expense forecast separate.
    totals['budget_coverage_percent'] = (budgets_known * 100 // len(entries)) if entries else None
    totals['forecast_net_receivables_less_cost_minor'] = _amount(
        totals['expected_receivables_minor'] - totals['forecast_cost_minor'])
    totals['over_budget_projects'] = risks['OVER_BUDGET']
    return {
        'schema': 'osgard.m199.portfolio-overview/1',
        'projects': cards, 'totals': dict(totals), 'risk_counts': dict(sorted(risks.items())),
        'as_of_utc': as_of, 'money_unit': 'kopecks', 'currency': 'RUB',
        'scope': 'TENANT_OWNER' if identity['role'] == 'owner' else 'OWN_CREATED_PROJECTS',
        'source': 'LOCAL_SQLITE_ONLY', 'external_bank_verified': False,
        'production_authorized': False, 'original_task_acceptance': 0,
        'warning': 'Forecasts and receipts are local manual observations, not verified bank cash flows.'
    }


def _cash_calendar(db, identity, entries, as_of, months):
    timeline = _month_list(as_of, months)
    rows = [{'month': month, 'pending_due_minor': 0,
             'manual_recorded_minor': 0, 'incurred_cost_minor': 0}
            for month in timeline]
    indexed = {month: row for month, row in zip(timeline, rows)}
    other = Counter()
    total = Counter()
    for kind, row in _cash_rows(db, identity['tenant_id'], [p['id'] for p in entries]):
        amount = row['amount_minor']
        _amount(amount)
        if kind == 'receivable':
            if row['state'] == 'cancelled':
                continue
            if row['state'] == 'pending':
                total['pending_minor'] += amount
                due = row['due_at']
                if due is None:
                    other['undated_pending_minor'] += amount
                elif due < as_of:
                    other['overdue_pending_minor'] += amount
                    other['overdue_pending_count'] += 1
                else:
                    month = _time_month(due)
                    if month in indexed:
                        indexed[month]['pending_due_minor'] += amount
                    else:
                        other['beyond_horizon_pending_minor'] += amount
            elif row['state'] == 'recorded':
                total['manual_recorded_minor'] += amount
                timestamp = row['resolved_at']
                if timestamp is None:
                    other['undated_recorded_minor'] += amount
                else:
                    month = _time_month(timestamp)
                    if month in indexed:
                        indexed[month]['manual_recorded_minor'] += amount
                    elif timestamp < as_of and month < timeline[0]:
                        other['before_horizon_recorded_minor'] += amount
                    else:
                        other['beyond_horizon_recorded_minor'] += amount
        elif row['state'] == 'active' and row['kind'] == 'incurred':
            total['incurred_minor'] += amount
            month = _time_month(row['updated_at'])
            if month in indexed:
                indexed[month]['incurred_cost_minor'] += amount
            elif month < timeline[0]:
                other['before_horizon_incurred_minor'] += amount
            else:
                other['beyond_horizon_incurred_minor'] += amount
        elif row['state'] == 'active' and row['kind'] == 'planned':
            total['planned_expense_without_due_date_minor'] += amount
    for key in ('pending_minor', 'manual_recorded_minor', 'incurred_minor',
                'planned_expense_without_due_date_minor'):
        total.setdefault(key, 0)
    for key in ('overdue_pending_minor', 'overdue_pending_count',
                'undated_pending_minor', 'beyond_horizon_pending_minor',
                'before_horizon_recorded_minor', 'beyond_horizon_recorded_minor',
                'undated_recorded_minor', 'before_horizon_incurred_minor',
                'beyond_horizon_incurred_minor'):
        other.setdefault(key, 0)
    # Ensure no future/older receivables silently disappear from the aggregate.
    for key, amount in {**other, **total}.items():
        if key.endswith('_minor'):
            _amount(amount)
    for row in rows:
        for key in ('pending_due_minor', 'manual_recorded_minor', 'incurred_cost_minor'):
            _amount(row[key])
    if sum(r['pending_due_minor'] for r in rows) + other['overdue_pending_minor'] + other['undated_pending_minor'] + other['beyond_horizon_pending_minor'] != total['pending_minor']:
        raise Invalid('internal cashflow pending reconciliation mismatch')
    if sum(r['manual_recorded_minor'] for r in rows) + other['undated_recorded_minor'] + other['before_horizon_recorded_minor'] + other['beyond_horizon_recorded_minor'] != total['manual_recorded_minor']:
        raise Invalid('internal recorded reconciliation mismatch')
    if sum(r['incurred_cost_minor'] for r in rows) + other['before_horizon_incurred_minor'] + other['beyond_horizon_incurred_minor'] != total['incurred_minor']:
        raise Invalid('internal incurred reconciliation mismatch')
    return {
        'schema': 'osgard.m199.local-cash-calendar/1',
        'as_of_utc': as_of, 'months': months, 'project_count': len(entries),
        'buckets': rows, 'outside_horizon': dict(other), 'totals': dict(total),
        'currency': 'RUB', 'money_unit': 'kopecks',
        'external_bank_verified': False, 'production_authorized': False,
        'forecast_is_bank_cash_flow': False,
        'warning': 'Pending due dates are forecasts; recorded receipts are manual; expenses do not have contractual due dates.'
    }


def _csv_cell(value):
    """Neutralize spreadsheet formula injection, including leading spaces/tabs."""
    text = str(value if value is not None else '')
    if text.lstrip().startswith(('=', '+', '-', '@', '\t', '\r', '\n')) or text.startswith(('\t', '\r', '\n')):
        text = "'" + text
    return text


def _portfolio_csv(report):
    buf = StringIO(newline='')
    writer = csv.writer(buf, lineterminator='\r\n')
    writer.writerow(['project_id', 'project_title', 'customer_name', 'state',
                     'budget_minor', 'actual_cost_minor', 'planned_cost_minor',
                     'forecast_cost_minor', 'expected_receivables_minor',
                     'pending_receivables_minor', 'manually_recorded_receivables_minor',
                     'overdue_receivables_count', 'risk'])
    for row in report['projects']:
        summary = row['summary']
        writer.writerow([_csv_cell(row['project_id']), _csv_cell(row['project_title']),
                         _csv_cell(row['customer_name']), _csv_cell(row['state']),
                         summary['budget_minor'] if summary['budget_minor'] is not None else '',
                         summary['actual_cost_minor'], summary['planned_cost_minor'],
                         summary['forecast_cost_minor'], summary['expected_receivables_minor'],
                         summary['pending_receivables_minor'],
                         summary['manually_recorded_receivables_minor'],
                         summary['overdue_receivables_count'], _csv_cell(summary['risk'])])
    return buf.getvalue()


class Director199(Director198):
    """Extends existing authenticated, tenant-isolated local finance system."""

    def execute(self, token, op, payload, idem_key=None):
        if op not in OPS199:
            return super().execute(token, op, payload, idem_key)
        now = self.clock()
        as_of, state, months = _parameters(payload, now, calendar=op == 'commerce.portfolio.calendar')
        if idem_key is not None:
            raise Invalid('read-only portfolio operations do not use idempotency keys')
        with self.connect(transaction=True) as db:
            identity = self._identity(db, token)
            entries = _projects(db, identity, state)
            if op == 'commerce.portfolio.calendar':
                return _cash_calendar(db, identity, entries, as_of, months)
            report = _portfolio_overview(db, identity, entries, as_of)
            if op == 'commerce.portfolio.export':
                return {'schema': 'osgard.m199.portfolio-export/1',
                        'file_name': 'OSGARD_PORTFOLIO_LOCAL.csv',
                        'csv_text': _portfolio_csv(report), 'row_count': len(entries),
                        'encoding': 'UTF-8', 'source': 'LOCAL_SQLITE_ONLY',
                        'external_bank_verified': False, 'production_authorized': False}
            return report
