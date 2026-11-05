"""M206 synthetic proof: source conflict scan -> remediation -> frozen forecast.

No external bank, payments, email, or financial performance confirmation.
"""
from pathlib import Path
import json
import tempfile
import uuid

from osgard_m206.runtime import Director206
from osgard_m206.journal import digest

NOW=1799971200


def main():
    now=[NOW]
    with tempfile.TemporaryDirectory(prefix="m206-smoke-") as folder:
        app=Director206(Path(folder)/"local.sqlite",clock=lambda:now[0])
        app.initialize()
        owner=app.provision("Synthetic Assurance Pilot","boss")["token"]
        staff=app.issue_token(owner,"staff","operator")["token"]
        def call(op,p=None,write=False,token=None):
            return app.execute(token or owner,op,p or {},
                "m206-synthetic-"+uuid.uuid4().hex if write else None)
        customer=call("commerce.customers.create",{
            "name":"Synthetic Client","contact":"local"},True)["id"]
        deal=call("commerce.deals.create",{
            "customer_id":customer,"title":"Synthetic Contract",
            "amount_minor":200000,"stage":"new"},True)["id"]
        project=call("commerce.projects.create",{
            "deal_id":deal,"title":"Delivery"},True)["id"]
        expense=call("commerce.finance.expenses.add",{
            "project_id":project,"title":"Implementation one-time cost",
            "kind":"incurred","category":"services",
            "amount_minor":100000},True)
        problem=call("commerce.finance.expenses.add",{
            "project_id":project,"title":"Undated extra cost",
            "kind":"planned","category":"services",
            "amount_minor":12000},True)
        call("commerce.alerts.policy.set",{
            "expected_version":0,"config":{}},True)
        base=call("commerce.monitor.scan",{
            "expected_policy_version":1},True)["snapshot"]
        risk=call("commerce.alerts.list")["items"][0]
        plan=call("commerce.actions.create",{
            "alert_id":risk["id"],"expected_alert_version":risk["version"],
            "baseline_snapshot_id":base["id"],
            "title":"=2+2 local source review",
            "hypothesis":"Correct undated risk costs under a local model",
            "target_value":0,"due_at":NOW+7200},True)
        pid=plan["id"]
        scan_before=call("commerce.assurance.scan",{"plan_id":pid},True)
        assert any(f["code"]=="NO_ONE_TIME_COST_BASIS"
                   for f in scan_before["snapshot"]["findings"])
        finding=scan_before["snapshot"]["findings"][0]
        ack=call("commerce.assurance.acknowledge",{
            "plan_id":pid,"scan_id":scan_before["scan_id"],
            "finding_id":finding["id"],
            "reason":"Owner reviewed the missing input and will supply records"
        },True)
        assert ack["status"]=="ACKNOWLEDGED_NOT_RESOLVED"
        cost=call("commerce.economics.entry.add",{
            "plan_id":pid,"kind":"cost_incurred",
            "amount_minor":100000,"title":"Implementation capital",
            "reference":"synthetic-expense-001",
            "evidence_note":"Manually documented implementation cost for scenario"
        },True)
        call("commerce.economics.entry.add",{
            "plan_id":pid,"kind":"benefit_forecast_monthly",
            "amount_minor":25000,
            "title":"Projected monthly model benefit",
            "reference":"synthetic-monthly-hypothesis",
            "evidence_note":"Explicit owner projection without external verification"
        },True)
        call("commerce.reconcile.link",{
            "plan_id":pid,"economic_entry_id":cost["id"],
            "project_id":project,"expense_id":expense["id"],
            "expected_economic_version":1,
            "expected_expense_version":1
        },True)
        call("commerce.recurring.add",{
            "plan_id":pid,"basis":"planned",
            "title":"Monthly operating service",
            "amount_minor":5000,"start_month":1,"end_month":12,
            "reference":"monthly-support-contract",
            "evidence_note":"Synthetic ongoing support assumption from owner"
        },True)
        scan_after=call("commerce.assurance.scan",{"plan_id":pid},True)
        codes={f["code"] for f in scan_after["snapshot"]["findings"]}
        assert "NO_ONE_TIME_COST_BASIS" not in codes
        assert "NO_MONTHLY_BENEFIT_FORECAST" not in codes
        assert "RECURRING_SOURCE_UNKNOWN" not in codes
        assert "UNLINKED_MANUAL_COST" not in codes
        latest=call("commerce.assurance.latest",{"plan_id":pid})
        assert latest["scan_id"]==scan_after["scan_id"]
        assert not latest["acknowledged_finding_ids"]
        baseline=call("commerce.forecast.freeze",{
            "plan_id":pid,"cost_basis":"incurred","recurring_basis":"planned",
            "horizon_months":12,"realization_rates_bp":[5000,7500,10000],
            "scenario_index":2,"require_reconciled_costs":True,
            "assume_zero_recurring":False,
            "rationale":"Recorded before synthetic monthly observation"
        },True)
        frozen_id=baseline["baseline_id"]
        assert baseline["forecast_snapshot"]["months"][0]["projected_net_before_investment_minor"]==20000
        call("commerce.forecast.observation.add",{
            "baseline_id":frozen_id,"month_index":1,
            "reported_gross_minor":22000,
            "reported_operating_minor":5000,
            "reference":"synthetic-month-one-report",
            "evidence_note":"Manual owner statement, no bank or invoice audit"
        },True)
        measured=call("commerce.forecast.backtest",{
            "baseline_id":frozen_id})
        assert measured["observed_months"]==1
        assert measured["mean_absolute_error_minor"]==3000
        assert measured["mean_signed_error_minor"]==-3000
        assert measured["coverage_bp"]==833
        assert not measured["bank_verified"]
        task=call("commerce.actions.step.add",{
            "plan_id":pid,"expected_version":1,
            "title":"Review financial cost schedule",
            "description":"Check the undated cost and correct model",
            "assignee":"staff","due_at":NOW+1800},True)
        call("commerce.actions.start",{
            "plan_id":pid,"expected_version":2},True)
        call("titan.work.status",{
            "id":task["work_id"],"expected_version":1,
            "status":"done"},True,staff)
        call("commerce.finance.expenses.void",{
            "project_id":project,"expense_id":problem["id"],
            "expected_version":1,"reason":"Removed undated planned expense"
        },True)
        now[0]+=90
        observed=call("commerce.monitor.scan",{
            "expected_policy_version":1},True)["snapshot"]
        evaluated=call("commerce.actions.evaluate",{
            "plan_id":pid,"expected_version":3,
            "outcome_snapshot_id":observed["id"]},True)
        assert evaluated["target_met"]
        accepted=call("commerce.actions.review",{
            "plan_id":pid,"expected_version":4,
            "evaluation_id":evaluated["evaluation_id"],
            "approved":True,
            "reason":"Only local model result accepted; bank validation absent"
        },True)
        assert accepted["status"]=="model_reviewed"
        packet=call("commerce.assurance.packet",{"plan_id":pid})
        assert packet["sha256"]==digest(packet["packet"])
        assert len(packet["packet"]["manual_outcome_reviews"])==1
        assert not packet["bank_verified"]
        csv=call("commerce.assurance.portfolio.csv")
        assert csv["rows"]==1
        assert "'=2+2 local source review" in csv["content"]
        print(json.dumps({
            "result":"M206_SMOKE_PASS",
            "diagnostics_before":len(scan_before["snapshot"]["findings"]),
            "diagnostics_after":len(scan_after["snapshot"]["findings"]),
            "acknowledgement_not_resolution":True,
            "frozen_forecast_not_mutated":True,
            "manual_observation_months":1,
            "manual_model_mae_minor":3000,
            "model_only_M203_reviewed":True,
            "packet_sha256_valid":True,
            "bank_verified":False,
            "causation_proven":False,
            "production_authorized":False,
        },ensure_ascii=False))


if __name__=="__main__":
    main()
