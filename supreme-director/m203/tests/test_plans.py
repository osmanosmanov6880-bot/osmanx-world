"""M203 real SQLite tests: action plans, task delegation, roles and integrity."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from osgard_m192.runtime import Invalid, Conflict, Unauthorized
from osgard_m202.runtime import Director202
from osgard_m203.runtime import Director203


def key():
    return "m203-"+uuid.uuid4().hex


class PlanTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix="m203-plans-")
        self.addCleanup(temp.cleanup)
        self.now=[1799971200]
        self.path=Path(temp.name)/"app.sqlite"
        self.app=Director203(self.path,clock=lambda:self.now[0])
        self.app.initialize()
        self.owner=self.app.provision("Tenant One","owner")["token"]
        self.staff=self.app.issue_token(self.owner,"employee","operator")["token"]
        self.viewer=self.app.issue_token(self.owner,"observer","viewer")["token"]
        self.other=self.app.provision("Tenant Two","foreign")["token"]
        client=self.call("commerce.customers.create",
            {"name":"Synthetic Customer","contact":"none"},write=True)["id"]
        deal=self.call("commerce.deals.create",{
            "customer_id":client,"title":"Synthetic Contract",
            "amount_minor":50000,"stage":"new"},write=True)["id"]
        self.project=self.call("commerce.projects.create",{
            "deal_id":deal,"title":"Project Alpha"},write=True)["id"]

    def call(self,op,p=None,token=None,write=False,idem=None):
        return self.app.execute(token or self.owner,op,p if p is not None else {},
            idem if idem is not None else key() if write else None)

    def setup_alert(self,amount=12000):
        self.call("commerce.alerts.policy.set",{
            "expected_version":0,"config":{}},write=True)
        expense=self.call("commerce.finance.expenses.add",{
            "project_id":self.project,"title":"No date",
            "category":"services","amount_minor":amount,
            "kind":"planned"},write=True)
        sample=self.call("commerce.monitor.scan",{
            "expected_policy_version":1},write=True)["snapshot"]
        alert=self.call("commerce.alerts.list")["items"][0]
        return expense,alert,sample

    def create(self,alert,sample,target=0,idem=None):
        return self.call("commerce.actions.create",{
            "alert_id":alert["id"],"expected_alert_version":alert["version"],
            "baseline_snapshot_id":sample["id"],"title":"Устранить причины",
            "hypothesis":"Датирование плановых расходов может уменьшить неопределённость",
            "target_value":target,"due_at":self.now[0]+3600},
            write=True,idem=idem)

    def add_step(self,plan,version=None,assignee="employee",idem=None):
        return self.call("commerce.actions.step.add",{
            "plan_id":plan["id"],
            "expected_version":version if version is not None else plan["version"],
            "title":"Внести даты расходов",
            "description":"Указать сроки и проверить план",
            "assignee":assignee,"due_at":self.now[0]+1800},
            write=True,idem=idem)

    def test_migration_preserves_previous_runtime(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"old.sqlite"
            legacy=Director202(path,clock=lambda:self.now[0])
            legacy.initialize()
            token=legacy.provision("Old Tenant","boss")["token"]
            current=Director203(path,clock=lambda:self.now[0])
            current.initialize()
            self.assertEqual(
                current.execute(token,"titan.session.get",{})["actor"],"boss")
            with current.connect() as db:
                names={r[0] for r in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'")}
                self.assertIn("financial_action_plans",names)
                self.assertIn("financial_action_evaluations",names)

    def test_create_plan_from_actual_risk(self):
        _,a,s=self.setup_alert()
        created=self.create(a,s)
        self.assertEqual(created["status"],"draft")
        self.assertEqual(created["baseline_value"],12000)
        self.assertEqual(created["target_value"],0)
        self.assertFalse(created["bank_verified"])
        self.assertEqual(len(self.call("commerce.actions.list")["items"]),1)

    def test_unrecognized_alert_blocked(self):
        _,a,s=self.setup_alert()
        with self.assertRaises(Invalid):
            self.create({**a,"id":"a"*32},s)

    def test_wrong_alert_version_blocked(self):
        _,a,s=self.setup_alert()
        with self.assertRaises(Conflict):
            self.create({**a,"version":88},s)

    def test_nonexistent_snapshot_blocked(self):
        _,a,s=self.setup_alert()
        with self.assertRaises(Invalid):
            self.create(a,{"id":"b"*32})

    def test_target_must_reduce_observed_risk(self):
        _,a,s=self.setup_alert()
        with self.assertRaises(Invalid):
            self.create(a,s,target=13000)

    def test_target_rejects_boolean_and_float(self):
        _,a,s=self.setup_alert()
        for value in (True,3.4,-1,"0",10**19):
            with self.subTest(value=value),self.assertRaises(Invalid):
                self.create(a,s,target=value)

    def test_one_open_plan_per_alert(self):
        _,a,s=self.setup_alert()
        self.create(a,s)
        with self.assertRaises(Conflict):
            self.create(a,s)

    def test_step_creates_actual_m195_task(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        step=self.add_step(p)
        self.assertEqual(step["plan_version"],2)
        task=self.call("titan.work.get",{"id":step["work_id"]},
                       token=self.staff)["item"]
        self.assertEqual(task["assignee"],"employee")
        self.assertEqual(task["status"],"open")
        self.assertEqual(task["priority"],"high")
        self.assertFalse(step["external_notifications_sent"])

    def test_staff_only_sees_assigned_action_task(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        step=self.add_step(p)
        mine=self.call("commerce.actions.mine",token=self.staff)
        self.assertEqual(mine["scope"],"ASSIGNED_WORK_ONLY")
        self.assertTrue(mine["financial_metrics_redacted"])
        self.assertEqual(mine["items"][0]["work_id"],step["work_id"])
        self.assertNotIn("baseline_value",mine["items"][0])
        self.assertNotIn("target_value",mine["items"][0])

    def test_viewer_forbidden_to_view_or_write(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        for operation,payload in (
            ("commerce.actions.list",{}),
            ("commerce.actions.mine",{}),
            ("commerce.actions.get",{"plan_id":p["id"]}),
            ("commerce.actions.report",{})
        ):
            with self.subTest(op=operation),self.assertRaises(Unauthorized):
                self.call(operation,payload,token=self.viewer)

    def test_foreign_owner_sees_only_own_empty_list(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        self.assertEqual(self.call("commerce.actions.list",
                                   token=self.other)["items"],[])
        self.assertEqual(self.call("commerce.actions.report",
                                   token=self.other)["plan_count"],0)
        with self.assertRaises(Invalid):
            self.call("commerce.actions.get",{"plan_id":p["id"]},
                      token=self.other)

    def test_operator_denied_financial_plan_details(self):
        _,a,s=self.setup_alert()
        self.create(a,s)
        with self.assertRaises(Unauthorized):
            self.call("commerce.actions.list",token=self.staff)

    def test_wrong_employee_denied_and_rollback(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        with self.assertRaises(Invalid):
            self.add_step(p,assignee="ghost")
        self.assertEqual(self.call("commerce.actions.get",{
            "plan_id":p["id"]})["item"]["total_steps"],0)

    def test_stale_plan_step_blocked(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        self.add_step(p)
        with self.assertRaises(Conflict):
            self.add_step(p)

    def test_plan_requires_tasks_to_start(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        with self.assertRaises(Conflict):
            self.call("commerce.actions.start",{
                "plan_id":p["id"],"expected_version":1},write=True)

    def test_plan_activate_then_cancel_and_keep_tasks(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        step=self.add_step(p)
        running=self.call("commerce.actions.start",{
            "plan_id":p["id"],"expected_version":2},write=True)
        self.assertEqual(running["status"],"active")
        cancelled=self.call("commerce.actions.cancel",{
            "plan_id":p["id"],"expected_version":3,
            "reason":"План больше не актуален"},write=True)
        self.assertEqual(cancelled["status"],"cancelled")
        self.assertIn(step["work_id"],cancelled["remaining_task_ids"])
        self.assertFalse(cancelled["tasks_cancelled_automatically"])
        item=self.call("titan.work.get",{"id":step["work_id"]})["item"]
        self.assertEqual(item["status"],"open")

    def test_plan_cancellation_needs_reason(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        with self.assertRaises(Invalid):
            self.call("commerce.actions.cancel",{
                "plan_id":p["id"],"expected_version":1,
                "reason":""},write=True)

    def test_plan_history_chain_and_immutability(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        self.add_step(p)
        result=self.call("commerce.actions.history",{"plan_id":p["id"]})
        self.assertEqual(result["total"],2)
        self.assertEqual(len(result["head"]),64)
        with self.app.connect() as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM financial_action_events")

    def test_corrupted_events_detected(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        with self.app.connect() as db:
            db.execute("DROP TRIGGER immutable_action_events_update")
            db.execute("UPDATE financial_action_events SET actor='edited'")
        with self.assertRaises(Conflict):
            self.call("commerce.actions.history",{"plan_id":p["id"]})

    def test_idempotent_plan_creation_and_conflict(self):
        _,a,s=self.setup_alert()
        idem=key()
        first=self.create(a,s,idem=idem)
        second=self.create(a,s,idem=idem)
        self.assertEqual(first,second)
        with self.assertRaises(Conflict):
            self.call("commerce.actions.cancel",{
                "plan_id":first["id"],"expected_version":1,
                "reason":"test"},write=True,idem=idem)

    def test_concurrent_step_version_one_winner(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        def run(i):
            try:
                self.add_step(p,idem=key())
                return "ok"
            except Conflict:
                return "conflict"
        with ThreadPoolExecutor(max_workers=6) as pool:
            out=list(pool.map(run,range(6)))
        self.assertEqual(out.count("ok"),1)
        self.assertEqual(out.count("conflict"),5)

    def test_report_summary_comes_from_tasks(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        self.add_step(p)
        report=self.call("commerce.actions.report")
        self.assertEqual(report["plan_count"],1)
        self.assertEqual(report["task_count"],1)
        self.assertEqual(report["task_completed_count"],0)
        self.assertFalse(report["financial_outcome_proven"])

    def test_csv_export_has_hypothetical_warning(self):
        _,a,s=self.setup_alert()
        self.create(a,s)
        data=self.call("commerce.actions.report.csv")
        self.assertTrue(data["content"].startswith("\ufeff"))
        self.assertEqual(data["rows"],1)
        self.assertFalse(data["bank_verified"])

    def test_readonly_operations_do_not_log_requests(self):
        _,a,s=self.setup_alert()
        p=self.create(a,s)
        with self.app.connect() as db:
            count=db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
        self.call("commerce.actions.get",{"plan_id":p["id"]})
        self.call("commerce.actions.list")
        self.call("commerce.actions.report")
        self.call("commerce.actions.report.csv")
        self.call("commerce.actions.history",{"plan_id":p["id"]})
        with self.app.connect() as db:
            after=db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
        self.assertEqual(count,after)

    def test_previous_m202_api_still_accessible(self):
        self.setup_alert()
        self.assertEqual(self.call("commerce.monitor.snapshots.list")["total"],1)


if __name__=="__main__":
    unittest.main()
