"""M204 forecast ROI scenarios, fail-closed evidence gates and explicit inputs.

Projected payback is calculated only from manual one-time investment and
manual recurring-monthly benefit. Self-reported one-off claims are separate.
"""
from __future__ import annotations

from osgard_m192.runtime import Invalid, _object
from .economics_ledger import ledger

DEFAULT_RATES=(3000,6000,10000)
MAX_ROI_ABS_BP=10**14


def integer(value,name,lo,hi):
    if type(value) is not int or not lo<=value<=hi:
        raise Invalid(f"{name} must be integer in [{lo},{hi}]")
    return value


def _roi(benefit,cost):
    # 10,000 bp = 100% return; negative returns are permitted.
    if cost<=0:
        return None
    return (benefit-cost)*10000//cost


def scenarios(db,tenant,p):
    _object(p,{"plan_id","cost_basis","horizon_months","realization_rates_bp"})
    basis=p["cost_basis"]
    if basis not in ("planned","incurred"):
        raise Invalid("cost_basis must be planned or incurred")
    horizon=integer(p["horizon_months"],"horizon_months",1,36)
    rates=p["realization_rates_bp"]
    if (type(rates) is not list or len(rates)!=3):
        raise Invalid("three explicit realization assumptions required")
    for value in rates:
        integer(value,"realization_rate_bp",0,10000)
    if not rates[0]<rates[1]<rates[2]:
        raise Invalid("scenario rates must increase strictly")
    record=ledger(db,tenant,p["plan_id"],limit=1)
    sums=record["totals_minor"]
    cost=sums["cost_planned" if basis=="planned" else "cost_incurred"]
    monthly=sums["benefit_forecast_monthly"]
    one_off=sums["benefit_reported_once"]
    projection=[]
    for rate in rates:
        assumed_monthly=monthly*rate//10000
        modeled_benefit=assumed_monthly*horizon
        if cost==0:
            status="MISSING_SELECTED_COST_BASIS"
            roi=None
            payback=None
        elif monthly==0:
            status="NO_MONTHLY_BENEFIT_FORECAST"
            roi=None
            payback=None
        else:
            status="PROJECTED_FROM_MANUAL_INPUTS"
            roi=_roi(modeled_benefit,cost)
            payback=(cost+assumed_monthly-1)//assumed_monthly if assumed_monthly>0 else None
        projection.append({
            "realization_rate_bp":rate,
            "status":status,
            "investment_minor":cost,
            "assumed_monthly_benefit_minor":assumed_monthly,
            "projected_benefit_horizon_minor":modeled_benefit if status=="PROJECTED_FROM_MANUAL_INPUTS" else None,
            "projected_roi_bp":roi,
            "projected_payback_months":payback,
            "payback_within_horizon":payback is not None and payback<=horizon,
            "causation_proven":False,
        })
    actual_cost=sums["cost_incurred"]
    if actual_cost and one_off:
        claimed_return={
            "status":"UNVERIFIED_SELF_REPORTED_RETURN",
            "cost_minor":actual_cost,
            "one_off_benefit_minor":one_off,
            "claimed_roi_bp":_roi(one_off,actual_cost),
            "bank_verified":False,
            "independently_audited":False,
        }
    else:
        claimed_return={
            "status":"INSUFFICIENT_REPORTED_COST_OR_BENEFIT",
            "cost_minor":actual_cost if actual_cost else None,
            "one_off_benefit_minor":one_off if one_off else None,
            "claimed_roi_bp":None,"bank_verified":False,
            "independently_audited":False,
        }
    return {
        "plan_id":p["plan_id"],"horizon_months":horizon,
        "cost_basis":basis,"projected_scenarios":projection,
        "self_reported_return":claimed_return,
        "source_totals_minor":sums,"currency":"RUB",
        "money_unit":"kopecks",
        "assumptions_are_manual":True,
        "benefit_realization_rates_user_supplied":True,
        "cost_bases_not_combined":True,
        "forecast_and_self_reported_benefits_not_combined":True,
        "recurring_operating_costs_not_modeled":True,
        "financial_outcome_proven":False,"bank_verified":False,
        "warnings":[
            "Manual projected monthly benefit is not verified revenue.",
            "Payback assumes stable monthly benefit and one-time cost only.",
            "Operating expenses or seasonal variation are not modeled unless separately reflected in inputs.",
            "Self-reported one-off benefits are not bank-verified and not causal proof.",
            "No ROI is computed for a missing cost basis or missing forecast.",
        ],
    }
