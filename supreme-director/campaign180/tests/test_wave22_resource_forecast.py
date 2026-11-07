"""Wave 22: real input provenance, explicit resource scheduling, RBAC and HTTP."""
from __future__ import annotations

from datetime import datetime, date, timedelta, timezone
from io import BytesIO
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from wsgiref.util import setup_testing_defaults

from campaign180.app_runtime import LocalAppRuntime
from campaign180.app_policy import AppAccessDenied
from campaign180.resource_forecast import ForecastDenied
from campaign180.local_http import LocalConsole

ROOT=Path(__file__).resolve().parents[3]
DEMO=ROOT/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"
OWNER="owner-abc"
EDITOR="editor-abc"
OPERATOR="operator-abc"
OTHER="other-abc"
VIEWER="viewer-abc"
TOKEN="W22_LocalToken_abcdefghABCDEFGHIJ_0123456789_XYZ"
PORT=8777


def key():
    return "wave22-"+uuid.uuid4().hex


class Fixture(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db=Path(temp.name)/"forecast.sqlite3"
        spec=json.loads(DEMO.read_text(encoding="utf-8"))
        self.project=spec["project_id"]
        self.runtime=LocalAppRuntime(str(self.db))
        self.runtime.drafts.create(spec,tenant=TENANT)
        self.runtime.policy.bootstrap_owner(
            tenant=TENANT,project_id=self.project,
            actor=OWNER,now=1799971200)

    def scope(self,actor=OWNER):
        return {"tenant":TENANT,"project_id":self.project,"actor":actor}

    def enroll(self,actor=OPERATOR,role="operator"):
        self.runtime.policy.add_member(
            tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=actor,role=role,now=1799971201)

    def revoke(self,actor):
        self.runtime.policy.revoke_member(
            tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=actor,now=1799971202)

    def task(self,title="Задача",assignee=OWNER,status="todo",
             due_date=None):
        value=self.runtime.create_team_task(
            **self.scope(),title=title,assignee=assignee,
            due_date=due_date,idempotency_key=key())["task"]
        if status!="todo":
            value=self.runtime.update_team_task(
                **self.scope(),task_id=value["task_id"],
                expected_version=value["version"],changes={"status":status},
                idempotency_key=key())["task"]
        return value

    def effort(self,task,hours=8,version=0,actor=OWNER,nonce=None):
        return self.runtime.set_forecast_effort(
            **self.scope(actor),task_id=task["task_id"],
            effort_hours=hours,expected_version=version,
            idempotency_key=nonce or key())

    def capacity(self,worker=OWNER,hours=8,version=0,actor=OWNER,nonce=None):
        return self.runtime.set_forecast_capacity(
            **self.scope(actor),worker=worker,hours_per_day=hours,
            expected_version=version,idempotency_key=nonce or key())

    def forecast(self,actor=OWNER):
        return self.runtime.project_resource_forecast(**self.scope(actor))

    def task_row(self,task):
        return next(x for x in self.forecast()["tasks"]
                    if x["task_id"]==task["task_id"])

    def dependency(self,task,before):
        self.runtime.add_task_dependency(
            **self.scope(),task_id=task["task_id"],
            prerequisite_id=before["task_id"],
            expected_version=task["version"],
            idempotency_key=key())


class ForecastCoreTests(Fixture):
    def test_empty_project_never_fabricates_finish(self):
        result=self.forecast()
        self.assertEqual(result["metrics"]["open_tasks"],0)
        self.assertIsNone(result["metrics"]["potential_finish"])
        self.assertTrue(result["metrics"]["coverage_complete"])
        self.assertTrue(result["policy"]["no_predictive_model"])
        self.assertFalse(result["production_published"])

    def test_unassigned_task_with_missing_input_does_not_have_date(self):
        item=self.task(assignee=None)
        result=self.forecast()
        self.assertEqual(result["metrics"]["unforecastable_tasks"],1)
        self.assertFalse(result["metrics"]["coverage_complete"])
        self.assertIsNone(result["metrics"]["potential_finish"])
        self.assertEqual(self.task_row(item)["state"],"unassigned")

    def test_no_capacity_with_effort_does_not_invent_employee_speed(self):
        item=self.task()
        self.effort(item,hours=16)
        self.assertEqual(self.task_row(item)["state"],"capacity_missing")
        self.assertIsNone(self.forecast()["metrics"]["potential_finish"])

    def test_capacity_and_effort_produce_real_business_day_finish(self):
        item=self.task()
        self.effort(item,hours=16)
        self.capacity(hours=8)
        out=self.task_row(item)
        self.assertEqual(out["state"],"scheduled")
        self.assertEqual(out["estimated_workdays"],2)
        beginning=date.fromisoformat(out["estimated_start"])
        finished=date.fromisoformat(out["estimated_finish"])
        self.assertLess(beginning.weekday(),5)
        self.assertLess(finished.weekday(),5)
        self.assertEqual(finished,
            beginning+timedelta(days=1 if beginning.weekday()<4 else 3))
        self.assertEqual(self.forecast()["metrics"]["potential_finish"],
                         out["estimated_finish"])

    def test_serial_employee_work_is_not_assumed_parallel(self):
        a=self.task(title="Первый",due_date="2027-01-01")
        b=self.task(title="Второй",due_date="2027-02-01")
        self.capacity(hours=4)
        self.effort(a,hours=8)
        self.effort(b,hours=8)
        first=self.task_row(a)
        second=self.task_row(b)
        self.assertEqual(first["estimated_workdays"],2)
        self.assertEqual(second["estimated_workdays"],2)
        self.assertLess(first["estimated_finish"],second["estimated_start"])
        self.assertTrue(self.forecast()["metrics"]["coverage_complete"])

    def test_dependency_on_other_worker_defers_start(self):
        self.enroll()
        a=self.task(title="Подготовка",assignee=OWNER)
        b=self.task(title="Проверка",assignee=OPERATOR)
        self.dependency(b,a)
        self.capacity(OWNER,8)
        self.capacity(OPERATOR,8)
        self.effort(a,24)
        self.effort(b,8)
        start=self.task_row(a)
        later=self.task_row(b)
        self.assertLess(start["estimated_finish"],later["estimated_start"])
        self.assertEqual(later["state"],"scheduled")

    def test_missing_one_estimate_suppresses_all_assignee_predictions(self):
        a=self.task(title="Оценена")
        b=self.task(title="Не оценена")
        self.capacity(hours=8)
        self.effort(a,8)
        self.assertEqual(self.task_row(a)["state"],"incomplete_assignee_inputs")
        self.assertEqual(self.task_row(b)["state"],"incomplete_assignee_inputs")
        self.assertEqual(self.forecast()["metrics"]["scheduled_tasks"],0)

    def test_blocked_status_suppresses_confident_forecast(self):
        item=self.task(status="blocked")
        self.capacity(hours=8)
        self.effort(item,8)
        out=self.task_row(item)
        self.assertEqual(out["state"],"blocked_status")
        self.assertIsNone(out["estimated_finish"])

    def test_revoked_worker_receives_no_forecast(self):
        self.enroll()
        item=self.task(assignee=OPERATOR)
        self.capacity(OPERATOR,8)
        self.effort(item,8)
        self.revoke(OPERATOR)
        self.assertEqual(self.task_row(item)["state"],"inactive_assignee")
        self.assertIsNone(self.forecast()["metrics"]["potential_finish"])

    def test_completed_predecessor_needs_no_capacity(self):
        done=self.task(title="Уже готово",assignee=OWNER,status="done")
        self.enroll()
        next_task=self.task(title="Следующий",assignee=OPERATOR)
        self.dependency(next_task,done)
        self.capacity(OPERATOR,8)
        self.effort(next_task,8)
        self.assertEqual(self.task_row(done)["state"],"completed")
        self.assertEqual(self.task_row(next_task)["state"],"scheduled")

    def test_unknown_predecessor_propagates_to_dependent(self):
        self.enroll()
        a=self.task(title="Без оценки",assignee=OWNER)
        b=self.task(title="С оценкой",assignee=OPERATOR)
        self.dependency(b,a)
        self.capacity(OPERATOR,8)
        self.effort(b,8)
        self.assertEqual(self.task_row(b)["state"],"prerequisite_unforecastable")
        self.assertIsNone(self.forecast()["metrics"]["potential_finish"])

    def test_past_due_date_counts_as_risk_not_a_guarantee(self):
        item=self.task(due_date="2001-01-01")
        self.capacity(hours=8)
        self.effort(item,8)
        state=self.task_row(item)
        self.assertGreater(state["variance_calendar_days"],0)
        self.assertEqual(self.forecast()["metrics"]["at_risk_tasks"],1)

    def test_resource_change_recalculates_finish_and_keeps_version(self):
        item=self.task()
        self.capacity(hours=4)
        self.effort(item,16)
        old=self.task_row(item)
        changed=self.capacity(hours=8,version=1)
        new=self.task_row(item)
        self.assertEqual(changed["version"],2)
        self.assertEqual(old["estimated_workdays"],4)
        self.assertEqual(new["estimated_workdays"],2)

    def test_very_large_workload_is_flagged_not_invented(self):
        item=self.task()
        self.capacity(hours=1)
        self.effort(item,2000)
        result=self.forecast()
        self.assertEqual(self.task_row(item)["state"],"beyond_2_year_horizon")
        self.assertIsNone(result["metrics"]["potential_finish"])

    def test_forecast_milestone_risk_comes_from_linked_task(self):
        today=datetime.now(timezone.utc).date()
        task=self.task()
        self.capacity(hours=4)
        self.effort(task,80)
        start=(today-timedelta(days=1)).isoformat()
        end=(today+timedelta(days=30)).isoformat()
        phase=self.runtime.create_delivery_phase(
            **self.scope(),name="Производство",baseline_start=start,
            baseline_end=end,idempotency_key=key())["phase"]
        mile=self.runtime.create_delivery_milestone(
            **self.scope(),phase_id=phase["phase_id"],name="Тесты",
            baseline_due=today.isoformat(),linked_task_id=task["task_id"],
            idempotency_key=key())["milestone"]
        summary=self.forecast()
        exposure=summary["milestone_exposure"][0]
        self.assertEqual(exposure["milestone_id"],mile["milestone_id"])
        self.assertEqual(exposure["state"],"potential_slip")
        self.assertGreater(exposure["potential_slip_days"],0)
        self.assertEqual(summary["metrics"]["at_risk_milestones"],1)

    def test_unlinked_milestones_are_not_claimed_as_project_forecast(self):
        today=datetime.now(timezone.utc).date()
        phase=self.runtime.create_delivery_phase(
            **self.scope(),name="План",baseline_start=today.isoformat(),
            baseline_end=(today+timedelta(days=4)).isoformat(),
            idempotency_key=key())["phase"]
        self.runtime.create_delivery_milestone(
            **self.scope(),phase_id=phase["phase_id"],name="Без задачи",
            baseline_due=today.isoformat(),idempotency_key=key())
        self.assertEqual(self.forecast()["milestone_exposure"],[])

    def test_completed_linked_task_waits_for_explicit_milestone_confirmation(self):
        item=self.task(status="done")
        today=datetime.now(timezone.utc).date()
        phase=self.runtime.create_delivery_phase(
            **self.scope(),name="План",baseline_start=today.isoformat(),
            baseline_end=(today+timedelta(days=2)).isoformat(),
            idempotency_key=key())["phase"]
        self.runtime.create_delivery_milestone(
            **self.scope(),phase_id=phase["phase_id"],name="Проверить факт",
            baseline_due=today.isoformat(),linked_task_id=item["task_id"],
            idempotency_key=key())
        self.assertEqual(self.forecast()["milestone_exposure"][0]["state"],
                         "ready_for_confirmation")


class SafetyTests(Fixture):
    def test_manager_only_access_to_project_estimates_and_capacities(self):
        self.enroll(OPERATOR)
        self.enroll(VIEWER,"viewer")
        for actor in (OPERATOR,VIEWER):
            with self.subTest(actor=actor):
                with self.assertRaises(AppAccessDenied):
                    self.forecast(actor)
                with self.assertRaises(AppAccessDenied):
                    self.runtime.set_forecast_capacity(
                        **self.scope(actor),worker=OWNER,
                        hours_per_day=6,expected_version=0,
                        idempotency_key=key())

    def test_editor_can_set_real_inputs_then_revocation_denies_read_and_replay(self):
        self.enroll(EDITOR,"editor")
        item=self.task()
        token=key()
        request={**self.scope(EDITOR),"task_id":item["task_id"],
                 "effort_hours":10,"expected_version":0,"idempotency_key":token}
        first=self.runtime.set_forecast_effort(**request)
        self.assertEqual(self.runtime.set_forecast_effort(**request),first)
        self.revoke(EDITOR)
        with self.assertRaises(AppAccessDenied):
            self.runtime.set_forecast_effort(**request)
        with self.assertRaises(AppAccessDenied):
            self.forecast(EDITOR)

    def test_capacity_rejects_inactive_or_read_only_member(self):
        self.enroll(OPERATOR)
        self.enroll(VIEWER,"viewer")
        with self.assertRaises(ValueError):
            self.capacity(VIEWER,6)
        self.revoke(OPERATOR)
        with self.assertRaises(ValueError):
            self.capacity(OPERATOR,6)

    def test_bad_numeric_inputs_do_not_change_database(self):
        item=self.task()
        for value in (0,-1,2001,True,1.5,"8",None):
            with self.subTest(value=value):
                with self.assertRaises(ForecastDenied):
                    self.effort(item,value)
        for value in (0,13,False,1.5,"5"):
            with self.subTest(capacity=value):
                with self.assertRaises(ForecastDenied):
                    self.capacity(hours=value)
        self.assertEqual(self.forecast()["efforts"],[])
        self.assertEqual(self.forecast()["capacities"],[])

    def test_stale_input_revision_and_unchanged_value_denied(self):
        item=self.task()
        self.effort(item,6)
        with self.assertRaises(ForecastDenied):
            self.effort(item,12,version=0)
        with self.assertRaises(ForecastDenied):
            self.effort(item,6,version=1)
        self.assertEqual(self.forecast()["efforts"][0]["version"],1)

    def test_idempotent_create_replay_and_key_collision(self):
        item=self.task()
        token=key()
        first=self.effort(item,6,nonce=token)
        self.assertEqual(self.effort(item,6,nonce=token),first)
        with self.assertRaises(ValueError):
            self.effort(item,7,nonce=token)
        self.assertEqual(len(self.forecast()["efforts"]),1)

    def test_wrong_tenant_cannot_mutate_forecast_or_read(self):
        item=self.task()
        with self.assertRaises(AppAccessDenied):
            self.runtime.set_forecast_effort(
                **{**self.scope(),"tenant":"another"},
                task_id=item["task_id"],effort_hours=9,
                expected_version=0,idempotency_key=key())
        with self.assertRaises(AppAccessDenied):
            self.runtime.project_resource_forecast(
                **{**self.scope(),"tenant":"another"})

    def test_foreign_task_effort_rejected_without_orphan_record(self):
        with self.assertRaises(ValueError):
            self.runtime.set_forecast_effort(
                **self.scope(),task_id=str(uuid.uuid4()),
                effort_hours=9,expected_version=0,idempotency_key=key())
        self.assertEqual(self.forecast()["efforts"],[])

    def test_row_digest_tampering_fails_closed(self):
        item=self.task()
        self.effort(item)
        with self.runtime.drafts._db() as db:
            db.execute("UPDATE director_task_effort SET row_digest='forged'")
        with self.assertRaises(ForecastDenied):
            self.forecast()

    def test_capacity_digest_tampering_fails_closed(self):
        self.capacity()
        with self.runtime.drafts._db() as db:
            db.execute("UPDATE director_worker_capacity SET row_digest='fake'")
        with self.assertRaises(ForecastDenied):
            self.forecast()

    def test_immutable_forecast_audit_events_with_hash_validation(self):
        item=self.task()
        self.effort(item)
        self.capacity()
        with self.runtime.drafts._tx() as db:
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE director_forecast_events SET actor='bad'")
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("DELETE FROM director_forecast_events")
        history=self.runtime.project_forecast_history(**self.scope())
        self.assertTrue(history["immutable"])
        self.assertEqual(len(history["events"]),2)
        with self.runtime.drafts._db() as db:
            db.execute("DROP TRIGGER director_forecast_event_no_update")
            db.execute("UPDATE director_forecast_events SET event_digest='wrong'")
        with self.assertRaises(ForecastDenied):
            self.runtime.project_forecast_history(**self.scope())


class HTTPTests(Fixture):
    def send(self,path,data=None,*,method="POST",token=TOKEN,origin=None):
        app=LocalConsole(self.db,tenant=TENANT,project_id=self.project,
                         actor=OWNER,token=TOKEN,port=PORT)
        env={}
        setup_testing_defaults(env)
        raw=json.dumps(data,ensure_ascii=False).encode("utf-8") if data is not None else b""
        env.update({
            "REQUEST_METHOD":method,"PATH_INFO":path,
            "HTTP_HOST":f"127.0.0.1:{PORT}","REMOTE_ADDR":"127.0.0.1",
            "QUERY_STRING":"","HTTP_AUTHORIZATION":"Bearer "+token,
            "CONTENT_TYPE":"application/json","CONTENT_LENGTH":str(len(raw)),
            "wsgi.input":BytesIO(raw),
        })
        if origin:env["HTTP_ORIGIN"]=origin
        status=[]
        payload=b"".join(app(env,lambda code,headers:status.append(code)))
        return status[0],json.loads(payload)

    def test_http_actual_forecast_workflow_and_journal(self):
        item=self.task()
        code,cap=self.send("/api/v1/forecast/capacity",{
            "worker":OWNER,"hours_per_day":8,
            "expected_version":0,"idempotency_key":key()})
        self.assertTrue(code.startswith("200"),(code,cap))
        code,estimate=self.send("/api/v1/forecast/effort",{
            "task_id":item["task_id"],"effort_hours":16,
            "expected_version":0,"idempotency_key":key()})
        self.assertTrue(code.startswith("200"),(code,estimate))
        code,result=self.send("/api/v1/forecast",method="GET")
        self.assertTrue(code.startswith("200"),(code,result))
        self.assertEqual(result["metrics"]["scheduled_tasks"],1)
        self.assertEqual(result["tasks"][0]["estimated_workdays"],2)
        code,hist=self.send("/api/v1/forecast/history",{"limit":10})
        self.assertTrue(code.startswith("200"))
        self.assertEqual(len(hist["events"]),2)

    def test_http_rejects_unauthorized_origin_auth_and_client_identity(self):
        item=self.task()
        body={"task_id":item["task_id"],"effort_hours":6,
              "expected_version":0,"idempotency_key":key()}
        code,_=self.send("/api/v1/forecast/effort",body,token="wrong")
        self.assertTrue(code.startswith("401"))
        code,_=self.send("/api/v1/forecast/effort",body,
                         origin="https://evil.invalid")
        self.assertTrue(code.startswith("403"))
        code,_=self.send("/api/v1/forecast/effort",
                         {**body,"tenant":TENANT,"actor":OWNER})
        self.assertTrue(code.startswith("400"))
        self.assertEqual(self.forecast()["efforts"],[])


if __name__=="__main__":
    unittest.main()
