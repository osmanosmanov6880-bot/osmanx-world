"""Offline M202 full flow: timed scan, history, SLA, task, report and CSV."""
from pathlib import Path
import json
import tempfile
import uuid
from osgard_m202.runtime import Director202

NOW=1799971200


def main():
    now=[NOW]
    with tempfile.TemporaryDirectory(prefix="m202-smoke-") as folder:
        app=Director202(Path(folder)/"demo.sqlite",clock=lambda:now[0])
        app.initialize()
        owner=app.provision("Test Company","owner")["token"]
        worker=app.issue_token(owner,"staff","operator")["token"]
        def call(op,p=None,write=False,token=None):
            return app.execute(token or owner,op,p or {},
                "m202-smoke-"+uuid.uuid4().hex if write else None)
        customer=call("commerce.customers.create",
                      {"name":"Test Customer","contact":"local"},True)["id"]
        deal=call("commerce.deals.create",{
            "customer_id":customer,"title":"Test Contract",
            "amount_minor":100000,"stage":"new"},True)["id"]
        project=call("commerce.projects.create",
            {"deal_id":deal,"title":"Synthetic Delivery"},True)["id"]
        expense=call("commerce.finance.expenses.add",{
            "project_id":project,"title":"Undated cost",
            "category":"services","kind":"planned","amount_minor":50000},True)
        call("commerce.alerts.policy.set",{"expected_version":0,"config":{}},True)
        schedule=call("commerce.monitor.schedule.set",{
            "expected_version":0,"enabled":True,
            "interval_seconds":3600,"ack_sla_seconds":1800,
            "resolve_sla_seconds":7200},True)
        assert call("commerce.monitor.schedule.run_due",
            {"expected_schedule_version":schedule["version"]},True)["status"]=="NOT_DUE"
        now[0]+=3600
        result=call("commerce.monitor.schedule.run_due",
            {"expected_schedule_version":schedule["version"]},True)
        assert result["ran"] and result["snapshot"]["active_rule_count"]==1
        alert=call("commerce.alerts.list")["items"][0]
        task=call("commerce.alerts.task.create",{
            "alert_id":alert["id"],"expected_version":alert["version"],
            "assignee":"staff","due_at":now[0]+60},True)
        assert call("titan.work.get",{"id":task["work_id"]},token=worker)["item"]["status"]=="open"
        now[0]+=1801
        escalated=call("commerce.monitor.sla.refresh",write=True)
        assert escalated["created_count"]>=2
        report=call("commerce.monitor.report")
        assert report["alerts_total"]==1
        assert report["snapshots_total"]==1
        csv=call("commerce.monitor.report.csv")
        assert csv["rows"]==1 and csv["formula_injection_guard"]
        call("commerce.finance.expenses.void",{
            "project_id":project,"expense_id":expense["id"],
            "expected_version":1,"reason":"Cost cancelled"},True)
        manual=call("commerce.monitor.scan",{"expected_policy_version":1},True)
        assert manual["alert_changes"]["cleared"]
        changes=call("commerce.monitor.sla.refresh",write=True)
        assert changes["cleared"]
        history=call("commerce.monitor.snapshots.list")
        assert history["total"]==2
        comparison=call("commerce.monitor.snapshots.compare",{
            "previous_id":history["snapshots"][0]["id"],
            "current_id":history["snapshots"][1]["id"]})
        assert any(x["resolved"] for x in comparison["deltas"])
        assert not result["bank_verified"]
        print(json.dumps({"status":"M202_SMOKE_PASS",
            "scheduled_scan":True,"snapshots":2,
            "sla_episodes_detected":escalated["created_count"],
            "csv_rows":csv["rows"],
            "external_notifications":False,
            "bank_verified":False,"production_authorized":False},
            ensure_ascii=False))


if __name__=="__main__":main()
