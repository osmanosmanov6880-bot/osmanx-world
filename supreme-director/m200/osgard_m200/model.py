"""Pure deterministic M200 cash-gap arithmetic; no banking connections.

All values are *minor RUB units*, integer kopecks. Overdue, unscheduled and
post-horizon flows are reported separately, not silently assigned a fake date.
"""
from __future__ import annotations
from collections import Counter

from osgard_m192.runtime import Invalid, _object
from osgard_m199.runtime import _epoch, _month_list, _time_month

MAX_SAFE = 9_007_199_254_740_991
MAX_OPENING = 1_000_000_000_000_000
SCENARIO_FIELDS = {'label', 'starting_balance_minor', 'collection_rate_bp', 'cost_overrun_bp'}
PROJECT_STATES = {'planned', 'active', 'completed', 'cancelled'}


def integer(value, name, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise Invalid(f'{name} must be integer in [{minimum}, {maximum}]')
    return value


def safe_money(value):
    if type(value) is not int or abs(value) > MAX_SAFE:
        raise Invalid('money aggregate exceeds JavaScript-safe integer range')
    return value


def parameters(payload, now, compare=False):
    if not isinstance(payload, dict):
        raise Invalid('forecast request must be an object')
    allowed = {'as_of', 'months', 'project_state'} | (
        {'scenarios'} if compare else SCENARIO_FIELDS)
    _object(payload, {'scenarios'} if compare else set(), allowed)
    as_of = _epoch(payload.get('as_of', now))
    months = integer(payload.get('months', 6), 'months', 1, 18)
    state = payload.get('project_state')
    if state is not None and (type(state) is not str or state not in PROJECT_STATES):
        raise Invalid('invalid project_state')
    if compare:
        rows = payload['scenarios']
        if not isinstance(rows, list) or not 2 <= len(rows) <= 3:
            raise Invalid('comparison requires two or three scenarios')
        scenarios = [scenario(row, require_label=True) for row in rows]
        if len({r['label'] for r in scenarios}) != len(rows):
            raise Invalid('scenario labels must be distinct')
    else:
        scenarios = [scenario({k: v for k,v in payload.items()
                               if k in SCENARIO_FIELDS})]
    return as_of, months, state, scenarios


def scenario(raw, require_label=False):
    if not isinstance(raw, dict):
        raise Invalid('scenario must be an object')
    _object(raw, {'label'} if require_label else set(), SCENARIO_FIELDS)
    label = raw.get('label', 'Базовый')
    if type(label) is not str or not 1 <= len(label.strip()) <= 60:
        raise Invalid('scenario label must be 1..60 characters')
    return {
        'label': label.strip(),
        'starting_balance_minor': integer(
            raw.get('starting_balance_minor', 0), 'starting_balance_minor',
            -MAX_OPENING, MAX_OPENING),
        'collection_rate_bp': integer(
            raw.get('collection_rate_bp', 10000), 'collection_rate_bp', 0, 10000),
        'cost_overrun_bp': integer(
            raw.get('cost_overrun_bp', 0), 'cost_overrun_bp', 0, 10000),
    }


def _scaled(kopecks, basis_points):
    # Round to nearest kopeck, half up, without any float conversion.
    return safe_money((kopecks*basis_points + 5000)//10000)


def _cash_rows(db, tenant_id, project_ids):
    for pid in project_ids:
        for r in db.execute(
            """SELECT amount_minor,state,due_at FROM delivery_finance_receivables
               WHERE tenant_id=? AND project_id=?""", (tenant_id,pid)
        ):
            yield 'inflow', dict(r)
        for r in db.execute(
            """SELECT e.amount_minor,e.state,e.kind,s.due_at
               FROM delivery_finance_expenses e
               LEFT JOIN delivery_expense_schedule s
                 ON s.expense_id=e.id AND s.tenant_id=e.tenant_id
                AND s.project_id=e.project_id
               WHERE e.tenant_id=? AND e.project_id=?""", (tenant_id,pid)
        ):
            yield 'expense', dict(r)


def forecast(db, identity, projects, as_of, months, settings):
    months_utc = _month_list(as_of, months)
    buckets = [{'month':month, 'scheduled_inflow_minor':0,
                'expected_inflow_minor':0, 'scheduled_outflow_minor':0,
                'expected_outflow_minor':0, 'net_flow_minor':0,
                'closing_balance_minor':0,'cash_gap_minor':0}
               for month in months_utc]
    indexed = {r['month']:r for r in buckets}
    totals, outside = Counter(), Counter()
    for kind, r in _cash_rows(db, identity['tenant_id'], [p['id'] for p in projects]):
        value = safe_money(r['amount_minor'])
        if kind == 'inflow':
            if r['state'] == 'recorded':
                totals['historical_manual_receipts_minor'] += value
            elif r['state'] == 'pending':
                totals['pending_inflow_minor'] += value
                due = r['due_at']
                if due is None:
                    outside['undated_inflow_minor'] += value
                elif due < as_of:
                    outside['overdue_inflow_minor'] += value
                else:
                    m = _time_month(due)
                    if m in indexed:
                        indexed[m]['scheduled_inflow_minor'] += value
                    else:
                        outside['beyond_horizon_inflow_minor'] += value
        elif r['state'] == 'active' and r['kind'] == 'planned':
            totals['planned_outflow_minor'] += value
            due = r['due_at']
            if due is None:
                outside['undated_outflow_minor'] += value
            elif due < as_of:
                outside['overdue_outflow_minor'] += value
            else:
                m = _time_month(due)
                if m in indexed:
                    indexed[m]['scheduled_outflow_minor'] += value
                else:
                    outside['beyond_horizon_outflow_minor'] += value
        elif r['state'] == 'active' and r['kind'] == 'incurred':
            totals['already_incurred_minor'] += value
    # Exact reconciliation: amounts outside the horizon are not silently ignored.
    total_in = (sum(b['scheduled_inflow_minor'] for b in buckets)
                + outside['undated_inflow_minor'] + outside['overdue_inflow_minor']
                + outside['beyond_horizon_inflow_minor'])
    total_out = (sum(b['scheduled_outflow_minor'] for b in buckets)
                 + outside['undated_outflow_minor'] + outside['overdue_outflow_minor']
                 + outside['beyond_horizon_outflow_minor'])
    if total_in != totals['pending_inflow_minor'] or total_out != totals['planned_outflow_minor']:
        raise Invalid('cashflow reconciliation failed')
    balance = settings['starting_balance_minor']
    lowest = balance
    first_gap = None
    for b in buckets:
        b['expected_inflow_minor'] = _scaled(
            b['scheduled_inflow_minor'], settings['collection_rate_bp'])
        b['expected_outflow_minor'] = _scaled(
            b['scheduled_outflow_minor'], 10000+settings['cost_overrun_bp'])
        b['net_flow_minor'] = safe_money(
            b['expected_inflow_minor']-b['expected_outflow_minor'])
        balance = safe_money(balance + b['net_flow_minor'])
        b['closing_balance_minor'] = balance
        b['cash_gap_minor'] = max(0,-balance)
        if balance < 0 and first_gap is None:
            first_gap = b['month']
        lowest = min(lowest,balance)
    for value in list(totals.values())+list(outside.values()):
        safe_money(value)
    risk = ('MODELED_GAP' if first_gap else
            'INCOMPLETE_DATES' if outside['undated_outflow_minor'] else
            'OVERDUE_OUTSIDE_MODEL' if (
                outside['overdue_outflow_minor'] or outside['overdue_inflow_minor']
            ) else 'NO_GAP_IN_MODEL')
    for k in ('pending_inflow_minor','planned_outflow_minor',
              'historical_manual_receipts_minor','already_incurred_minor'):
        totals.setdefault(k,0)
    for k in ('undated_inflow_minor','undated_outflow_minor',
              'overdue_inflow_minor','overdue_outflow_minor',
              'beyond_horizon_inflow_minor','beyond_horizon_outflow_minor'):
        outside.setdefault(k,0)
    return {
        'schema':'osgard.m200.cashflow-forecast/1', 'scenario':settings,
        'as_of_utc':as_of, 'months':months,
        'project_count':len(projects), 'scope':(
            'TENANT_OWNER' if identity['role']=='owner' else 'OWN_CREATED_PROJECTS'
        ), 'currency':'RUB', 'money_unit':'kopecks',
        'buckets':buckets,'totals':dict(totals),
        'outside_horizon':dict(outside),
        'first_gap_month':first_gap, 'lowest_balance_minor':lowest,
        'ending_balance_minor':balance,'risk':risk,
        'complete_expense_schedule': outside['undated_outflow_minor']==0,
        'hypothetical_opening_balance':True, 'bank_verified':False,
        'real_payment_executed':False,'production_authorized':False,
        'original_tasks_independently_accepted':0,
        'warning':('Cash opening balance is a hypothetical input. '
                   'Future receipts are not bank-confirmed. '
                   'Undated and overdue flows are excluded from future buckets.')
    }
