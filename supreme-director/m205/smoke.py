"""M205 offline end-to-end: M198 source ↔ M204 cost, M205 recurring, M203 review."""
from pathlib import Path
import json
import tempfile
import uuid

from osgard_m205.runtime import Director205


NOW=1799971200


def main():
    now=[NOW]
    with tempfile.TemporaryDirectory(prefix="m205-smoke-") as folder:
        db=Path(folder)/"local.sqlite"
        app=Director205(db,clock=lambda:now[0])
        app.initialize()
        owner=app.provision("Synthetic Pilot","owner")["token"]
        worker=app.issue_token(owner,"staff","operator")["token"]

        def call(op,p=None,write=False,token=None):
            return app.execute(token or owner,op,p or {},
                "m205-e2e-"+uuid.uuid4().hex if write else None)

        client=call("commerce.customers.create",{
            "name":"Test Customer","contact":"local"},True)["id"]
        deal=call("commerce.deals.create",{
            "customer_id":client,"title":"Contract",
            "amount_minor":200000,"stage":"new"},True)["id"]
        project=call("commerce.projects.create",{
            "deal_id":deal,"title":"Delivery"},True)["id"]
        risk_expense=call("commerce.finance.expenses.add",{
            "project_id":project,"title":"Undated planned service",
            "category":"services","amount_minor":12000,
            "kind":"planned"},True)
        source_expense=call("commerce.finance.expenses.add",{
            "project_id":project,"title":"One-time incurred implementation cost",
            "category":"labor","amount_minor":100000,
            "kind":"incurred"},True)
        call("commerce.alerts.policy.set",{
            "expected_version":0,"config":{}},True)
        baseline=call("commerce.monitor.scan",{
            "expected_policy_version":1},True)["snapshot"]
        alert=call("commerce.alerts.list")["items"][0]
        assert alert["rule"]=="UNSCHEDULED_COSTS"
        plan=call("commerce.actions.create",{
            "alert_id":alert["id"],"expected_alert_version":alert["version"],
            "baseline_snapshot_id":baseline["id"],
            "title":"Fix missing dates",
            "hypothesis":"Removing undated project cost decreases model uncertainty",
            "target_value":0,"due_at":NOW+7200},True)
        p=plan["id"]
        task=call("commerce.actions.step.add",{
            "plan_id":p,"expected_version":1,
            "title":"Correct cost schedule",
            "description":"Verify proposed cost dates","assignee":"staff",
            "due_at":NOW+3600},True)
        call("commerce.actions.start",{
            "plan_id":p,"expected_version":2},True)
        economic=call("commerce.economics.entry.add",{
            "plan_id":p,"kind":"cost_incurred","amount_minor":100000,
            "title":"Implementation investment",
            "evidence_note":"Corresponds to project recorded one-off expense",
            "reference":"synthetic-local-impl-001"},True)
        call("commerce.economics.entry.add",{
            "plan_id":p,"kind":"benefit_forecast_monthly",
            "amount_minor":25000,"title":"Projected monthly improvement",
            "evidence_note":"Assumption based on synthetic internal pilot",
            "reference":"forecast-hypothesis-001"},True)
        inspection=call("commerce.reconcile.inspect",{"plan_id":p})
        assert inspection["basis"]["cost_incurred"]["unlinked_count"]==1
        assert any(g["economic_entry_id"]==economic["id"]
                   for g in inspection["candidate_groups"])
        linked=call("commerce.reconcile.link",{
            "plan_id":p,"economic_entry_id":economic["id"],
            "project_id":project,"expense_id":source_expense["id"],
            "expected_economic_version":1,"expected_expense_version":1
        },True)
        assert linked["counted_in_m204_only"]
        recurring=call("commerce.recurring.add",{
            "plan_id":p,"basis":"reported",
            "title":"Monthly hosting + support","amount_minor":5000,
            "start_month":1,"end_month":12,
            "evidence_note":"Local owner estimates ongoing monthly support costs",
            "reference":"support-contract-pilot-001"},True)
        net=call("commerce.economics.net_scenarios",{
            "plan_id":p,"cost_basis":"incurred",
            "recurring_basis":"reported","horizon_months":12,
            "realization_rates_bp":[5000,7500,10000],
            "require_reconciled_costs":True,
            "assume_zero_recurring":False})
        assert net["scenarios"][1]["projected_roi_bp"]==6500
        assert net["scenarios"][1]["payback_month"]==8
        assert net["scenarios"][1]["status"]=="PROJECTED_MANUAL_NET_ROI"
        assert net["m198_expenses_not_added_a_second_time"]
        call("titan.work.status",{
            "id":task["work_id"],"expected_version":1,
            "status":"done"},True,worker)
        call("commerce.finance.expenses.void",{
            "project_id":project,"expense_id":risk_expense["id"],
            "expected_version":1,"reason":"Plan corrected"},True)
        now[0]+=90
        observation=call("commerce.monitor.scan",{
            "expected_policy_version":1},True)["snapshot"]
        evaluation=call("commerce.actions.evaluate",{
            "plan_id":p,"expected_version":3,
            "outcome_snapshot_id":observation["id"]},True)
        assert evaluation["target_met"]
        reviewed=call("commerce.actions.review",{
            "plan_id":p,"expected_version":4,
            "evaluation_id":evaluation["evaluation_id"],"approved":True,
            "reason":"Only local modeled impact accepted, not bank-confirmed"
        },True)
        assert reviewed["status"]=="model_reviewed"
        portfolio=call("commerce.reconcile.portfolio")
        csv=call("commerce.reconcile.portfolio.csv")
        assert portfolio["plans_total"]==1
        assert portfolio["totals"]["active_links"]==1
        assert portfolio["totals"]["recurring_reported_total_12_minor"]==60000
        assert portfolio["items"][0]["cost_incurred_minor"]==100000
        assert csv["rows"]==1
        assert not portfolio["bank_verified"]
        print(json.dumps({
            "result":"M205_SMOKE_PASS",
            "source_match":"M198↔M204",
            "recurring_entries":1,
            "projected_mid_scenario_roi_bp":6500,
            "payback_month":8,
            "completed_m195_task":True,
            "accepted_m203_model_only":True,
            "bank_verified":False,
            "causation_proven":False,
            "no_double_count":True,
            "production_authorized":False,
        },ensure_ascii=False))


if __name__=="__main__":
    main()
