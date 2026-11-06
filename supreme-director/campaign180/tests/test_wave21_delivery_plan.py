"""Wave 21 acceptance: immutable delivery baselines, actuals and schedule variance."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
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
from campaign180.delivery_plan import DeliveryDenied
from campaign180.local_http import LocalConsole

ROOT = Path(__file__).resolve().parents[3]
DEMO = ROOT / "supreme-director/campaign180/examples/demo-site.json"
TENANT = "tenant_demo"
OWNER = "owner-abc"
EDITOR = "editor-abc"
OPERATOR = "operator-abc"
VIEWER = "viewer-abc"
TOKEN = "W21_LocalToken_abcdefghABCDEFGHIJ_0123456789_XYZ"
PORT = 8776


def nonce():
    return "wave21-" + uuid.uuid4().hex


def dates():
    now = datetime.now(timezone.utc).date()
    return (now-timedelta(days=10)).isoformat(), (now+timedelta(days=10)).isoformat()


class Fixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db = Path(temp.name) / "delivery.sqlite3"
        spec = json.loads(DEMO.read_text(encoding="utf-8"))
        self.project = spec["project_id"]
        self.runtime = LocalAppRuntime(str(self.db))
        self.runtime.drafts.create(spec, tenant=TENANT)
        self.runtime.policy.bootstrap_owner(
            tenant=TENANT, project_id=self.project,
            actor=OWNER, now=1799971200)

    def scope(self, actor=OWNER, **extra):
        return {"tenant": TENANT, "project_id": self.project,
                "actor": actor, **extra}

    def enroll(self, actor, role="operator"):
        return self.runtime.policy.add_member(
            tenant=TENANT, project_id=self.project,
            owner_actor=OWNER, member_actor=actor,
            role=role, now=1799971201)

    def revoke(self, actor):
        return self.runtime.policy.revoke_member(
            tenant=TENANT, project_id=self.project, owner_actor=OWNER,
            member_actor=actor, now=1799971202)

    def phase(self, **kw):
        start, end = dates()
        return self.runtime.create_delivery_phase(
            **self.scope(), name=kw.get("name", "Проектирование"),
            baseline_start=kw.get("baseline_start", start),
            baseline_end=kw.get("baseline_end", end),
            idempotency_key=kw.get("idempotency_key", nonce()))["phase"]

    def milestone(self, phase, **kw):
        return self.runtime.create_delivery_milestone(
            **self.scope(), phase_id=phase["phase_id"],
            name=kw.get("name", "Согласовано"),
            baseline_due=kw.get("baseline_due", datetime.now(timezone.utc).date().isoformat()),
            linked_task_id=kw.get("linked_task_id"),
            idempotency_key=kw.get("idempotency_key", nonce()))["milestone"]

    def forecast_phase(self, phase, value, **kw):
        return self.runtime.revise_delivery_phase(
            **self.scope(), phase_id=phase["phase_id"],
            expected_version=phase["version"], forecast_end=value,
            idempotency_key=kw.get("idempotency_key", nonce()))

    def change(self, milestone, action, value, **kw):
        return self.runtime.change_delivery_milestone(
            **self.scope(), milestone_id=milestone["milestone_id"],
            expected_version=milestone["version"],
            operation=action, value=value,
            idempotency_key=kw.get("idempotency_key", nonce()))

    def report(self, actor=OWNER):
        return self.runtime.delivery_schedule(**self.scope(actor))

    def task(self, name="Связанная работа"):
        return self.runtime.create_team_task(
            **self.scope(), title=name,idempotency_key=nonce())["task"]

    def task_status(self, task, status, *, actor=OWNER):
        return self.runtime.update_team_task(
            **self.scope(actor), task_id=task["task_id"],
            expected_version=task["version"],
            changes={"status":status},idempotency_key=nonce())["task"]


class PhasesTests(Fixture):
    def test_phase_is_persisted_with_immutable_baseline_dates(self):
        created = self.phase()
        result = self.report()
        self.assertEqual(result["metrics"]["phases"], 1)
        self.assertEqual(result["phases"][0]["baseline_end"], created["baseline_end"])
        self.assertEqual(result["phases"][0]["forecast_end"], created["baseline_end"])
        self.assertEqual(result["phases"][0]["version"], 1)
        self.assertTrue(result["baseline_immutable"])
        self.assertFalse(result["production_published"])

    def test_phase_forecast_revision_preserves_baseline_and_reports_delta(self):
        created = self.phase()
        extended = (datetime.fromisoformat(created["baseline_end"])
                    + timedelta(days=8)).date().isoformat()
        updated = self.forecast_phase(created, extended)
        self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["forecast_slip_days"], 8)
        stored = self.report()["phases"][0]
        self.assertEqual(stored["baseline_end"], created["baseline_end"])
        self.assertEqual(stored["forecast_end"], extended)
        self.assertEqual(stored["variance_days"], 8)
        self.assertEqual(self.report()["metrics"]["phases_slipping"], 1)

    def test_stale_phase_revision_and_noop_rejected(self):
        created = self.phase()
        new_date = (datetime.fromisoformat(created["baseline_end"])
                    + timedelta(days=5)).date().isoformat()
        self.forecast_phase(created, new_date)
        with self.assertRaises(DeliveryDenied):
            self.forecast_phase(created, created["baseline_end"])
        current = {**created, "version":2}
        with self.assertRaises(DeliveryDenied):
            self.forecast_phase(current, new_date)
        self.assertEqual(self.report()["phases"][0]["version"], 2)

    def test_phase_create_idempotent_and_collision_detected(self):
        key = nonce()
        first = self.phase(name="Одна версия", idempotency_key=key)
        same = self.phase(name="Одна версия", idempotency_key=key)
        self.assertEqual(first, same)
        with self.assertRaises(ValueError):
            self.phase(name="Другой запрос", idempotency_key=key)
        self.assertEqual(self.report()["metrics"]["phases"], 1)

    def test_phase_reforecast_idempotent_version_replay(self):
        first = self.phase()
        day = first["baseline_end"]
        new = (datetime.fromisoformat(day)+timedelta(days=2)).date().isoformat()
        key = nonce()
        a = self.forecast_phase(first, new, idempotency_key=key)
        b = self.forecast_phase(first, new, idempotency_key=key)
        self.assertEqual(a,b)
        with self.assertRaises(ValueError):
            self.forecast_phase(first, day, idempotency_key=key)

    def test_invalid_phase_baselines_and_date_boundaries(self):
        start, end = dates()
        for values in (
            {"name": ""}, {"name": "X"*101},
            {"baseline_start": end, "baseline_end": start},
            {"baseline_start": "2026-02-30"},
            {"baseline_end": "1900-01-01"},
            {"baseline_start": "not-date"},
        ):
            with self.subTest(values=values):
                with self.assertRaises(ValueError):
                    self.phase(**values)
        self.assertEqual(self.report()["metrics"]["phases"],0)

    def test_manager_only_phase_reads_writes_and_revocation(self):
        self.enroll(EDITOR,"editor")
        self.enroll(OPERATOR)
        self.enroll(VIEWER,"viewer")
        first = self.phase()
        for actor in (OPERATOR,VIEWER):
            with self.subTest(actor=actor):
                with self.assertRaises(AppAccessDenied):
                    self.report(actor=actor)
                with self.assertRaises(AppAccessDenied):
                    self.runtime.create_delivery_phase(
                        **self.scope(actor),name="Not allowed",
                        baseline_start=dates()[0],
                        baseline_end=dates()[1],
                        idempotency_key=nonce())
        allowed = self.runtime.create_delivery_phase(
            **self.scope(EDITOR),name="Редактор",
            baseline_start=dates()[0], baseline_end=dates()[1],
            idempotency_key=nonce())
        self.assertEqual(allowed["phase"]["name"],"Редактор")
        self.revoke(EDITOR)
        with self.assertRaises(AppAccessDenied):
            self.runtime.delivery_schedule(**self.scope(EDITOR))
        self.assertEqual(len(self.report()["phases"]),2)

    def test_phase_mutation_is_scoped_by_tenant_and_project(self):
        first = self.phase()
        with self.assertRaises(AppAccessDenied):
            self.runtime.revise_delivery_phase(
                **{**self.scope(),"tenant":"other_tenant"},
                phase_id=first["phase_id"],
                expected_version=1,forecast_end=first["baseline_end"],
                idempotency_key=nonce())
        with self.assertRaises(DeliveryDenied):
            self.runtime.revise_delivery_phase(
                **self.scope(),phase_id=str(uuid.uuid4()),
                expected_version=1,forecast_end=first["baseline_end"],
                idempotency_key=nonce())

    def test_phase_data_tampering_fails_closed(self):
        self.phase()
        with self.runtime.drafts._db() as db:
            db.execute("UPDATE director_delivery_phases SET baseline_end='2001-01-01'")
        with self.assertRaises(DeliveryDenied):
            self.report()


class MilestoneTests(Fixture):
    def test_milestone_progress_and_baseline_are_real_sqlite_data(self):
        phase = self.phase()
        item = self.milestone(phase)
        report = self.report()
        self.assertEqual(report["metrics"]["milestones"],1)
        self.assertEqual(report["metrics"]["milestones_done"],0)
        self.assertEqual(report["phases"][0]["progress_percent"],0)
        self.assertEqual(report["milestones"][0]["baseline_due"],item["baseline_due"])

    def test_milestone_baseline_must_fall_in_phase_dates(self):
        phase = self.phase()
        for due in ("2001-01-01","2099-01-01","2026-02-30"):
            with self.subTest(due=due):
                with self.assertRaises(ValueError):
                    self.milestone(phase,baseline_due=due)
        self.assertEqual(self.report()["metrics"]["milestones"],0)

    def test_forecast_revision_preserves_baseline_and_checks_version(self):
        phase = self.phase()
        item = self.milestone(phase)
        later=(datetime.fromisoformat(item["baseline_due"])+
               timedelta(days=3)).date().isoformat()
        first=self.change(item,"forecast",later)
        self.assertEqual(first["variance_days"],3)
        self.assertEqual(first["version"],2)
        with self.assertRaises(DeliveryDenied):
            self.change(item,"forecast",item["baseline_due"])
        result=self.report()["milestones"][0]
        self.assertEqual(result["baseline_due"],item["baseline_due"])
        self.assertEqual(result["forecast_due"],later)
        self.assertEqual(self.report()["metrics"]["milestones_forecast_slipping"],1)

    def test_completed_on_is_actual_and_frozen(self):
        phase=self.phase()
        item=self.milestone(phase)
        today=datetime.now(timezone.utc).date().isoformat()
        actual=self.change(item,"complete",today)
        self.assertEqual(actual["completed_on"],today)
        report=self.report()
        self.assertEqual(report["metrics"]["milestones_done"],1)
        self.assertEqual(report["phases"][0]["status"],"completed")
        self.assertEqual(report["phases"][0]["actual_end"],today)
        self.assertEqual(report["phases"][0]["progress_percent"],100)
        fresh={**item,"version":2}
        with self.assertRaises(DeliveryDenied):
            self.change(fresh,"forecast",dates()[1])
        with self.assertRaises(DeliveryDenied):
            self.change(fresh,"complete",today)

    def test_mark_complete_in_future_is_denied(self):
        phase=self.phase()
        item=self.milestone(phase)
        future=(datetime.now(timezone.utc).date()+timedelta(days=1)).isoformat()
        with self.assertRaises(DeliveryDenied):
            self.change(item,"complete",future)
        self.assertIsNone(self.report()["milestones"][0]["completed_on"])

    def test_linked_task_must_be_done_before_completing_milestone(self):
        phase=self.phase()
        task=self.task()
        item=self.milestone(phase,linked_task_id=task["task_id"])
        today=datetime.now(timezone.utc).date().isoformat()
        with self.assertRaises(DeliveryDenied):
            self.change(item,"complete",today)
        self.assertEqual(self.report()["metrics"]["milestones_done"],0)
        done=self.task_status(task,"done")
        self.change(item,"complete",today)
        with self.assertRaises(DeliveryDenied):
            self.task_status(done,"todo")
        self.assertEqual(self.report()["metrics"]["milestones_done"],1)

    def test_task_can_reopen_when_linked_milestone_not_completed(self):
        phase=self.phase()
        task=self.task()
        self.milestone(phase,linked_task_id=task["task_id"])
        completed=self.task_status(task,"done")
        reopened=self.task_status(completed,"todo")
        self.assertEqual(reopened["status"],"todo")

    def test_foreign_linked_task_is_rejected_before_write(self):
        phase=self.phase()
        with self.assertRaises(DeliveryDenied):
            self.milestone(phase,linked_task_id=str(uuid.uuid4()))
        self.assertEqual(self.report()["metrics"]["milestones"],0)

    def test_milestone_create_replay_and_changed_request_collision(self):
        phase=self.phase()
        key=nonce()
        a=self.milestone(phase,idempotency_key=key)
        b=self.milestone(phase,idempotency_key=key)
        self.assertEqual(a,b)
        with self.assertRaises(ValueError):
            self.milestone(phase,name="Different",idempotency_key=key)
        self.assertEqual(self.report()["metrics"]["milestones"],1)

    def test_completion_replay_same_version_returns_original_receipt(self):
        phase=self.phase()
        item=self.milestone(phase)
        key=nonce()
        today=datetime.now(timezone.utc).date().isoformat()
        a=self.change(item,"complete",today,idempotency_key=key)
        b=self.change(item,"complete",today,idempotency_key=key)
        self.assertEqual(a,b)
        self.assertEqual(self.report()["metrics"]["milestones_done"],1)

    def test_slippage_and_late_completion_count_distinctly(self):
        phase=self.phase()
        start=datetime.now(timezone.utc).date()
        delayed=(start-timedelta(days=2)).isoformat()
        item=self.milestone(phase,baseline_due=delayed)
        forecast=self.change(item,"forecast",(start+timedelta(days=2)).isoformat())
        metrics=self.report()["metrics"]
        self.assertEqual(metrics["milestones_forecast_slipping"],1)
        self.assertEqual(metrics["milestones_overdue_open"],0)
        item={**item,"version":forecast["version"]}
        self.change(item,"complete",start.isoformat())
        metrics=self.report()["metrics"]
        self.assertEqual(metrics["milestones_completed_late"],1)
        self.assertEqual(metrics["milestones_forecast_slipping"],0)

    def test_corrupted_milestone_digest_fails_closed(self):
        phase=self.phase()
        self.milestone(phase)
        with self.runtime.drafts._db() as db:
            db.execute("UPDATE director_delivery_milestones SET row_digest='forged'")
        with self.assertRaises(DeliveryDenied):
            self.report()

    def test_journal_is_append_only_integrity_verified(self):
        phase=self.phase()
        item=self.milestone(phase)
        now=datetime.now(timezone.utc).date().isoformat()
        self.change(item,"complete",now)
        with self.runtime.drafts._tx() as db:
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE director_delivery_events SET actor='bad'")
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("DELETE FROM director_delivery_events")
        history=self.runtime.delivery_event_history(
            **self.scope(),entity_id=item["milestone_id"])
        self.assertEqual(len(history["events"]),2)
        self.assertTrue(history["immutable"])
        self.assertEqual(len(history["events"][0]["sha256"]),64)

    def test_corrupted_audit_event_fails_closed(self):
        phase=self.phase()
        with self.runtime.drafts._db() as db:
            db.execute("DROP TRIGGER director_delivery_events_no_update")
            db.execute("UPDATE director_delivery_events SET event_digest='bad'")
        with self.assertRaises(DeliveryDenied):
            self.runtime.delivery_event_history(
                **self.scope(),entity_id=phase["phase_id"])


class HTTPTests(Fixture):
    def send(self, path, data=None, *, method="POST",token=TOKEN,origin=None):
        app=LocalConsole(self.db,tenant=TENANT,project_id=self.project,
                         actor=OWNER,token=TOKEN,port=PORT)
        env={}
        setup_testing_defaults(env)
        raw=json.dumps(data,ensure_ascii=False).encode() if data is not None else b""
        env.update({
            "REQUEST_METHOD":method,"PATH_INFO":path,
            "HTTP_HOST":f"127.0.0.1:{PORT}","REMOTE_ADDR":"127.0.0.1",
            "QUERY_STRING":"","HTTP_AUTHORIZATION":"Bearer "+token,
            "CONTENT_TYPE":"application/json","CONTENT_LENGTH":str(len(raw)),
            "wsgi.input":BytesIO(raw),
        })
        if origin:env["HTTP_ORIGIN"]=origin
        status=[]
        reply=b"".join(app(env,lambda code,headers:status.append(code)))
        return status[0],json.loads(reply)

    def test_http_create_phase_milestone_forecast_completion_and_audit(self):
        start,end=dates()
        code,phase_reply=self.send("/api/v1/delivery/phases",{
            "name":"Мобильное приложение","baseline_start":start,
            "baseline_end":end,"idempotency_key":nonce()})
        self.assertTrue(code.startswith("201"),(code,phase_reply))
        phase=phase_reply["phase"]
        code,mile_reply=self.send(
            "/api/v1/delivery/phases/"+phase["phase_id"]+"/milestones",{
            "name":"Проверка готовности",
            "baseline_due":datetime.now(timezone.utc).date().isoformat(),
            "idempotency_key":nonce()})
        self.assertTrue(code.startswith("201"),(code,mile_reply))
        mile=mile_reply["milestone"]
        tomorrow=(datetime.now(timezone.utc).date()+timedelta(days=1)).isoformat()
        code,updated=self.send(
            "/api/v1/delivery/milestones/"+mile["milestone_id"],{
                "expected_version":1,"operation":"forecast",
                "value":tomorrow,"idempotency_key":nonce()},method="PATCH")
        self.assertTrue(code.startswith("200"),(code,updated))
        code,actual=self.send(
            "/api/v1/delivery/milestones/"+mile["milestone_id"],{
                "expected_version":2,"operation":"complete",
                "value":datetime.now(timezone.utc).date().isoformat(),
                "idempotency_key":nonce()},method="PATCH")
        self.assertTrue(code.startswith("200"),(code,actual))
        code,schedule=self.send("/api/v1/delivery",method="GET")
        self.assertTrue(code.startswith("200"))
        self.assertEqual(schedule["metrics"]["milestones_done"],1)
        self.assertEqual(schedule["milestones"][0]["baseline_due"],mile["baseline_due"])
        code,history=self.send("/api/v1/delivery/"+mile["milestone_id"]+"/history",{
            "limit":30})
        self.assertTrue(code.startswith("200"))
        self.assertEqual(len(history["events"]),3)

    def test_http_rejects_token_cross_origin_and_spoofed_tenant(self):
        start,end=dates()
        payload={"name":"Test","baseline_start":start,
                 "baseline_end":end,"idempotency_key":nonce()}
        path="/api/v1/delivery/phases"
        code,_=self.send(path,payload,token="wrong")
        self.assertTrue(code.startswith("401"))
        code,_=self.send(path,payload,origin="https://evil.invalid")
        self.assertTrue(code.startswith("403"))
        code,_=self.send(path,{**payload,"tenant":TENANT,"actor":OWNER})
        self.assertTrue(code.startswith("400"))
        self.assertEqual(self.report()["metrics"]["phases"],0)


if __name__=="__main__":
    unittest.main()
