"""M202 employee response SLA and incident lifecycle regression."""
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from osgard_m192.runtime import Conflict, Invalid, Unauthorized
from osgard_m202.runtime import Director202


def key(): return "m202-sla-"+uuid.uuid4().hex


class SLATests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix="m202-sla-")
        self.addCleanup(temp.cleanup)
        self.now=[1799971200]
        self.engine=Director202(Path(temp.name)/"db.sqlite",
                                clock=lambda:self.now[0])
        self.engine.initialize()
        self.owner=self.engine.provision("SLA Company","owner")["token"]
        self.worker=self.engine.issue_token(self.owner,"worker","operator")["token"]
        client=self.call("commerce.customers.create",
            {"name":"Customer","contact":"local"},write=True)["id"]
        deal=self.call("commerce.deals.create",
            {"customer_id":client,"title":"Contract",
             "amount_minor":900000,"stage":"new"},write=True)["id"]
        self.project=self.call("commerce.projects.create",
            {"deal_id":deal,"title":"Delivery"},write=True)["id"]
        self.call("commerce.alerts.policy.set",{
            "expected_version":0,"config":{}},write=True)
        self.call("commerce.monitor.schedule.set",{
            "expected_version":0,"enabled":False,
            "interval_seconds":3600,"ack_sla_seconds":1800,
            "resolve_sla_seconds":7200},write=True)

    def call(self,op,p=None,write=False,token=None,idem=None):
        return self.engine.execute(token or self.owner,op,p or {},
            idem if idem is not None else key() if write else None)

    def risk(self):
        expense=self.call("commerce.finance.expenses.add",{
            "project_id":self.project,"title":"Local Cost",
            "category":"services","amount_minor":5000,"kind":"planned"},
            write=True)
        self.call("commerce.monitor.scan",{"expected_policy_version":1},write=True)
        alert=self.call("commerce.alerts.list")["items"][0]
        return expense,alert

    def refresh(self):
        return self.call("commerce.monitor.sla.refresh",write=True)

    def board(self):
        return self.call("commerce.monitor.sla.board")

    def test_ack_breach_after_sla(self):
        self.risk()
        self.now[0]+=1801
        value=self.refresh()
        self.assertEqual(value["created_count"],1)
        board=self.board()
        self.assertEqual(board["live_breaches_count"],1)
        self.assertEqual(board["items"][0]["kind"],"ACK_OVERDUE")

    def test_repeated_refresh_does_not_duplicate(self):
        self.risk();self.now[0]+=1801
        first=self.refresh()
        second=self.refresh()
        self.assertEqual(first["created_count"],1)
        self.assertEqual(second["created_count"],0)
        self.assertEqual(len(second["deduplicated"]),1)
        self.assertEqual(self.board()["total"],1)

    def test_ack_closes_breach(self):
        _,alert=self.risk();self.now[0]+=1801
        self.refresh()
        self.call("commerce.alerts.ack",{
            "alert_id":alert["id"],"expected_version":1},write=True)
        self.assertEqual(len(self.refresh()["cleared"]),1)
        self.assertEqual(self.board()["live_breaches_count"],0)

    def test_resolution_breach_with_ack(self):
        _,alert=self.risk()
        self.call("commerce.alerts.ack",{
            "alert_id":alert["id"],"expected_version":1},write=True)
        self.now[0]+=7201
        value=self.refresh()
        self.assertEqual(value["created_count"],1)
        self.assertEqual(self.board()["items"][0]["kind"],"RESOLUTION_OVERDUE")

    def test_ack_and_resolution_both_overdue(self):
        self.risk();self.now[0]+=7201
        value=self.refresh()
        self.assertEqual(value["created_count"],2)
        kinds={x["kind"] for x in self.board()["items"]}
        self.assertEqual(kinds,{"ACK_OVERDUE","RESOLUTION_OVERDUE"})

    def test_task_overdue_from_actual_m195(self):
        _,alert=self.risk()
        work=self.call("commerce.alerts.task.create",{
            "alert_id":alert["id"],"expected_version":1,
            "assignee":"worker","due_at":self.now[0]+60},write=True)
        self.now[0]+=61
        self.assertEqual(self.refresh()["created_count"],1)
        board=self.board()
        self.assertEqual(board["items"][0]["kind"],"WORK_DUE_OVERDUE")
        self.assertEqual(board["items"][0]["assignee"],"worker")
        task=self.call("titan.work.get",{"id":work["work_id"]},token=self.worker)
        self.assertEqual(task["item"]["status"],"open")

    def test_finished_task_clears_task_breach(self):
        _,alert=self.risk()
        work=self.call("commerce.alerts.task.create",{
            "alert_id":alert["id"],"expected_version":1,
            "assignee":"worker","due_at":self.now[0]+60},write=True)
        self.now[0]+=61
        self.refresh()
        self.call("titan.work.status",{
            "id":work["work_id"],"expected_version":1,
            "status":"done"},write=True,token=self.worker)
        self.assertEqual(len(self.refresh()["cleared"]),1)

    def test_risk_resolution_closes_all_escalations(self):
        expense,_=self.risk()
        self.now[0]+=7201
        self.refresh()
        self.call("commerce.finance.expenses.void",{
            "project_id":self.project,"expense_id":expense["id"],
            "expected_version":1,"reason":"Removed"},write=True)
        self.call("commerce.monitor.scan",{
            "expected_policy_version":1},write=True)
        self.assertEqual(len(self.refresh()["cleared"]),2)

    def test_sla_event_history_integrity(self):
        self.risk();self.now[0]+=1801;self.refresh()
        self.assertTrue(self.board()["verified_event_chain"])
        with self.engine.connect() as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE financial_sla_events SET actor='changed'")

    def test_sla_stale_key(self):
        self.risk();self.now[0]+=1801
        idem=key()
        first=self.call("commerce.monitor.sla.refresh",write=True,idem=idem)
        second=self.call("commerce.monitor.sla.refresh",write=True,idem=idem)
        self.assertEqual(first,second)
        with self.assertRaises(Conflict):
            self.call("commerce.monitor.scan",{
                "expected_policy_version":1},write=True,idem=idem)

    def test_role_separation(self):
        self.risk()
        with self.assertRaises(Unauthorized):
            self.call("commerce.monitor.sla.board",token=self.worker)


if __name__=="__main__":
    unittest.main()
