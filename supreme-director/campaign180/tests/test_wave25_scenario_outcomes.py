"""Wave 25 acceptance: immutable applied outcomes and transactional assignment rollback."""
from __future__ import annotations

from datetime import date,datetime,timedelta,timezone
from io import BytesIO
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from unittest.mock import patch
from wsgiref.util import setup_testing_defaults

from campaign180.app_runtime import LocalAppRuntime
from campaign180.app_policy import AppAccessDenied
from campaign180.scenario_library import ScenarioLibraryDenied
from campaign180.local_http import LocalConsole

ROOT=Path(__file__).resolve().parents[3]
DEMO=ROOT/"supreme-director/campaign180/examples/demo-site.json"
TENANT="tenant_demo"
OWNER="owner-abc"
WORKER="operator-abc"
ALTERNATE="operator-def"
EDITOR="editor-abc"
VIEWER="viewer-abc"
TOKEN="Wave25LocalToken_abcdefghABCDEFGHIJKL_0123456789"
PORT=8780


def nonce():
    return "wave25-"+uuid.uuid4().hex


class Fixture(unittest.TestCase):
    def setUp(self):
        work=tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.db=Path(work.name)/"wave25.sqlite3"
        spec=json.loads(DEMO.read_text(encoding="utf-8"))
        self.project=spec["project_id"]
        self.rt=LocalAppRuntime(str(self.db))
        self.rt.drafts.create(spec,tenant=TENANT)
        self.rt.policy.bootstrap_owner(
            tenant=TENANT,project_id=self.project,
            actor=OWNER,now=1799971200)
        self.enroll(WORKER)
        self.enroll(ALTERNATE)
        self.items=[
            self.rt.create_team_task(
                **self.scope(),title="Работа "+str(i),
                assignee=OWNER,due_date="2027-11-06",
                idempotency_key=nonce())["task"]
            for i in range(2)]
        for actor in (OWNER,WORKER,ALTERNATE):
            self.rt.set_forecast_capacity(
                **self.scope(),worker=actor,hours_per_day=8,
                expected_version=0,idempotency_key=nonce())
        for t in self.items:
            self.rt.set_forecast_effort(
                **self.scope(),task_id=t["task_id"],
                effort_hours=16,expected_version=0,
                idempotency_key=nonce())

    def scope(self,actor=OWNER):
        return {"tenant":TENANT,"project_id":self.project,"actor":actor}

    def enroll(self,actor=WORKER,role="operator"):
        self.rt.policy.add_member(
            tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=actor,role=role,now=1799971201)

    def revoke(self,actor=WORKER):
        self.rt.policy.revoke_member(
            tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=actor,now=1799971202)

    def snapshot(self):
        return self.rt.project_resource_forecast(**self.scope())["input_snapshot"]

    def active_tasks(self):
        with self.rt.drafts._db() as db:
            return [tuple(row) for row in db.execute(
                """SELECT task_id,assignee,version,status,task_digest
                   FROM director_tasks
                   WHERE tenant=? AND project_id=? ORDER BY task_id""",
                (TENANT,self.project))]

    def counts(self):
        with self.rt.drafts._db() as db:
            return {
                table:db.execute("SELECT COUNT(*) FROM "+table).fetchone()[0]
                for table in ("director_task_events",
                              "director_scenario_decisions",
                              "director_scenario_applications",
                              "director_scenario_rollbacks")
            }

    def apply_plan(self, *, actor=OWNER,moves=None):
        selected_moves=moves or [
            {"task_id":t["task_id"],"assignee":WORKER} for t in self.items]
        saved=self.rt.save_resource_variant(
            **self.scope(actor),title="Рабочий вариант",
            expected_snapshot=self.snapshot(),
            moves=selected_moves,idempotency_key=nonce())["variant"]
        approved=self.rt.select_resource_variant(
            **self.scope(),scenario_id=saved["scenario_id"],
            expected_version=saved["version"],
            expected_snapshot=saved["input_snapshot"],
            idempotency_key=nonce())["variant"]
        result=self.rt.apply_resource_variant(
            **self.scope(),scenario_id=approved["scenario_id"],
            expected_version=approved["version"],
            expected_snapshot=approved["input_snapshot"],
            confirmation="ПРИМЕНИТЬ",idempotency_key=nonce())
        updated=next(v for v in self.rt.list_resource_variants(
            **self.scope())["variants"] if v["scenario_id"]==saved["scenario_id"])
        return updated,result

    def outcome(self,variant,actor=OWNER):
        return self.rt.scenario_outcome(
            **self.scope(actor),scenario_id=variant["scenario_id"])

    def rollback(self,variant,*,snapshot=None,key=None,actor=OWNER,
                 confirmation="ОТКАТИТЬ"):
        return self.rt.rollback_resource_variant(
            **self.scope(actor),scenario_id=variant["scenario_id"],
            expected_version=variant["version"],
            expected_snapshot=snapshot or self.snapshot(),
            confirmation=confirmation,idempotency_key=key or nonce())


class ApplicationReceiptTests(Fixture):
    def test_atomic_application_creates_factual_immutable_receipt(self):
        before=self.active_tasks()
        variant,apply=self.apply_plan()
        after=self.active_tasks()
        self.assertEqual(apply["applied_count"],2)
        self.assertEqual({x[1] for x in after},{WORKER})
        self.assertEqual([x[2] for x in after],[x[2]+1 for x in before])
        self.assertEqual(self.counts()["director_scenario_applications"],1)
        report=self.outcome(variant)
        receipt=report["application"]
        self.assertEqual(receipt["scenario_id"],variant["scenario_id"])
        self.assertEqual(len(receipt["task_changes"]),2)
        self.assertEqual(len(receipt["sha256"]),64)
        self.assertEqual(apply["application_sha256"],receipt["sha256"])
        self.assertNotEqual(receipt["snapshot_before"],receipt["snapshot_after"])
        self.assertEqual(receipt["snapshot_after"],self.snapshot())
        self.assertEqual(report["current_metrics"],receipt["metrics_after"])
        self.assertEqual(len(receipt["metrics_before"]),9)
        self.assertTrue(report["rollback_ready"])
        self.assertFalse(report["changed_since_application"])
        self.assertTrue(variant["rollback_supported"])

    def test_saved_application_snapshot_matched_plan_expected_forecast(self):
        variant,_=self.apply_plan()
        report=self.outcome(variant)
        application=report["application"]
        # Version-only task changes must not shift deterministic schedule hours.
        expected=variant["preview"]["scenario"]["metrics"]
        self.assertEqual(application["metrics_after"]["potential_finish"],
                         expected["potential_finish"])
        self.assertEqual(application["metrics_after"]["at_risk_tasks"],
                         expected["at_risk_tasks"])

    def test_read_only_detail_does_not_create_mutation_events(self):
        variant,_=self.apply_plan()
        old=self.counts()
        self.outcome(variant)
        self.outcome(variant)
        self.assertEqual(self.counts(),old)

    def test_damaged_application_receipt_rejected_in_listing_and_detail(self):
        variant,_=self.apply_plan()
        with self.rt.drafts._db() as db:
            db.execute("DROP TRIGGER director_scenario_application_no_update")
            db.execute("""UPDATE director_scenario_applications
                          SET receipt_digest='bad'""")
        with self.assertRaises(ScenarioLibraryDenied):
            self.outcome(variant)
        with self.assertRaises(ScenarioLibraryDenied):
            self.rt.list_resource_variants(**self.scope())
        with self.assertRaises(ScenarioLibraryDenied):
            self.rollback(variant)

    def test_application_and_rollback_receipts_are_sqlite_append_only(self):
        variant,_=self.apply_plan()
        self.rollback(variant)
        with self.rt.drafts._tx() as db:
            for table in ("director_scenario_applications",
                          "director_scenario_rollbacks"):
                with self.subTest(table=table):
                    with self.assertRaises(sqlite3.DatabaseError):
                        db.execute("UPDATE "+table+" SET receipt_digest='bad'")
                    with self.assertRaises(sqlite3.DatabaseError):
                        db.execute("DELETE FROM "+table)

    def test_old_application_without_receipt_cannot_be_reverted_automatically(self):
        variant,_=self.apply_plan()
        # Model a pre-Wave25 applied plan without an accompanying receipt.
        with self.rt.drafts._db() as db:
            db.execute("DROP TRIGGER director_scenario_application_no_delete")
            db.execute("DELETE FROM director_scenario_applications")
        listing=self.rt.list_resource_variants(**self.scope())
        item=listing["variants"][0]
        self.assertFalse(item["rollback_supported"])
        self.assertFalse(item["application_recorded"])
        self.assertIsNone(self.outcome(variant)["application"])
        before=self.active_tasks()
        with self.assertRaises(ScenarioLibraryDenied):
            self.rollback(variant)
        self.assertEqual(self.active_tasks(),before)

    def test_editor_can_view_application_but_cannot_roll_back(self):
        self.enroll(EDITOR,"editor")
        variant,_=self.apply_plan()
        outcome=self.outcome(variant,actor=EDITOR)
        self.assertTrue(outcome["application_recorded"])
        with self.assertRaises(AppAccessDenied):
            self.rollback(variant,actor=EDITOR)

    def test_foreign_tenant_and_project_cannot_see_receipts(self):
        variant,_=self.apply_plan()
        with self.assertRaises(AppAccessDenied):
            self.rt.scenario_outcome(
                **{**self.scope(),"tenant":"other_tenant"},
                scenario_id=variant["scenario_id"])
        with self.assertRaises(AppAccessDenied):
            self.rt.scenario_outcome(
                **{**self.scope(),"project_id":str(uuid.uuid4())},
                scenario_id=variant["scenario_id"])


class RollbackTests(Fixture):
    def test_owner_rollback_restores_all_previous_assignees(self):
        originals=self.active_tasks()
        variant,_=self.apply_plan()
        res=self.rollback(variant)
        self.assertEqual(res["effective_status"],"rolled_back")
        self.assertEqual(res["reverted_count"],2)
        self.assertTrue(res["atomic"])
        after=self.active_tasks()
        self.assertEqual([x[1] for x in after],[x[1] for x in originals])
        self.assertEqual([x[2] for x in after],[x[2]+2 for x in originals])
        saved=self.rt.list_resource_variants(**self.scope())["variants"][0]
        self.assertEqual(saved["status"],"applied")
        self.assertEqual(saved["effective_status"],"rolled_back")
        self.assertTrue(saved["rollback_recorded"])
        self.assertFalse(saved["rollback_supported"])
        self.assertEqual(self.counts()["director_task_events"],6)
        self.assertEqual(self.counts()["director_scenario_rollbacks"],1)

    def test_rollback_metrics_recover_previous_stored_forecast(self):
        variant,_=self.apply_plan()
        receipt=self.outcome(variant)["application"]
        self.rollback(variant)
        outcome=self.outcome(variant)
        self.assertEqual(outcome["rollback"]["metrics_after"],
                         receipt["metrics_before"])
        self.assertEqual(outcome["rollback"]["metrics_before"],
                         receipt["metrics_after"])
        self.assertEqual(outcome["current_metrics"],receipt["metrics_before"])
        self.assertEqual(outcome["rollback"]["application_sha256"],
                         receipt["sha256"])

    def test_unified_decision_history_includes_verified_rollback(self):
        variant,_=self.apply_plan()
        self.rollback(variant)
        history=self.rt.resource_variant_history(
            **self.scope(),scenario_id=variant["scenario_id"])
        self.assertEqual({x["action"] for x in history["events"]},
                         {"SAVE","APPROVE","APPLY","ROLLBACK"})
        self.assertTrue(history["immutable"])
        self.assertEqual(len(history["events"]),4)
        reverse=next(x for x in history["events"] if x["action"]=="ROLLBACK")
        self.assertEqual(reverse["status"],"rolled_back")
        self.assertEqual(len(reverse["sha256"]),64)

    def test_rollback_requires_exact_phrase_and_no_change_when_rejected(self):
        variant,_=self.apply_plan()
        state=self.active_tasks()
        for phrase in ("","откатить","ОТКАТИТЬ ",None,"ПРИМЕНИТЬ"):
            with self.subTest(phrase=phrase):
                with self.assertRaises(ScenarioLibraryDenied):
                    self.rollback(variant,confirmation=phrase)
        self.assertEqual(self.active_tasks(),state)
        self.assertEqual(self.counts()["director_scenario_rollbacks"],0)

    def test_rollback_one_time_and_identical_key_replays(self):
        variant,_=self.apply_plan()
        key=nonce()
        applied_snapshot=self.snapshot()
        first=self.rollback(variant,key=key,snapshot=applied_snapshot)
        existing=self.active_tasks()
        replay=self.rollback(variant,key=key,snapshot=applied_snapshot)
        self.assertEqual(first,replay)
        self.assertEqual(self.active_tasks(),existing)
        with self.assertRaises(ScenarioLibraryDenied):
            self.rollback(variant,key=nonce())

    def test_replay_key_collision_rejected(self):
        variant,_=self.apply_plan()
        key=nonce()
        self.rollback(variant,key=key)
        with self.assertRaises(ValueError):
            self.rt.rollback_resource_variant(
                **self.scope(),scenario_id=variant["scenario_id"],
                expected_version=variant["version"],
                expected_snapshot="0"*64,confirmation="ОТКАТИТЬ",
                idempotency_key=key)

    def test_stale_expected_forecast_snapshot_rejected_before_write(self):
        variant,_=self.apply_plan()
        snap=self.snapshot()
        extra=self.rt.create_team_task(
            **self.scope(),title="Unrelated new task",assignee=ALTERNATE,
            idempotency_key=nonce())["task"]
        state=self.active_tasks()
        with self.assertRaises(ScenarioLibraryDenied):
            self.rollback(variant,snapshot=snap)
        self.assertEqual(self.active_tasks(),state)
        self.assertEqual(self.counts()["director_scenario_rollbacks"],0)
        # Refreshing the input snapshot is permitted because *affected*
        # assignments are unchanged, even though unrelated tasks exist.
        result=self.rollback(variant,snapshot=self.snapshot())
        self.assertEqual(result["reverted_count"],2)
        self.assertEqual(extra["assignee"],ALTERNATE)

    def test_changed_task_description_blocks_rollback_atomically(self):
        variant,_=self.apply_plan()
        row=self.rt.project_resource_forecast(**self.scope())["tasks"][0]
        changed=self.rt.update_team_task(
            **self.scope(),task_id=row["task_id"],
            expected_version=next(t for t in self.active_tasks()
                                  if t[0]==row["task_id"])[2],
            changes={"description":"Work changed"},
            idempotency_key=nonce())
        before=self.active_tasks()
        with self.assertRaises(ScenarioLibraryDenied):
            self.rollback(variant)
        self.assertEqual(self.active_tasks(),before)
        self.assertEqual(self.counts()["director_scenario_rollbacks"],0)
        self.assertEqual(changed["task"]["description"],"Work changed")
        self.assertFalse(self.outcome(variant)["rollback_ready"])

    def test_revoked_original_assignee_blocks_rollback(self):
        # One task was originally assigned to a different worker.
        changed=self.rt.update_team_task(
            **self.scope(),task_id=self.items[0]["task_id"],
            expected_version=self.items[0]["version"],
            changes={"assignee":ALTERNATE},idempotency_key=nonce())["task"]
        variant,_=self.apply_plan(moves=[
            {"task_id":changed["task_id"],"assignee":WORKER},
            {"task_id":self.items[1]["task_id"],"assignee":WORKER}])
        self.revoke(ALTERNATE)
        before=self.active_tasks()
        with self.assertRaises(ScenarioLibraryDenied):
            self.rollback(variant)
        self.assertEqual(self.active_tasks(),before)
        self.assertFalse(self.outcome(variant)["rollback_ready"])

    def test_rollback_restores_unassigned_original_task(self):
        task=self.rt.update_team_task(
            **self.scope(),task_id=self.items[0]["task_id"],
            expected_version=self.items[0]["version"],
            changes={"assignee":None},idempotency_key=nonce())["task"]
        variant,_=self.apply_plan(moves=[
            {"task_id":task["task_id"],"assignee":WORKER}])
        self.rollback(variant)
        row=next(x for x in self.active_tasks() if x[0]==task["task_id"])
        self.assertIsNone(row[1])

    def test_concurrent_task_update_during_rollback_rolls_back_everything(self):
        variant,_=self.apply_plan()
        before=self.active_tasks()
        counts=self.counts()
        from campaign180.team_tasks import _event as original_event
        n={"calls":0}
        def fail_second(*args,**kwargs):
            n["calls"]+=1
            if n["calls"]==2:
                raise RuntimeError("simulated second task event failure")
            return original_event(*args,**kwargs)
        with patch("campaign180.scenario_outcomes._event",side_effect=fail_second):
            with self.assertRaisesRegex(RuntimeError,"simulated"):
                self.rollback(variant)
        self.assertEqual(n["calls"],2)
        self.assertEqual(self.active_tasks(),before)
        self.assertEqual(self.counts(),counts)
        self.assertTrue(self.outcome(variant)["rollback_ready"])

    def test_rollback_receipt_digest_tampering_fails_closed(self):
        variant,_=self.apply_plan()
        self.rollback(variant)
        with self.rt.drafts._db() as db:
            db.execute("DROP TRIGGER director_scenario_rollback_no_update")
            db.execute("""UPDATE director_scenario_rollbacks
                          SET receipt_digest='bad'""")
        with self.assertRaises(ScenarioLibraryDenied):
            self.outcome(variant)
        with self.assertRaises(ScenarioLibraryDenied):
            self.rt.list_resource_variants(**self.scope())
        with self.assertRaises(ScenarioLibraryDenied):
            self.rt.resource_variant_history(
                **self.scope(),scenario_id=variant["scenario_id"])

    def test_refuse_viewer_operator_and_revoked_ownerless_principal(self):
        variant,_=self.apply_plan()
        self.enroll(VIEWER,"viewer")
        self.enroll(EDITOR,"editor")
        for actor in (VIEWER,WORKER,EDITOR):
            with self.subTest(actor=actor):
                with self.assertRaises(AppAccessDenied):
                    self.rollback(variant,actor=actor)
        with self.assertRaises(AppAccessDenied):
            self.outcome(variant,actor=WORKER)

    def test_version_and_tenant_guard_before_rollback(self):
        variant,_=self.apply_plan()
        with self.assertRaises(ScenarioLibraryDenied):
            self.rt.rollback_resource_variant(
                **self.scope(),scenario_id=variant["scenario_id"],
                expected_version=variant["version"]-1,
                expected_snapshot=self.snapshot(),
                confirmation="ОТКАТИТЬ",idempotency_key=nonce())
        with self.assertRaises(AppAccessDenied):
            self.rt.rollback_resource_variant(
                **{**self.scope(),"tenant":"foreign_tenant"},
                scenario_id=variant["scenario_id"],
                expected_version=variant["version"],
                expected_snapshot=self.snapshot(),
                confirmation="ОТКАТИТЬ",idempotency_key=nonce())
        self.assertEqual(self.counts()["director_scenario_rollbacks"],0)


class HttpTests(Fixture):
    def send(self,path,body=None,*,method="POST",secret=TOKEN,origin=None,
             actor=OWNER):
        app=LocalConsole(self.db,tenant=TENANT,project_id=self.project,
                         actor=actor,token=TOKEN,port=PORT)
        env={}
        setup_testing_defaults(env)
        raw=json.dumps(body,ensure_ascii=False).encode() if body is not None else b""
        env.update({
            "REQUEST_METHOD":method,"PATH_INFO":path,
            "HTTP_HOST":f"127.0.0.1:{PORT}","REMOTE_ADDR":"127.0.0.1",
            "QUERY_STRING":"","HTTP_AUTHORIZATION":"Bearer "+secret,
            "CONTENT_TYPE":"application/json","CONTENT_LENGTH":str(len(raw)),
            "wsgi.input":BytesIO(raw),
        })
        if origin:env["HTTP_ORIGIN"]=origin
        status=[]
        response=b"".join(app(env,lambda code,headers:status.append(code)))
        return status[0],json.loads(response)

    def test_http_get_outcome_and_atomic_rollback(self):
        variant,_=self.apply_plan()
        base="/api/v1/scenarios/saved/"+variant["scenario_id"]
        status,data=self.send(base+"/outcome",method="GET")
        self.assertTrue(status.startswith("200"),(status,data))
        self.assertTrue(data["rollback_ready"])
        self.assertEqual(len(data["application"]["task_changes"]),2)
        status,result=self.send(base+"/rollback",{
            "expected_version":variant["version"],
            "expected_snapshot":data["current_snapshot"],
            "confirmation":"ОТКАТИТЬ",
            "idempotency_key":nonce()})
        self.assertTrue(status.startswith("200"),(status,result))
        self.assertEqual(result["reverted_count"],2)
        status,post=self.send(base+"/outcome",method="GET")
        self.assertTrue(status.startswith("200"))
        self.assertEqual(post["effective_status"],"rolled_back")
        self.assertEqual([x[1] for x in self.active_tasks()],[OWNER,OWNER])

    def test_http_auth_origin_actor_injection_and_wrong_phrase(self):
        variant,_=self.apply_plan()
        base="/api/v1/scenarios/saved/"+variant["scenario_id"]
        payload={"expected_version":variant["version"],
                 "expected_snapshot":self.snapshot(),
                 "confirmation":"ОТКАТИТЬ","idempotency_key":nonce()}
        code,_=self.send(base+"/rollback",payload,secret="bad")
        self.assertTrue(code.startswith("401"))
        code,_=self.send(base+"/rollback",payload,origin="https://evil.invalid")
        self.assertTrue(code.startswith("403"))
        code,_=self.send(base+"/rollback",{**payload,"actor":OWNER})
        self.assertTrue(code.startswith("400"))
        code,_=self.send(base+"/rollback",{**payload,"confirmation":"yes"})
        self.assertTrue(code.startswith("400"))
        code,_=self.send(base+"/rollback",payload,actor=WORKER)
        self.assertTrue(code.startswith("403"))
        self.assertEqual(self.counts()["director_scenario_rollbacks"],0)

if __name__=="__main__":
    unittest.main()
