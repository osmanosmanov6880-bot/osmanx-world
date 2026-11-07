"""Wave 23 tests: real workload, hypothetical assignments and no-write guarantees."""
from __future__ import annotations

from datetime import datetime,timedelta,timezone
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from wsgiref.util import setup_testing_defaults

from campaign180.app_runtime import LocalAppRuntime
from campaign180.app_policy import AppAccessDenied
from campaign180.resource_scenarios import ScenarioDenied
from campaign180.local_http import LocalConsole

ROOT=Path(__file__).resolve().parents[3]
DEMO=ROOT/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"
OWNER="owner-abc"
WORKER="operator-abc"
EDITOR="editor-abc"
VIEWER="viewer-abc"
TOKEN="W23_LocalToken_abcdefghABCDEFGHIJ_0123456789_XYZ"
PORT=8778

def token():return "wave23-"+uuid.uuid4().hex

class Fixture(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db=Path(tmp.name)/"work.sqlite3"
        spec=json.loads(DEMO.read_text(encoding="utf-8"))
        self.project=spec["project_id"]
        self.rt=LocalAppRuntime(str(self.db))
        self.rt.drafts.create(spec,tenant=TENANT)
        self.rt.policy.bootstrap_owner(tenant=TENANT,project_id=self.project,
                                        actor=OWNER,now=1799971200)
    def scope(self,actor=OWNER):
        return {"tenant":TENANT,"project_id":self.project,"actor":actor}
    def enroll(self,actor=WORKER,role="operator"):
        return self.rt.policy.add_member(
            tenant=TENANT,project_id=self.project,owner_actor=OWNER,
            member_actor=actor,role=role,now=1799971201)
    def revoke(self,actor=WORKER):
        return self.rt.policy.revoke_member(
            tenant=TENANT,project_id=self.project,owner_actor=OWNER,
            member_actor=actor,now=1799971202)
    def task(self,name="Выполнить",assignee=OWNER,due=None):
        return self.rt.create_team_task(
            **self.scope(),title=name,assignee=assignee,due_date=due,
            idempotency_key=token())["task"]
    def effort(self,item,hours,version=0):
        return self.rt.set_forecast_effort(
            **self.scope(),task_id=item["task_id"],effort_hours=hours,
            expected_version=version,idempotency_key=token())
    def capacity(self,worker,hours,version=0):
        return self.rt.set_forecast_capacity(
            **self.scope(),worker=worker,hours_per_day=hours,
            expected_version=version,idempotency_key=token())
    def report(self,actor=OWNER):
        return self.rt.resource_workload(**self.scope(actor))
    def compare(self,moves, snapshot=None, actor=OWNER):
        return self.rt.compare_resource_scenario(
            **self.scope(actor),
            expected_snapshot=snapshot or self.report()["input_snapshot"],
            moves=moves)
    def move(self,item,worker=WORKER):
        return {"task_id":item["task_id"],"assignee":worker}
    def snapshot_database(self):
        with self.rt.drafts._db() as db:
            tasks=[tuple(r) for r in db.execute(
                "SELECT task_id,assignee,status,version,task_digest FROM director_tasks ORDER BY task_id")]
            effort=[tuple(r) for r in db.execute(
                "SELECT task_id,effort_hours,version,row_digest FROM director_task_effort ORDER BY task_id")]
            capacity=[tuple(r) for r in db.execute(
                "SELECT worker,hours_per_day,version,row_digest FROM director_worker_capacity ORDER BY worker")]
            journals=[db.execute("SELECT count(*) FROM director_forecast_events").fetchone()[0],
                      db.execute("SELECT count(*) FROM director_task_events").fetchone()[0]]
            return tasks,effort,capacity,journals

class WorkloadTests(Fixture):
    def test_empty_project_has_no_fabricated_pressure_or_deadline(self):
        out=self.report()
        self.assertEqual(out["metrics"]["overloaded_workers"],0)
        self.assertIsNone(out["metrics"]["potential_finish"])
        self.assertTrue(out["model"]["missing_inputs_are_unknown"])
        self.assertEqual(len(out["input_snapshot"]),64)

    def test_missing_effort_or_capacity_is_explicitly_unknown(self):
        item=self.task()
        a=self.report()
        self.assertEqual(a["metrics"]["unknown_load_workers"],1)
        self.assertIsNone(a["workers"][0]["overloaded_10d"])
        self.effort(item,32)
        b=self.report()
        self.assertIsNone(b["workers"][0]["backlog_workdays"])
        self.capacity(OWNER,4)
        c=self.report()
        self.assertEqual(c["workers"][0]["backlog_pressure_10d_percent"],80)
        self.assertFalse(c["workers"][0]["overloaded_10d"])

    def test_backlog_over_ten_days_is_flagged_not_claimed_as_due_date(self):
        self.capacity(OWNER,4)
        for index in range(3):
            item=self.task("Работа "+str(index))
            self.effort(item,32)
        x=self.report()
        self.assertEqual(x["workers"][0]["estimated_hours"],96)
        self.assertEqual(x["workers"][0]["backlog_workdays"],24)
        self.assertEqual(x["workers"][0]["backlog_pressure_10d_percent"],240)
        self.assertTrue(x["workers"][0]["overloaded_10d"])
        self.assertEqual(x["metrics"]["overloaded_workers"],1)

    def test_one_unestimated_task_makes_worker_pressure_unknown(self):
        self.capacity(OWNER,4)
        first=self.task("Оценена")
        self.task("Не оценена")
        self.effort(first,120)
        x=self.report()
        self.assertEqual(x["workers"][0]["unknown_estimates"],1)
        self.assertIsNone(x["workers"][0]["overloaded_10d"])
        self.assertEqual(x["metrics"]["unknown_load_workers"],1)

    def test_no_invented_employee_capacity_from_existing_role(self):
        self.enroll()
        item=self.task(assignee=WORKER)
        self.effort(item,30)
        report=self.report()
        row=next(x for x in report["workers"] if x["worker"]==WORKER)
        self.assertIsNone(row["hours_per_day"])
        self.assertIsNone(row["backlog_pressure_10d_percent"])

class ScenarioTests(Fixture):
    def seed(self):
        self.enroll()
        self.capacity(OWNER,4)
        self.capacity(WORKER,8)
        future=(datetime.now(timezone.utc).date()+timedelta(days=30)).isoformat()
        tasks=[]
        for n in range(3):
            t=self.task("Поручение "+str(n),due=future)
            self.effort(t,32)
            tasks.append(t)
        return tasks

    def test_two_moves_relieve_ten_day_pressure(self):
        tasks=self.seed()
        preview=self.compare([self.move(tasks[1]),self.move(tasks[2])])
        self.assertEqual(preview["baseline"]["metrics"]["overloaded_workers"],1)
        self.assertEqual(preview["scenario"]["metrics"]["overloaded_workers"],0)
        self.assertEqual(preview["comparison"]["overload_worker_delta"],-1)
        self.assertLess(preview["comparison"]["finish_delta_calendar_days"],0)
        self.assertTrue(preview["policy"]["no_real_assignments_changed"])
        self.assertTrue(preview["policy"]["no_database_writes"])

    def test_comparison_does_not_write_tasks_capacity_or_audit(self):
        tasks=self.seed()
        before=self.snapshot_database()
        result=self.compare([self.move(tasks[0])])
        after=self.snapshot_database()
        self.assertEqual(before,after)
        self.assertTrue(result["policy"]["simulation_only"])
        original=self.rt.project_resource_forecast(**self.scope())
        self.assertTrue(all(t["assignee"]==OWNER for t in original["tasks"]))

    def test_same_snapshot_and_moves_produce_deterministic_result(self):
        tasks=self.seed()
        snapshot=self.report()["input_snapshot"]
        first=self.compare([self.move(tasks[1])],snapshot)
        second=self.compare([self.move(tasks[1])],snapshot)
        self.assertEqual(first,second)
        self.assertEqual(first["input_snapshot"],snapshot)

    def test_stale_snapshot_rejected_after_capacity_change(self):
        tasks=self.seed()
        stale=self.report()["input_snapshot"]
        self.capacity(OWNER,6,version=1)
        with self.assertRaises(ScenarioDenied):
            self.compare([self.move(tasks[0])],stale)
        self.assertEqual(self.snapshot_database()[0][0][1],OWNER)

    def test_stale_snapshot_rejected_after_task_update(self):
        tasks=self.seed()
        stale=self.report()["input_snapshot"]
        self.rt.update_team_task(
            **self.scope(),task_id=tasks[0]["task_id"],
            expected_version=tasks[0]["version"],
            changes={"description":"Changed"},idempotency_key=token())
        with self.assertRaises(ScenarioDenied):
            self.compare([self.move(tasks[1])],stale)

    def test_unknown_capacity_in_destination_avoids_fabricated_finish(self):
        self.enroll()
        t=self.task()
        self.capacity(OWNER,6)
        self.effort(t,12)
        preview=self.compare([self.move(t)])
        self.assertTrue(preview["baseline"]["metrics"]["coverage_complete"])
        self.assertFalse(preview["scenario"]["metrics"]["coverage_complete"])
        self.assertIsNone(preview["comparison"]["finish_delta_calendar_days"])
        self.assertFalse(preview["comparison"]["comparable_project_finish"])

    def test_noop_move_is_rejected(self):
        self.enroll()
        t=self.task()
        with self.assertRaises(ScenarioDenied):
            self.compare([self.move(t,OWNER)])

    def test_completed_task_cannot_be_moved_even_in_simulation(self):
        self.enroll()
        t=self.task()
        complete=self.rt.update_team_task(
            **self.scope(),task_id=t["task_id"],
            expected_version=t["version"],changes={"status":"done"},
            idempotency_key=token())["task"]
        with self.assertRaises(ScenarioDenied):
            self.compare([self.move(complete)])

    def test_unknown_or_other_project_task_rejected(self):
        self.enroll()
        with self.assertRaises(ScenarioDenied):
            self.compare([{"task_id":str(uuid.uuid4()),"assignee":WORKER}])

    def test_revoked_and_viewer_destinations_rejected(self):
        self.enroll()
        self.enroll(VIEWER,"viewer")
        t=self.task()
        with self.assertRaises(ScenarioDenied):
            self.compare([self.move(t,VIEWER)])
        self.revoke()
        with self.assertRaises(ScenarioDenied):
            self.compare([self.move(t)])

    def test_duplicate_move_and_invalid_field_rejected(self):
        self.enroll()
        t=self.task()
        for moves in (
            [self.move(t),self.move(t)],
            [{"task_id":t["task_id"],"assignee":WORKER,"role":"owner"}],
            [{"task_id":t["task_id"]}],
            [{"task_id":t["task_id"],"assignee":"bad!"}],
            [{"task_id":t["task_id"],"assignee":None}],
        ):
            with self.subTest(moves=moves):
                with self.assertRaises(ScenarioDenied):
                    self.compare(moves)

    def test_move_limit_and_expected_snapshot_format(self):
        self.enroll()
        t=self.task()
        for moves in ([],[self.move(t)]*21,{"task_id":t["task_id"]},"broken"):
            with self.subTest(moves=str(moves)[:25]):
                with self.assertRaises(ScenarioDenied):
                    self.compare(moves)
        for snapshot in ("abc","A"*64,123,None):
            with self.subTest(snapshot=snapshot):
                with self.assertRaises(ScenarioDenied):
                    self.rt.compare_resource_scenario(
                        **self.scope(),expected_snapshot=snapshot,moves=[self.move(t)])

    def test_no_escalation_for_operator_viewer_or_revoked_editor(self):
        self.enroll()
        self.enroll(VIEWER,"viewer")
        self.enroll(EDITOR,"editor")
        t=self.task()
        for actor in (WORKER,VIEWER):
            with self.subTest(actor=actor):
                with self.assertRaises(AppAccessDenied):
                    self.report(actor)
                with self.assertRaises(AppAccessDenied):
                    self.compare([self.move(t)],actor=actor)
        previous=self.report(EDITOR)["input_snapshot"]
        self.revoke(EDITOR)
        with self.assertRaises(AppAccessDenied):
            self.compare([self.move(t)],snapshot=previous,actor=EDITOR)

    def test_wrong_tenant_cannot_fetch_or_compare(self):
        self.enroll()
        t=self.task()
        wrong={**self.scope(),"tenant":"different_tenant"}
        with self.assertRaises(AppAccessDenied):
            self.rt.resource_workload(**wrong)
        with self.assertRaises(AppAccessDenied):
            self.rt.compare_resource_scenario(
                **wrong,expected_snapshot=self.report()["input_snapshot"],
                moves=[self.move(t)])

    def test_scenario_does_not_change_real_future_milestones(self):
        self.enroll()
        t=self.task()
        self.capacity(OWNER,8)
        self.capacity(WORKER,8)
        self.effort(t,32)
        now=datetime.now(timezone.utc).date()
        phase=self.rt.create_delivery_phase(
            **self.scope(),name="Этап",baseline_start=now.isoformat(),
            baseline_end=(now+timedelta(days=20)).isoformat(),
            idempotency_key=token())["phase"]
        mile=self.rt.create_delivery_milestone(
            **self.scope(),phase_id=phase["phase_id"],name="Контроль",
            baseline_due=(now+timedelta(days=5)).isoformat(),
            linked_task_id=t["task_id"],idempotency_key=token())["milestone"]
        before=self.rt.delivery_schedule(**self.scope())
        self.compare([self.move(t)])
        after=self.rt.delivery_schedule(**self.scope())
        self.assertEqual(before,after)
        self.assertEqual(after["milestones"][0]["milestone_id"],mile["milestone_id"])

class HTTPTests(Fixture):
    def send(self,path,data=None,*,method="POST",secret=TOKEN,origin=None):
        app=LocalConsole(self.db,tenant=TENANT,project_id=self.project,
                         actor=OWNER,token=TOKEN,port=PORT)
        env={}
        setup_testing_defaults(env)
        content=json.dumps(data,ensure_ascii=False).encode() if data is not None else b""
        env.update({
            "REQUEST_METHOD":method,"PATH_INFO":path,
            "HTTP_HOST":f"127.0.0.1:{PORT}","REMOTE_ADDR":"127.0.0.1",
            "QUERY_STRING":"","HTTP_AUTHORIZATION":"Bearer "+secret,
            "CONTENT_TYPE":"application/json","CONTENT_LENGTH":str(len(content)),
            "wsgi.input":BytesIO(content),
        })
        if origin:env["HTTP_ORIGIN"]=origin
        responses=[]
        data=b"".join(app(env,lambda code,headers:responses.append(code)))
        return responses[0],json.loads(data)

    def test_http_read_only_compare_and_no_write(self):
        self.enroll()
        t=self.task()
        self.effort(t,16)
        self.capacity(OWNER,4)
        self.capacity(WORKER,8)
        status,workload=self.send("/api/v1/scenarios/workload",method="GET")
        self.assertTrue(status.startswith("200"),(status,workload))
        before=self.snapshot_database()
        status,preview=self.send("/api/v1/scenarios/compare",{
            "expected_snapshot":workload["input_snapshot"],
            "moves":[self.move(t)]})
        self.assertTrue(status.startswith("200"),(status,preview))
        self.assertTrue(preview["policy"]["no_database_writes"])
        self.assertEqual(self.snapshot_database(),before)

    def test_http_rejects_cross_origin_bad_token_and_spoofed_actor(self):
        self.enroll()
        t=self.task()
        body={"expected_snapshot":self.report()["input_snapshot"],
              "moves":[self.move(t)]}
        url="/api/v1/scenarios/compare"
        status,_=self.send(url,body,secret="bad")
        self.assertTrue(status.startswith("401"))
        status,_=self.send(url,body,origin="https://evil.invalid")
        self.assertTrue(status.startswith("403"))
        status,_=self.send(url,{**body,"actor":OWNER})
        self.assertTrue(status.startswith("400"))
        self.assertTrue(all(t["assignee"]==OWNER
                            for t in self.rt.project_resource_forecast(**self.scope())["tasks"]))

if __name__=="__main__":
    unittest.main()
