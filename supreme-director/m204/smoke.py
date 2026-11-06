"""Synthetic M204 end-to-end: plan -> economic ledger -> model review -> ROI."""
from pathlib import Path
import json
import tempfile
import uuid

from osgard_m204.runtime import Director204


NOW=1799971200


def main():
    now=[NOW]
    with tempfile.TemporaryDirectory(prefix="m204-smoke-") as folder:
        app=Director204(Path(folder)/"local.sqlite",clock=lambda:now[0])
        app.initialize()
        owner=app.provision("Synthetic Company","owner")["token"]
        employee=app.issue_token(owner,"analyst","operator")["token"]
        def run(op,p=None,write=False,token=None):
            return app.execute(token or owner,op,p or {},
                "m204-e2e-"+uuid.uuid4().hex if write else None)
        customer=run("commerce.customers.create",{
            "name":"Synthetic Customer","contact":"none"},True)["id"]
        deal=run("commerce.deals.create",{
            "customer_id":customer,"title":"Contract",
            "amount_minor":150000,"stage":"new"},True)["id"]
        project=run("commerce.projects.create",{
            "deal_id":deal,"title":"Delivery"},True)["id"]
        expense=run("commerce.finance.expenses.add",{
            "project_id":project,"title":"Undated planned costs",
            "category":"services","amount_minor":70000,
            "kind":"planned"},True)
        run("commerce.alerts.policy.set",{
            "expected_version":0,"config":{}},True)
        base=run("commerce.monitor.scan",{
            "expected_policy_version":1},True)["snapshot"]
        alert=run("commerce.alerts.list")["items"][0]
        plan=run("commerce.actions.create",{
            "alert_id":alert["id"],"expected_alert_version":alert["version"],
            "baseline_snapshot_id":base["id"],
            "title":"Устранение недатированных затрат",
            "hypothesis":"Уточнение сроков повысит определённость локального прогноза",
            "target_value":0,"due_at":NOW+6000},True)
        plan_id=plan["id"]
        task=run("commerce.actions.step.add",{
            "plan_id":plan_id,"expected_version":1,
            "title":"Проверить график","description":"Уточнить сроки расходов",
            "assignee":"analyst","due_at":NOW+3000},True)
        run("commerce.actions.start",{
            "plan_id":plan_id,"expected_version":2},True)
        def economic(kind,amount,reference=None,evaluation=None):
            body={"plan_id":plan_id,"kind":kind,"amount_minor":amount,
                  "title":"Экономическое допущение",
                  "evidence_note":"Ручная оценка без банковской сверки"}
            if reference is not None:body["reference"]=reference
            if evaluation is not None:body["evaluation_id"]=evaluation
            return run("commerce.economics.entry.add",body,True)
        economic("cost_planned",100000)
        economic("cost_incurred",95000,reference="local-receipt-01")
        economic("benefit_forecast_monthly",20000)
        priority=run("commerce.economics.priority.set",{
            "plan_id":plan_id,"expected_version":0,
            "urgency":5,"impact":4,"effort":2,"confidence":3,
            "rationale":"Высокий локальный риск и доступный исполнитель"},True)
        projected=run("commerce.economics.scenarios",{
            "plan_id":plan_id,"cost_basis":"planned",
            "horizon_months":12,
            "realization_rates_bp":[5000,7500,10000]})
        assert projected["projected_scenarios"][0]["projected_roi_bp"]==2000
        assert projected["projected_scenarios"][0]["projected_payback_months"]==10
        assert priority["score_x100"]==3000
        run("titan.work.status",{
            "id":task["work_id"],"expected_version":1,"status":"done"
        },True,employee)
        run("commerce.finance.expenses.void",{
            "project_id":project,"expense_id":expense["id"],
            "expected_version":1,"reason":"Plan corrected"},True)
        now[0]+=60
        outcome=run("commerce.monitor.scan",{
            "expected_policy_version":1},True)["snapshot"]
        evaluated=run("commerce.actions.evaluate",{
            "plan_id":plan_id,"expected_version":3,
            "outcome_snapshot_id":outcome["id"]},True)
        run("commerce.actions.review",{
            "plan_id":plan_id,"expected_version":4,
            "evaluation_id":evaluated["evaluation_id"],
            "approved":True,
            "reason":"Модельный результат подтверждён без банковской сверки"
        },True)
        economic("benefit_reported_once",50000,
            reference="self-reported-claim-01",evaluation=evaluated["evaluation_id"])
        result=run("commerce.economics.scenarios",{
            "plan_id":plan_id,"cost_basis":"incurred",
            "horizon_months":12,"realization_rates_bp":[5000,7500,10000]})
        claim=result["self_reported_return"]
        assert claim["status"]=="UNVERIFIED_SELF_REPORTED_RETURN"
        assert claim["claimed_roi_bp"]<0
        assert not claim["bank_verified"]
        ledger=run("commerce.economics.ledger",{"plan_id":plan_id})
        assert ledger["integrity"]["hash_verified"]
        assert ledger["totals_minor"]["cost_planned"]==100000
        board=run("commerce.economics.priority.board",{
            "limit":10,"include_closed":True})
        assert board["items"][0]["rank"]==1
        report=run("commerce.economics.portfolio")
        csv=run("commerce.economics.portfolio.csv")
        assert report["plans_total"]==1 and csv["rows"]==1
        assert not report["bank_verified"]
        print(json.dumps({
            "result":"M204_SMOKE_PASS",
            "financial_entries":ledger["total"],
            "projected_roi_at_50_percent_bp":2000,
            "reported_roi_negative":True,
            "priority_rank":1,
            "reviewed_m203_model_only":True,
            "bank_verified":False,
            "causation_proven":False,
            "external_messages":False,
            "production_authorized":False
        },ensure_ascii=False))


if __name__=="__main__":
    main()
