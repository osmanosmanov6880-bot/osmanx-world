"""M202 synthetic SQLite integration tests for schedule, snapshots and reports."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest
import uuid

from osgard_m192.runtime import Conflict, Invalid, Unauthorized
from osgard_m201.runtime import Director201
from osgard_m202.runtime import Director202


def key(): return "m202-"+uuid.uuid4().hex


class MonitorTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix="m202-")
        self.addCleanup(temp.cleanup)
        self.path=Path(temp.name)/"db.sqlite"
        self.now=[1799971200]
        self.app=Director202(self.path,clock=lambda:self.now[0])
        self.app.initialize()
        self.owner=self.app.provision("Tenant A","owner")["token"]
        self.operator=self.app.issue_token(self.owner,"worker","operator")["token"]
        self.viewer=self.app.issue_token(self.owner,"viewer","viewer")["token"]
        self.foreign=self.app.provision("Tenant B","other")["token"]
        client=self.call("commerce.customers.create",
            {"name":"Test Customer","contact":"local"},write=True)["id"]
        deal=self.call("commerce.deals.create",
            {"customer_id":client,"title":"Test Job","amount_minor":100000,
             "stage":"new"},write=True)["id"]
        self.pid=self.call("commerce.projects.create",
            {"deal_id":deal,"title":"Test Project"},write=True)["id"]

    def call(self,op,p=None,token=None,write=False,idem=None):
        return self.app.execute(token or self.owner,op,p or {},
             idem if idem is not None else key() if write else None)

    def policy(self):
        return self.call("commerce.alerts.policy.set",
            {"expected_version":0,"config":{}},write=True)

    def config(self,version=0,enabled=True,interval=3600,ack=1800,resolve=7200):
        return self.call("commerce.monitor.schedule.set",{
            "expected_version":version,"enabled":enabled,
            "interval_seconds":interval,"ack_sla_seconds":ack,
            "resolve_sla_seconds":resolve},write=True)

    def cost(self,minor=12000):
        return self.call("commerce.finance.expenses.add",
            {"project_id":self.pid,"title":"Undated planned cost","category":"services",
             "amount_minor":minor,"kind":"planned"},write=True)

    def scan(self):
        return self.call("commerce.monitor.scan",
            {"expected_policy_version":1},write=True)

    def due(self,version=1):
        return self.call("commerce.monitor.schedule.run_due",
            {"expected_schedule_version":version},write=True)

    def test_legacy_database_additive_migration(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"old.sqlite"
            legacy=Director201(path,clock=lambda:self.now[0])
            legacy.initialize()
            token=legacy.provision("Legacy","boss")["token"]
            before=legacy.execute(token,"titan.session.get",{})
            modern=Director202(path,clock=lambda:self.now[0])
            modern.initialize()
            self.assertEqual(modern.execute(token,"titan.session.get",{}),before)
            self.assertFalse(modern.execute(token,"commerce.monitor.schedule.get",{})["exists"])

    def test_explicit_config_required_for_due_scans(self):
        self.assertFalse(self.call("commerce.monitor.schedule.get")["enabled"])
        with self.assertRaises(Conflict):
            self.due()

    def test_policy_required_before_enabling(self):
        with self.assertRaises(Invalid):
            self.config()

    def test_config_version_and_time(self):
        self.policy()
        out=self.config()
        self.assertEqual(out["version"],1)
        self.assertTrue(out["enabled"])
        self.assertEqual(out["next_due_at"],self.now[0]+3600)
        self.assertFalse(out["background_process_running"])

    def test_config_invalid_ranges_and_bool(self):
        self.policy()
        for invalid in [True,0,3599,604801,3.5,"3600",None]:
            with self.subTest(value=invalid),self.assertRaises(Invalid):
                self.config(interval=invalid)
        for ack,res in [(0,7200),(True,7200),(1800,100),
                        (1800,31*86400)]:
            with self.subTest(ack=ack,res=res),self.assertRaises(Invalid):
                self.config(ack=ack,resolve=res)

    def test_schedule_disable_and_noop(self):
        self.policy();self.config()
        second=self.config(version=1,enabled=False)
        self.assertEqual(second["version"],2)
        self.now[0]+=7000
        self.assertEqual(self.due(2)["status"],"DISABLED")
        self.assertEqual(self.call("commerce.monitor.runs.list")["total"],0)

    def test_stale_schedule_config_refused(self):
        self.policy();self.config()
        with self.assertRaises(Conflict):
            self.config()
        with self.assertRaises(Conflict):
            self.config(version=1)

    def test_not_due_is_noop(self):
        self.policy();self.config();self.cost()
        self.assertEqual(self.due()["status"],"NOT_DUE")
        self.assertEqual(self.call("commerce.monitor.snapshots.list")["total"],0)

    def test_due_creates_single_scan_and_snapshot(self):
        self.policy();self.config();self.cost()
        self.now[0]+=3600
        result=self.due()
        self.assertTrue(result["ran"])
        self.assertEqual(result["alert_changes"]["created_count"],1)
        self.assertEqual(self.call("commerce.monitor.runs.list")["total"],1)
        snapshots=self.call("commerce.monitor.snapshots.list")
        self.assertEqual(snapshots["total"],1)
        self.assertEqual(snapshots["snapshots"][0]["origin"],"scheduled")
        self.assertEqual(self.due()["status"],"NOT_DUE")

    def test_catchup_skips_missed_intervals(self):
        self.policy();self.config()
        self.now[0]+=86400
        result=self.due()
        self.assertEqual(result["next_due_at"],self.now[0]+3600)

    def test_concurrent_due_exactly_one(self):
        self.policy();self.config();self.cost()
        self.now[0]+=3600
        with ThreadPoolExecutor(max_workers=5) as pool:
            results=list(pool.map(lambda _:self.due(),range(5)))
        self.assertEqual(sum(r["ran"] for r in results),1)

    def test_manual_snapshots_are_hash_chained(self):
        self.policy();self.cost()
        first=self.scan()["snapshot"]
        self.now[0]+=120
        second=self.scan()["snapshot"]
        out=self.call("commerce.monitor.snapshots.list")
        self.assertEqual(out["total"],2)
        self.assertEqual(len(out["head"]),64)
        self.assertEqual(first["policy_version"],second["policy_version"])

    def test_snapshot_real_metric_delta(self):
        self.policy()
        exp=self.cost(4000)
        first=self.scan()["snapshot"]["id"]
        self.call("commerce.finance.expenses.void",
            {"project_id":self.pid,"expense_id":exp["id"],
             "expected_version":1,"reason":"Cancelled"},write=True)
        self.now[0]+=120
        latest=self.scan()["snapshot"]["id"]
        comparison=self.call("commerce.monitor.snapshots.compare",
            {"previous_id":first,"current_id":latest})
        metric=next(x for x in comparison["deltas"] if x["rule"]=="UNSCHEDULED_COSTS")
        self.assertTrue(metric["resolved"])
        self.assertEqual(metric["delta"],-4000)

    def test_snapshot_limit_invalid_and_tenant_boundary(self):
        self.policy();self.scan()
        id=self.call("commerce.monitor.snapshots.list")["snapshots"][0]["id"]
        for limit in [True,0,201,"10"]:
            with self.subTest(limit=limit),self.assertRaises(Invalid):
                self.call("commerce.monitor.snapshots.list",{"limit":limit})
        with self.assertRaises(Unauthorized):
            self.call("commerce.monitor.snapshots.compare",
                {"previous_id":id,"current_id":id},self.foreign)

    def test_report_and_csv_are_readonly(self):
        self.policy();self.cost();self.scan()
        with self.app.connect() as db:
            before=db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
        report=self.call("commerce.monitor.report")
        self.assertEqual(report["alerts_total"],1)
        self.assertFalse(report["bank_verified"])
        self.assertEqual(report["snapshots_total"],1)
        output=self.call("commerce.monitor.report.csv")
        self.assertTrue(output["content"].startswith("\ufeff"))
        self.assertEqual(output["rows"],1)
        with self.app.connect() as db:
            after=db.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
        self.assertEqual(before,after)

    def test_financial_access_restricted(self):
        self.policy();self.cost();self.scan()
        for token in (self.operator,self.viewer,self.foreign):
            with self.subTest(token=token),self.assertRaises(Unauthorized):
                self.call("commerce.monitor.report",token=token)

    def test_old_M200_and_M201_apis_work(self):
        self.policy()
        self.assertEqual(self.call("commerce.cashflow.forecast")["project_count"],1)
        self.assertEqual(self.call("commerce.alerts.preview")["policy_version"],1)


if __name__=="__main__":
    unittest.main()
