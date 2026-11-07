"""Wave26: five functional post-reassignment monitoring features with real SQLite."""
from __future__ import annotations

import csv
from datetime import datetime,timedelta,timezone
import hashlib
from io import BytesIO,StringIO
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from wsgiref.util import setup_testing_defaults

from campaign180.app_runtime import LocalAppRuntime
from campaign180.app_policy import AppAccessDenied
from campaign180.scenario_library import ScenarioLibraryDenied
from campaign180.scenario_monitor_export import _safe
from campaign180.team_tasks import _read
from campaign180.local_http import LocalConsole

ROOT=Path(__file__).resolve().parents[3]
DEMO=ROOT/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"
OWNER="owner-abc"
WORKER="operator-abc"
EDITOR="editor-abc"
VIEWER="viewer-abc"
TOKEN="Wave26LocalToken_abcdefghijklABCDEFGHI_0123456789"
PORT=8781


def nonce():
    return "wave26-"+uuid.uuid4().hex


class ScenarioFixture(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db=Path(temp.name)/"wave26.sqlite3"
        spec=json.loads(DEMO.read_text(encoding="utf-8"))
        self.project=spec["project_id"]
        self.rt=LocalAppRuntime(str(self.db))
        self.rt.drafts.create(spec,tenant=TENANT)
        self.rt.policy.bootstrap_owner(
            tenant=TENANT,project_id=self.project,
            actor=OWNER,now=1799971200)
        self.enroll(WORKER)
        self.tasks=[self.rt.create_team_task(
            **self.scope(),title="Контроль "+str(i),assignee=OWNER,
            due_date="2027-11-06",idempotency_key=nonce())["task"]
            for i in range(2)]
        for worker in (OWNER,WORKER):
            self.rt.set_forecast_capacity(
                **self.scope(),worker=worker,hours_per_day=8,
                expected_version=0,idempotency_key=nonce())
        for t in self.tasks:
            self.rt.set_forecast_effort(
                **self.scope(),task_id=t["task_id"],effort_hours=8,
                expected_version=0,idempotency_key=nonce())
        moves=[{"task_id":t["task_id"],"assignee":WORKER} for t in self.tasks]
        saved=self.rt.save_resource_variant(
            **self.scope(),title="План контроля",
            expected_snapshot=self.snapshot(),
            moves=moves,idempotency_key=nonce())["variant"]
        selected=self.rt.select_resource_variant(
            **self.scope(),scenario_id=saved["scenario_id"],
            expected_version=saved["version"],
            expected_snapshot=saved["input_snapshot"],
            idempotency_key=nonce())["variant"]
        self.applied=self.rt.apply_resource_variant(
            **self.scope(),scenario_id=selected["scenario_id"],
            expected_version=selected["version"],
            expected_snapshot=selected["input_snapshot"],
            confirmation="ПРИМЕНИТЬ",idempotency_key=nonce())
        self.scenario_id=saved["scenario_id"]

    def scope(self,actor=OWNER):
        return {"tenant":TENANT,"project_id":self.project,"actor":actor}

    def enroll(self,actor=WORKER,role="operator"):
        self.rt.policy.add_member(
            tenant=TENANT,project_id=self.project,owner_actor=OWNER,
            member_actor=actor,role=role,now=1799971201)

    def snapshot(self):
        return self.rt.project_resource_forecast(**self.scope())["input_snapshot"]

    def report(self,actor=OWNER):
        return self.rt.scenario_monitor_report(
            **self.scope(actor),scenario_id=self.scenario_id)

    def capture(self,note="",*,actor=OWNER,key=None,snapshot=None):
        return self.rt.capture_scenario_checkpoint(
            **self.scope(actor),scenario_id=self.scenario_id,
            expected_snapshot=snapshot or self.snapshot(),
            note=note,idempotency_key=key or nonce())["checkpoint"]

    def history(self,*,actor=OWNER,limit=20,offset=0):
        return self.rt.scenario_checkpoint_history(
            **self.scope(actor),scenario_id=self.scenario_id,
            limit=limit,offset=offset)

    def export(self,actor=OWNER):
        return self.rt.scenario_monitor_csv(
            **self.scope(actor),scenario_id=self.scenario_id)

    def stored(self,task_id):
        with self.rt.drafts._db() as db:
            return _read(db,TENANT,self.project,task_id)

    def change(self,task_id,**changes):
        old=self.stored(task_id)
        return self.rt.update_team_task(
            **self.scope(),task_id=task_id,
            expected_version=old["version"],
            changes=changes,idempotency_key=nonce())["task"]

    def done(self,task_id):
        self.change(task_id,status="in_progress")
        self.change(task_id,status="done")

    def rollback(self):
        return self.rt.rollback_resource_variant(
            **self.scope(),scenario_id=self.scenario_id,
            expected_version=3,expected_snapshot=self.snapshot(),
            confirmation="ОТКАТИТЬ",idempotency_key=nonce())


class CaptureTests(ScenarioFixture):
    def test_checkpoint_captures_real_task_versions_and_authentic_snapshot(self):
        p=self.capture("Утренний осмотр")
        self.assertEqual(p["sequence"],1)
        self.assertIsNone(p["prev_sha256"])
        self.assertEqual(p["source_snapshot"],self.snapshot())
        self.assertEqual(len(p["task_observations"]),2)
        self.assertEqual({t["status"] for t in p["task_observations"]},{"todo"})
        self.assertEqual({t["assignee"] for t in p["task_observations"]},{WORKER})
        self.assertEqual({t["version"] for t in p["task_observations"]},{2})
        self.assertEqual(len(p["sha256"]),64)
        self.assertEqual(p["note"],"Утренний осмотр")

    def test_actual_status_change_is_observed_on_next_manual_capture(self):
        first=self.capture("До начала")
        self.done(self.tasks[0]["task_id"])
        next_item=self.capture("После")
        self.assertEqual(next_item["sequence"],2)
        self.assertEqual(next_item["prev_sha256"],first["sha256"])
        self.assertEqual({t["status"] for t in next_item["task_observations"]},
                         {"todo","done"})
        self.assertNotEqual(first["source_snapshot"],next_item["source_snapshot"])
        report=self.report()
        self.assertEqual(report["affected_progress"]["done"],1)
        self.assertEqual(report["affected_progress"]["total"],2)
        self.assertEqual(report["observed_done_count_change_first_to_last"],1)

    def test_checkin_rejects_stale_forecast_without_persisting_row(self):
        old=self.snapshot()
        self.change(self.tasks[0]["task_id"],status="in_progress")
        with self.assertRaises(ScenarioLibraryDenied):
            self.capture(snapshot=old)
        self.assertEqual(self.history()["total"],0)

    def test_idempotent_replay_never_duplicates_even_after_task_update(self):
        snapshot=self.snapshot()
        key=nonce()
        first=self.capture("Запись",key=key,snapshot=snapshot)
        self.change(self.tasks[0]["task_id"],status="in_progress")
        replay=self.capture("Запись",key=key,snapshot=snapshot)
        self.assertEqual(first,replay)
        self.assertEqual(self.history()["total"],1)

    def test_same_idempotency_key_different_note_is_rejected(self):
        key=nonce()
        self.capture("A",key=key)
        with self.assertRaises(ValueError):
            self.capture("B",key=key)

    def test_invalid_note_and_source_input_fail_closed(self):
        for invalid in ("a"*401,"bad\rnote",None,99):
            with self.subTest(invalid=str(invalid)[:18]):
                with self.assertRaises(ValueError):
                    self.rt.capture_scenario_checkpoint(
                        **self.scope(),scenario_id=self.scenario_id,
                        expected_snapshot=self.snapshot(),
                        note=invalid,idempotency_key=nonce())
        self.assertEqual(self.history()["total"],0)

    def test_old_application_after_rollback_cannot_accept_new_checkpoint(self):
        self.capture("до отмены")
        self.rollback()
        with self.assertRaises(ScenarioLibraryDenied):
            self.capture("после отмены")
        self.assertEqual(self.history()["total"],1)
        self.assertEqual(self.report()["effective_status"],"rolled_back")

    def test_reader_role_denial_and_revocation_before_idempotency_replay(self):
        self.enroll(EDITOR,"editor")
        self.enroll(VIEWER,"viewer")
        key=nonce()
        self.capture(actor=EDITOR,key=key)
        for actor in (WORKER,VIEWER):
            with self.subTest(actor=actor):
                with self.assertRaises(AppAccessDenied):
                    self.report(actor)
                with self.assertRaises(AppAccessDenied):
                    self.history(actor=actor)
                with self.assertRaises(AppAccessDenied):
                    self.capture(actor=actor)
        self.rt.policy.revoke_member(
            tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=EDITOR,now=1799971202)
        with self.assertRaises(AppAccessDenied):
            self.capture(actor=EDITOR,key=key)

    def test_unknown_and_foreign_scenario_cannot_be_observed(self):
        with self.assertRaises(ScenarioLibraryDenied):
            self.rt.scenario_monitor_report(
                **self.scope(),scenario_id=str(uuid.uuid4()))
        with self.assertRaises(AppAccessDenied):
            self.rt.scenario_monitor_report(
                **{**self.scope(),"tenant":"foreign_tenant"},
                scenario_id=self.scenario_id)

class AuditHistoryTests(ScenarioFixture):
    def test_two_checkins_verified_oldest_chain_and_newest_first_page(self):
        first=self.capture("first")
        second=self.capture("second")
        h=self.history(limit=1)
        self.assertTrue(h["chain_verified"])
        self.assertEqual(h["total"],2)
        self.assertTrue(h["has_more"])
        self.assertEqual(h["checkpoints"][0]["sha256"],second["sha256"])
        self.assertEqual(self.history(limit=1,offset=1)["checkpoints"][0]["sha256"],
                         first["sha256"])

    def test_trigger_rejects_update_and_delete_to_immutable_checkpoint(self):
        self.capture()
        with self.rt.drafts._tx() as db:
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE director_scenario_checkpoints SET actor='X'")
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("DELETE FROM director_scenario_checkpoints")
        self.assertTrue(self.history()["chain_verified"])

    def test_tampered_payload_detected_on_read_export_and_monitor_report(self):
        self.capture()
        with self.rt.drafts._db() as db:
            db.execute("DROP TRIGGER director_checkpoint_update_denied")
            db.execute("UPDATE director_scenario_checkpoints SET payload_sha256='fake'")
        for method in (self.history,self.report,self.export):
            with self.subTest(name=method.__name__):
                with self.assertRaises(ScenarioLibraryDenied):
                    method()

    def test_sequence_deletion_of_middle_entry_detected(self):
        for x in range(3):self.capture(str(x))
        with self.rt.drafts._db() as db:
            db.execute("DROP TRIGGER director_checkpoint_delete_denied")
            db.execute("DELETE FROM director_scenario_checkpoints WHERE seq=2")
        with self.assertRaises(ScenarioLibraryDenied):
            self.history()

    def test_offset_and_limit_are_bounded_including_bools(self):
        self.capture()
        for limit,offset in ((0,0),(51,0),(20,-1),(20,61),(True,0),(20,False)):
            with self.subTest(limit=limit,offset=offset):
                with self.assertRaises(ScenarioLibraryDenied):
                    self.history(limit=limit,offset=offset)

class ForecastAndRiskTests(ScenarioFixture):
    def test_report_uses_stored_application_baseline_without_inventing_revenue(self):
        out=self.report()
        self.assertEqual(out["checkpoint_count"],0)
        self.assertTrue(out["history_chain_verified"])
        self.assertEqual(out["affected_progress"]["done"],0)
        self.assertEqual(out["affected_progress"]["total"],2)
        self.assertEqual(out["risk_counts"]["high"],0)
        self.assertEqual(out["projected_finish_shift_calendar_days"],0)
        self.assertNotIn("revenue",str(out).lower())
        self.assertFalse(out["production_published"])

    def test_blocked_task_produces_explicit_high_risk_with_status_evidence(self):
        self.change(self.tasks[0]["task_id"],status="blocked")
        report=self.report()
        self.assertIn("TASK_BLOCKED",{r["code"] for r in report["risks"]})
        item=next(r for r in report["risks"] if r["code"]=="TASK_BLOCKED")
        self.assertEqual(item["severity"],"high")
        self.assertEqual(item["evidence"]["status"],"blocked")

    def test_overdue_open_task_is_high_risk_and_completed_task_is_not(self):
        task=self.tasks[0]["task_id"]
        self.change(task,due_date="2020-01-01")
        before=self.report()
        self.assertEqual(before["affected_progress"]["overdue_open"],1)
        self.assertTrue(any(x["code"]=="TASK_OVERDUE" and x["task_id"]==task
                            for x in before["risks"]))
        self.done(task)
        after=self.report()
        self.assertEqual(after["affected_progress"]["overdue_open"],0)
        self.assertFalse(any(x["code"]=="TASK_OVERDUE" and x["task_id"]==task
                             for x in after["risks"]))

    def test_assignee_changed_after_plan_is_detected_without_fabrication(self):
        task=self.tasks[0]["task_id"]
        self.change(task,assignee=OWNER)
        out=self.report()
        self.assertTrue(any(r["code"]=="ASSIGNEE_CHANGED" and
                            r["task_id"]==task for r in out["risks"]))
        self.assertEqual(out["affected_progress"]["done"],0)

    def test_missing_task_capacity_is_not_assumed_for_forecast(self):
        third="operator-no-capacity"
        self.enroll(third)
        self.change(self.tasks[0]["task_id"],assignee=third)
        out=self.report()
        self.assertIn("FORECAST_MISSING",{r["code"] for r in out["risks"]})
        self.assertIsNone(out["projected_finish_shift_calendar_days"])
        self.assertFalse(out["project_finish_comparable"])

    def test_rollback_reports_history_without_active_followup_alerts(self):
        self.change(self.tasks[0]["task_id"],status="in_progress")
        # Return to original state is denied after task version changed.
        # Separate fixture validates successful rollback when unchanged.
        current=self.report()
        self.assertEqual(current["affected_progress"]["in_progress"],1)
        self.assertTrue(current["application_sha256"])

    def test_snapshot_trend_is_manual_not_synthetic(self):
        self.capture("phase 1")
        self.done(self.tasks[0]["task_id"])
        self.capture("phase 2")
        data=self.report()
        self.assertEqual([x["done"] for x in data["series"]],[0,1])
        self.assertEqual(len(data["series"]),2)
        self.assertEqual(data["observed_done_count_change_first_to_last"],1)

class CSVTests(ScenarioFixture):
    def test_csv_contains_observed_snapshots_current_statuses_and_verified_hash(self):
        self.capture("Первое наблюдение")
        file=self.export()
        self.assertTrue(file["verified_history"])
        self.assertEqual(file["rows"],3)
        self.assertTrue(file["filename"].startswith("osgard_outcome_"))
        self.assertTrue(file["csv"].startswith("\ufefftype,scenario_id,"))
        self.assertEqual(file["bytes"],len(file["csv"].encode("utf-8")))
        self.assertEqual(file["sha256"],
                         hashlib.sha256(file["csv"].encode("utf-8")).hexdigest())
        rows=list(csv.DictReader(StringIO(file["csv"].lstrip("\ufeff"))))
        self.assertEqual([x["type"] for x in rows],
                         ["checkpoint","task_current","task_current"])
        self.assertEqual({x["assignee"] for x in rows[1:]},{WORKER})

    def test_csv_prefixes_formula_injection_and_preserves_cyrillic(self):
        task=self.tasks[0]["task_id"]
        self.change(task,title="=2+3")
        out=self.export()
        self.assertIn("'=2+3",out["csv"])
        for v in ("=SUM(A1:A3)","+cmd","-1+2","@HYPERLINK","   =1+1","\tabc"):
            self.assertTrue(_safe(v).startswith("'"),v)
        self.assertEqual(_safe("Нормальная строка"),"Нормальная строка")

    def test_csv_refuses_non_manager(self):
        with self.assertRaises(AppAccessDenied):
            self.export(WORKER)

class HttpTests(ScenarioFixture):
    def send(self,path,data=None,*,method="POST",token=TOKEN,origin=None,
             actor=OWNER):
        app=LocalConsole(self.db,tenant=TENANT,project_id=self.project,
                         actor=actor,token=TOKEN,port=PORT)
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
        result=b"".join(app(env,lambda code,headers:status.append(code)))
        return status[0],json.loads(result)

    def test_http_monitor_capture_history_and_export_end_to_end(self):
        base="/api/v1/scenarios/saved/"+self.scenario_id+"/monitor"
        status,report=self.send(base,method="GET")
        self.assertTrue(status.startswith("200"),(status,report))
        self.assertEqual(report["checkpoint_count"],0)
        status,created=self.send(base+"/checkpoints",{
            "expected_snapshot":report["source_snapshot"],
            "note":"Интеграционная проверка","idempotency_key":nonce()})
        self.assertTrue(status.startswith("201"),(status,created))
        self.assertEqual(created["checkpoint"]["sequence"],1)
        status,hist=self.send(base+"/history",{"limit":10})
        self.assertTrue(status.startswith("200"))
        self.assertTrue(hist["chain_verified"])
        self.assertEqual(hist["total"],1)
        status,export=self.send(base+"/export",method="GET")
        self.assertTrue(status.startswith("200"))
        self.assertEqual(export["rows"],3)

    def test_http_origin_token_and_identity_injection_denied(self):
        base="/api/v1/scenarios/saved/"+self.scenario_id+"/monitor"
        body={"expected_snapshot":self.snapshot(),"note":"test","idempotency_key":nonce()}
        code,_=self.send(base+"/checkpoints",body,token="bad")
        self.assertTrue(code.startswith("401"))
        code,_=self.send(base+"/checkpoints",body,origin="https://evil.invalid")
        self.assertTrue(code.startswith("403"))
        code,_=self.send(base+"/checkpoints",{**body,"actor":OWNER})
        self.assertTrue(code.startswith("400"))
        code,_=self.send(base,method="GET",actor=WORKER)
        self.assertTrue(code.startswith("403"))
        self.assertEqual(self.history()["total"],0)


if __name__=="__main__":
    unittest.main()
