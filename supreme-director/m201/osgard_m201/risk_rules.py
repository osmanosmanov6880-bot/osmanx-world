"""M201 risk policy and deterministic portfolio risk evaluation.

No autonomous polling, messaging, payments or externally sourced balances.
All money is integer RUB kopecks and the opening balance is hypothetical.
"""
from __future__ import annotations

from osgard_m192.runtime import Invalid, _object
from osgard_m200.model import scenario, integer

RULES = (
    'CASH_GAP', 'BALANCE_FLOOR', 'OVERDUE_RECEIPTS',
    'UNSCHEDULED_COSTS', 'OVER_BUDGET_PROJECTS',
)
DEFAULT_POLICY = {
    'months': 6,
    'starting_balance_minor': 0,
    'collection_rate_bp': 10000,
    'cost_overrun_bp': 0,
    'min_balance_minor': 0,
    'max_overdue_inflow_minor': 0,
    'max_unscheduled_outflow_minor': 0,
    'max_overbudget_projects': 0,
    'project_state': None,
}
MAX_LIMIT = 1_000_000_000_000


def validate_policy(raw):
    if type(raw) is not dict:
        raise Invalid('policy config must be an object')
    _object(raw, set(), set(DEFAULT_POLICY))
    result = {**DEFAULT_POLICY, **raw}
    result['months'] = integer(result['months'], 'months', 1, 18)
    result['starting_balance_minor'] = integer(
        result['starting_balance_minor'], 'starting_balance_minor',
        -1_000_000_000_000_000, 1_000_000_000_000_000)
    result['collection_rate_bp'] = integer(
        result['collection_rate_bp'], 'collection_rate_bp', 0, 10000)
    result['cost_overrun_bp'] = integer(
        result['cost_overrun_bp'], 'cost_overrun_bp', 0, 10000)
    for key in ('min_balance_minor','max_overdue_inflow_minor',
                'max_unscheduled_outflow_minor'):
        result[key] = integer(result[key], key, 0, MAX_LIMIT)
    result['max_overbudget_projects'] = integer(
        result['max_overbudget_projects'], 'max_overbudget_projects', 0, 1000)
    if result['project_state'] is not None and (
        type(result['project_state']) is not str or
        result['project_state'] not in ('planned', 'active', 'completed', 'cancelled')
    ):
        raise Invalid('unknown project state filter')
    # Reuse exact scenario validation, so M200 and M201 never disagree.
    scenario({
        'starting_balance_minor': result['starting_balance_minor'],
        'collection_rate_bp': result['collection_rate_bp'],
        'cost_overrun_bp': result['cost_overrun_bp'],
    })
    return result


def evaluate_rules(forecast, overview, policy):
    """Return five exact snapshot records; alert lifecycle is managed separately."""
    missing = forecast['outside_horizon']
    metrics = (
        ('CASH_GAP', max(0, -forecast['lowest_balance_minor']), 0,
         'critical', 'Предполагаемый отрицательный остаток'),
        ('BALANCE_FLOOR', forecast['lowest_balance_minor'],
         policy['min_balance_minor'], 'high',
         'Остаток ниже минимального резерва'),
        ('OVERDUE_RECEIPTS', missing['overdue_inflow_minor'],
         policy['max_overdue_inflow_minor'], 'high',
         'Просроченные ожидаемые поступления'),
        ('UNSCHEDULED_COSTS', missing['undated_outflow_minor'],
         policy['max_unscheduled_outflow_minor'], 'high',
         'Плановые расходы без указанной даты'),
        ('OVER_BUDGET_PROJECTS', overview['totals']['over_budget_projects'],
         policy['max_overbudget_projects'], 'high',
         'Проекты с прогнозом превышения бюджета'),
    )
    items = []
    for rule, observed, threshold, severity, label in metrics:
        if rule == 'BALANCE_FLOOR':
            present = threshold > 0 and observed < threshold
        else:
            present = observed > threshold
        items.append({
            'rule': rule,
            'label': label,
            'present': bool(present),
            'severity': severity,
            'observed': observed,
            'threshold': threshold,
            'unit': 'count' if rule == 'OVER_BUDGET_PROJECTS' else 'kopecks',
            'first_gap_month': forecast['first_gap_month'] if rule in
               ('CASH_GAP','BALANCE_FLOOR') else None,
            'hypothetical': True,
        })
    return items
