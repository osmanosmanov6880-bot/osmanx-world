"""End-to-end M203 proof: observed risk -> real team task -> snapshots -> review."""
from pathlib import Path
import json
import tempfile
import uuid

from osgard_m203.runtime import Director203

NOW=1799971200


def main():
    now=[NOW]
    with tempfile.TemporaryDirectory(prefix="m203-smoke-") as folder:
        app=Director203(Path(folder)/"local.sqlite",clock=lambda:now[0])
        app.initialize()
        token=app.provision("Synthetic Company","owner")["token"]
        staff=app.issue_token(token,"analyst","operator")["token"]

        def run(op,p=None,write=False,who=None):
            return app.execute(who or token,op,p or {},
                "m203-demo-"+uuid.uuid4().hex if write else None)

        c=run("commerce.customers.create",
              {"name":"Client","contact":"none"},True)["id"]
        d=run("commerce.deals.create",{
            "customer_id":c,"title":"Contract",
            "amount_minor":100000,"stage":"new"},True)["id"]
        project=run("commerce.projects.create",
            {"deal_id":d,"title":"Delivery"},True)["id"]
        expense=run("commerce.finance.expenses.add",{
            "project_id":project,"title":"Unscheduled work",
            "kind":"planned","category":"services",
            "amount_minor":70000},True)
        run("commerce.alerts.policy.set",{
            "expected_version":0,"config":{}},True)
        snapshot=run("commerce.monitor.scan",{
            "expected_policy_version":1},True)["snapshot"]
        alert=run("commerce.alerts.list")["items"][0]
        assert alert["rule"]=="UNSCHEDULED_COSTS"
        plan=run("commerce.actions.create",{
            "alert_id":alert["id"],"expected_alert_version":alert["version"],
            "baseline_snapshot_id":snapshot["id"],
            "title":"Уточнить сроки","hypothesis":"Проверить гипотезу об уменьшении недатированных расходов",
            "target_value":0,"due_at":NOW+7200},True)
        step=run("commerce.actions.step.add",{
            "plan_id":plan["id"],"expected_version":1,
            "title":"Проверить сроки","description":"Сверить плановые расходы",
            "assignee":"analyst","due_at":NOW+1800},True)
        assigned=run("commerce.actions.mine",who=staff)
        assert len(assigned["items"])==1
        assert assigned["financial_metrics_redacted"]
        run("commerce.actions.start",{
            "plan_id":plan["id"],"expected_version":2},True)
        run("titan.work.status",{
            "id":step["work_id"],"expected_version":1,
            "status":"done"},True,staff)
        run("commerce.finance.expenses.void",{
            "project_id":project,"expense_id":expense["id"],
            "expected_version":1,"reason":"No longer planned"},True)
        now[0]+=120
        latest=run("commerce.monitor.scan",{
            "expected_policy_version":1},True)["snapshot"]
        result=run("commerce.actions.evaluate",{
            "plan_id":plan["id"],"expected_version":3,
            "outcome_snapshot_id":latest["id"]},True)
        assert result["target_met"]
        assert result["tasks_done"]==1
        assert result["improvement_value"]==70000
        assert not result["causation_proven"]
        reviewed=run("commerce.actions.review",{
            "plan_id":plan["id"],"expected_version":4,
            "evaluation_id":result["evaluation_id"],"approved":True,
            "reason":"Сравнение модели подтверждено владельцем, не банком"},True)
        report=run("commerce.actions.report")
        csv=run("commerce.actions.report.csv")
        history=run("commerce.actions.history",{"plan_id":plan["id"]})
        assert reviewed["status"]=="model_reviewed"
        assert report["model_reviewed_count"]==1
        assert report["task_completed_count"]==1
        assert report["financial_outcome_proven"] is False
        assert csv["rows"]==1
        assert history["total"]==5
        assert reviewed["bank_verified"] is False
        print(json.dumps({
            "result":"M203_SMOKE_PASS","tasks_done":1,
            "observed_model_improvement_minor":result["improvement_value"],
            "reviewed_model_only":True,"local_event_count":history["total"],
            "bank_verified":False,"causation_proven":False,
            "external_notifications":False,
            "production_authorized":False
        },ensure_ascii=False))


if __name__=="__main__":
    main()
