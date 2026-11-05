"""M205 net ROI: explicit ongoing expenses, M198 matching and sensitivity.

All scenarios are owner-entered hypotheses. No double inclusion of M198
expenses (M198 is only evidence), no silent zero for missing recurring costs.
"""
from __future__ import annotations

from osgard_m192.runtime import Invalid, _object
from osgard_m204.economics_ledger import ledger
from osgard_m204.economics_roi import integer, _roi
from .reconciliation import inspect
from .recurring import calendar

MAX_SAFE_JS=(1<<53)-1


def _safe(num,label):
    if not -MAX_SAFE_JS<=num<=MAX_SAFE_JS:
        raise Invalid(label+" exceeds precise JSON integer range")
    return num


def _configured(p):
    _object(p,{
        "plan_id","cost_basis","recurring_basis","horizon_months",
        "realization_rates_bp","require_reconciled_costs",
        "assume_zero_recurring"
    })
    basis=p["cost_basis"]
    if basis not in ("planned","incurred"):
        raise Invalid("cost_basis must be planned or incurred")
    recurring_basis=p["recurring_basis"]
    if recurring_basis not in ("planned","reported"):
        raise Invalid("recurring_basis must be planned or reported")
    months=integer(p["horizon_months"],"horizon_months",1,36)
    rates=p["realization_rates_bp"]
    if type(rates) is not list or len(rates)!=3:
        raise Invalid("exactly 3 owner-supplied realization rates required")
    for rate in rates:
        integer(rate,"realization_rate_bp",0,10000)
    if not rates[0]<rates[1]<rates[2]:
        raise Invalid("scenario rates must increase strictly")
    for field in ("require_reconciled_costs","assume_zero_recurring"):
        if type(p[field]) is not bool:
            raise Invalid(field+" must be boolean")
    return basis,recurring_basis,months,rates


def calculate(db,tenant,p):
    basis,recurring_basis,months,rates=_configured(p)
    plan_id=p["plan_id"]
    entry_data=ledger(db,tenant,plan_id,limit=1)
    reconciliation=inspect(db,tenant,plan_id,limit=1)
    recurring=calendar(db,tenant,plan_id,recurring_basis,months)
    if recurring["active_records"] and p["assume_zero_recurring"]:
        raise Invalid("zero recurring assumption conflicts with saved monthly costs")
    sums=entry_data["totals_minor"]
    kind="cost_planned" if basis=="planned" else "cost_incurred"
    cost=sums[kind]
    monthly=sums["benefit_forecast_monthly"]
    matching=reconciliation["basis"][kind]
    status=None
    if matching["stale_link_count"]:
        status="SOURCE_LINK_DRIFT_REQUIRES_REVIEW"
    elif p["require_reconciled_costs"] and (
        matching["unlinked_count"]>0 or not matching["complete"]
    ):
        status="COST_RECONCILIATION_INCOMPLETE"
    elif cost==0:
        status="MISSING_ONE_OFF_COST_BASIS"
    elif monthly==0:
        status="MISSING_MONTHLY_BENEFIT_FORECAST"
    elif not recurring["active_records"] and not p["assume_zero_recurring"]:
        status="MISSING_RECURRING_COST_ASSUMPTION"
    forecasts=[]
    for rate in rates:
        assumed_monthly=monthly*rate//10000
        if status:
            forecasts.append({
                "rate_bp":rate,"status":status,
                "projected_roi_bp":None,"payback_month":None,
                "sustained_payback_month":None,
                "net_end_minor":None,"months":[],
            })
            continue
        history=[]
        cumulative=-cost
        earliest=None
        trajectory=[]
        for month,operating_minor in enumerate(recurring["per_month_minor"],1):
            monthly_net=assumed_monthly-operating_minor
            cumulative+=monthly_net
            _safe(cumulative,"cumulative result")
            _safe(monthly_net,"monthly net")
            if earliest is None and cumulative>=0:
                earliest=month
            trajectory.append(cumulative)
            history.append({
                "month":month,
                "projected_gross_benefit_minor":assumed_monthly,
                "operating_cost_minor":operating_minor,
                "projected_net_before_investment_minor":monthly_net,
                "cumulative_after_investment_minor":cumulative,
            })
        stable=None
        # Earliest month after which the remaining observed horizon never
        # dips below break-even, even if earlier cashflow crossed zero.
        for i,value in enumerate(trajectory):
            if value>=0 and min(trajectory[i:])>=0:
                stable=i+1
                break
        forecasts.append({
            "rate_bp":rate,"status":"PROJECTED_MANUAL_NET_ROI",
            "projected_roi_bp":_roi(cumulative+cost,cost),
            "payback_month":earliest,
            "sustained_payback_month":stable,
            "payback_within_horizon":earliest is not None,
            "net_end_minor":cumulative,
            "months":history,
            "bank_verified":False,"causation_proven":False,
        })
    return {
        "schema":"osgard.m205.net-roi/1",
        "plan_id":plan_id,"horizon_months":months,
        "cost_basis":basis,"recurring_basis":recurring_basis,
        "one_off_cost_minor":cost,
        "monthly_benefit_forecast_minor":monthly,
        "source_cost_linked_valid_count":matching["linked_valid_count"],
        "source_cost_unlinked_count":matching["unlinked_count"],
        "source_cost_drift_count":matching["stale_link_count"],
        "source_cost_completely_reconciled":matching["complete"],
        "require_reconciled_costs":p["require_reconciled_costs"],
        "zero_recurring_explicitly_assumed":p["assume_zero_recurring"],
        "recurring_entries":recurring["active_records"],
        "recurring_costs_by_month_minor":recurring["per_month_minor"],
        "scenarios":forecasts,
        "unverified_one_off_benefit_minor":sums["benefit_reported_once"],
        "self_reported_one_off_benefit_excluded_from_forecasts":True,
        "m198_expenses_not_added_a_second_time":True,
        "all_inputs_manual":True,
        "money_unit":"kopecks","currency":"RUB",
        "bank_verified":False,"causation_proven":False,
        "financial_outcome_proven":False,
        "production_authorized":False,
        "warnings":[
            "Reconciliation compares two local data records, not external bank evidence.",
            "Recurring monthly costs must be entered or zero explicitly assumed for this calculation.",
            "Months are numbered relative to a hypothetical implementation start, not a bank calendar.",
            "ROI uses one-time investment as denominator and deducts modeled recurring operating costs.",
            "Does not model taxes, financing, depreciation, inflation, cash collection timing or attribution.",
            "All input projections are hypothetical; no verified financial results.",
        ],
    }
