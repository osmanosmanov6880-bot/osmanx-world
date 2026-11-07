"""Wave 24: persisted what-if plans, owner approval, atomic apply and journals."""
from __future__ import annotations

from datetime import datetime,timedelta,timezone
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
EDITOR="editor-abc"
WORKER="operator-abc"
VIEWER="viewer-abc"
TOKEN="Wave24LocalToken_abcdefghABCDEFGHIJKL_0123456789"
PORT=8779

def nonce():return "wave24-"+uuid.uuid4().hex

class Fixture(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db=Path(tmp.name)/"scenario.sqlite3"
        spec=json.loads(DEMO.read_text(encoding="utf-8"))
        self.project=spec["project_id"]
        self.rt=LocalAppRuntime(str(self.db))
        self.rt.drafts.create(spec,tenant=TENANT)
        self.rt.policy.bootstrap_owner(tenant=TENANT,project_id=self.project,
                                       actor=OWNER,now=1799971200)
        self.rt.policy.add_member(tenant=TENANT,project_id=self.project,
                                  owner_actor=OWNER,member_actor=WORKER,
                                  role="operator",now=1799971201)
        self.tasks=[self.rt.create_team_task(
            tenant=TENANT,project_id=self.project,actor=OWNER,
            title="Работа "+str(n),assignee=OWNER,
            due_date="2027-11-06",idempotency_key=nonce())["task"]
            for n in range(2)]
        for worker in (OWNER,WORKER):
            self.rt.set_forecast_capacity(
                tenant=TENANT,project_id=self.project,actor=OWNER,
                worker=worker,hours_per_day=8,expected_version=0,
                idempotency_key=nonce())
        for task in self.tasks:
            self.rt.set_forecast_effort(
                tenant=TENANT,project_id=self.project,actor=OWNER,
                task_id=task["task_id"],effort_hours=16,
                expected_version=0,idempotency_key=nonce())
    def scope(self,actor=OWNER):
        return {"tenant":TENANT,"project_id":self.project,"actor":actor}
    def snapshot(self):
        return self.rt.resource_workload(**self.scope())["input_snapshot"]
    def moves(self,tasks=None,worker=WORKER):
        return [{"task_id":t["task_id"],"assignee":worker}
                for t in (tasks or self.tasks)]
    def save(self,title="Альтернативный план",moves=None,actor=OWNER,
             snapshot=None,key=None):
        return self.rt.save_resource_variant(
            **self.scope(actor),title=title,
            expected_snapshot=snapshot or self.snapshot(),
            moves=moves or self.moves(),idempotency_key=key or nonce())["variant"]
    def saved(self,actor=OWNER):
        return self.rt.list_resource_variants(**self.scope(actor))
    def select(self,variant,actor=OWNER,snapshot=None,key=None):
        return self.rt.select_resource_variant(
            **self.scope(actor),scenario_id=variant["scenario_id"],
            expected_version=variant["version"],
            expected_snapshot=snapshot or variant["input_snapshot"],
            idempotency_key=key or nonce())
    def apply(self,variant,actor=OWNER,snapshot=None,key=None,
              confirmation="ПРИМЕНИТЬ"):
        return self.rt.apply_resource_variant(
            **self.scope(actor),scenario_id=variant["scenario_id"],
            expected_version=variant["version"],
            expected_snapshot=snapshot or variant["input_snapshot"],
            confirmation=confirmation,idempotency_key=key or nonce())
    def task_state(self):
        with self.rt.drafts._db() as db:
            return [tuple(row) for row in db.execute(
                """SELECT task_id,assignee,version,status,task_digest
                   FROM director_tasks WHERE tenant=? AND project_id=?
                   ORDER BY task_id""",(TENANT,self.project)).fetchall()]
    def events(self):
        with self.rt.drafts._db() as db:
            return (db.execute(
                "SELECT COUNT(*) FROM director_scenario_decisions"
                ).fetchone()[0],
                db.execute("SELECT COUNT(*) FROM director_task_events"
                    ).fetchone()[0])

class SaveAndReviewTests(Fixture):
    def test_save_two_named_variants_without_changing_tasks(self):
        before=self.task_state()
        a=self.save("План А",self.moves([self.tasks[0]]))
        b=self.save("План Б",self.moves([self.tasks[1]]))
        result=self.saved()
        self.assertEqual(len(result["variants"]),2)
        self.assertEqual({a["title"],b["title"]},{"План А","План Б"})
        self.assertEqual({x["status"] for x in result["variants"]},{"draft"})
        self.assertTrue(all(x["snapshot_current"] for x in result["variants"]))
        self.assertEqual(self.task_state(),before)
        self.assertEqual(self.events()[0],2)

    def test_saved_preview_retains_identical_base_and_scenario_metrics(self):
        variant=self.save()
        self.assertEqual(variant["preview"]["baseline"]["metrics"]["open_tasks"],2)
        self.assertEqual(variant["preview"]["scenario"]["metrics"]["open_tasks"],2)
        self.assertEqual(variant["move_count"],2)
        self.assertIsNotNone(variant["preview"]["comparison"]["finish_delta_calendar_days"])

    def test_repeated_save_key_returns_existing_variant(self):
        key=nonce()
        first=self.save("Same",key=key)
        again=self.save("Same",key=key)
        self.assertEqual(first,again)
        self.assertEqual(len(self.saved()["variants"]),1)
        with self.assertRaises(ValueError):
            self.save("Different",key=key)

    def test_save_replay_survives_changed_task_snapshot_for_same_request(self):
        snap=self.snapshot()
        key=nonce()
        variant=self.save(key=key,snapshot=snap)
        t=self.tasks[0]
        self.rt.update_team_task(
            **self.scope(),task_id=t["task_id"],expected_version=t["version"],
            changes={"description":"Changed"},idempotency_key=nonce())
        again=self.save(key=key,snapshot=snap)
        self.assertEqual(variant,again)
        self.assertFalse(self.saved()["variants"][0]["snapshot_current"])

    def test_invalid_title_snapshot_and_move_are_rejected(self):
        current=self.snapshot()
        for title in (""," "*10,"X"*101,"has\nnewline",123):
            with self.subTest(title=str(title)[:12]):
                with self.assertRaises(ValueError):
                    self.rt.save_resource_variant(**self.scope(),title=title,
                        expected_snapshot=current,moves=self.moves(),
                        idempotency_key=nonce())
        with self.assertRaises(ValueError):
            self.rt.save_resource_variant(**self.scope(),title="Example",
                expected_snapshot="0"*64,moves=self.moves(),
                idempotency_key=nonce())
        with self.assertRaises(ValueError):
            self.rt.save_resource_variant(**self.scope(),title="Example",
                expected_snapshot=current,moves=[self.moves()[0]]*2,
                idempotency_key=nonce())
        self.assertEqual(len(self.saved()["variants"]),0)

    def test_stale_plan_cannot_be_selected_after_capacity_change(self):
        saved=self.save()
        self.rt.set_forecast_capacity(
            **self.scope(),worker=OWNER,hours_per_day=6,
            expected_version=1,idempotency_key=nonce())
        with self.assertRaises(ScenarioLibraryDenied):
            self.select(saved)
        self.assertEqual(self.saved()["variants"][0]["status"],"draft")
        self.assertFalse(self.saved()["variants"][0]["snapshot_current"])

    def test_editor_can_save_but_cannot_select_or_apply(self):
        self.rt.policy.add_member(
            tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=EDITOR,role="editor",now=1799971201)
        candidate=self.save(actor=EDITOR)
        with self.assertRaises(AppAccessDenied):
            self.select(candidate,actor=EDITOR)
        approved=self.select(candidate)["variant"]
        with self.assertRaises(AppAccessDenied):
            self.apply(approved,actor=EDITOR)
        self.assertEqual(self.saved()["variants"][0]["status"],"approved")

    def test_operator_viewer_and_revoked_editor_cannot_read_variants(self):
        self.rt.policy.add_member(
            tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=VIEWER,role="viewer",now=1799971201)
        for actor in (WORKER,VIEWER):
            with self.subTest(actor=actor):
                with self.assertRaises(AppAccessDenied):
                    self.saved(actor)
        self.rt.policy.add_member(
            tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=EDITOR,role="editor",now=1799971201)
        candidate=self.save(actor=EDITOR)
        self.rt.policy.revoke_member(tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=EDITOR,now=1799971202)
        with self.assertRaises(AppAccessDenied):
            self.save(actor=EDITOR)
        with self.assertRaises(AppAccessDenied):
            self.saved(EDITOR)
        self.assertTrue(candidate["scenario_id"])

    def test_cross_project_and_tenant_are_not_readable(self):
        self.save()
        with self.assertRaises(AppAccessDenied):
            self.rt.list_resource_variants(
                **{**self.scope(),"tenant":"foreign_tenant"})
        with self.assertRaises(AppAccessDenied):
            self.rt.list_resource_variants(
                **{**self.scope(),"project_id":str(uuid.uuid4())})

    def test_digest_corruption_detected_before_render_or_approval(self):
        saved=self.save()
        with self.rt.drafts._db() as db:
            db.execute("UPDATE director_saved_scenarios SET title='FORGED'")
        with self.assertRaises(ScenarioLibraryDenied):
            self.saved()
        with self.assertRaises(ScenarioLibraryDenied):
            self.select(saved)

class ApprovalAndApplyTests(Fixture):
    def test_select_requires_owner_and_does_not_change_assignments(self):
        saved=self.save()
        before=self.task_state()
        choice=self.select(saved)
        self.assertTrue(choice["selected"])
        self.assertEqual(choice["tasks_changed"],0)
        self.assertEqual(choice["variant"]["status"],"approved")
        self.assertEqual(choice["variant"]["version"],2)
        self.assertEqual(self.task_state(),before)
        self.assertEqual(self.events()[0],2)

    def test_new_selection_supersedes_old_choice_atomically(self):
        a=self.save("Plan A",self.moves([self.tasks[0]]))
        b=self.save("Plan B",self.moves([self.tasks[1]]))
        self.select(a)
        self.select(b)
        statuses={x["title"]:x["status"] for x in self.saved()["variants"]}
        self.assertEqual(statuses,{"Plan A":"superseded","Plan B":"approved"})
        with self.rt.drafts._db() as db:
            count=db.execute(
                "SELECT count(*) FROM director_saved_scenarios WHERE status='approved'"
                ).fetchone()[0]
        self.assertEqual(count,1)
        history=self.rt.resource_variant_history(
            **self.scope(),scenario_id=a["scenario_id"])
        self.assertEqual({e["action"] for e in history["events"]},
                         {"SAVE","APPROVE","SUPERSEDE"})

    def test_approved_scenario_requires_confirmation_to_apply(self):
        saved=self.save()
        selected=self.select(saved)["variant"]
        before=self.task_state()
        for phrase in ("", "применить", "ПРИМЕНИТЬ ", None):
            with self.subTest(phrase=phrase):
                with self.assertRaises(ScenarioLibraryDenied):
                    self.apply(selected,confirmation=phrase)
        self.assertEqual(self.task_state(),before)

    def test_apply_changes_real_tasks_and_writes_task_histories(self):
        selected=self.select(self.save())["variant"]
        before=self.task_state()
        result=self.apply(selected)
        self.assertTrue(result["atomic"])
        self.assertEqual(result["applied_count"],2)
        self.assertEqual(result["status"],"applied")
        self.assertEqual({r["assignee"] for r in result["tasks"]},{WORKER})
        after=self.task_state()
        self.assertEqual({x[1] for x in after},{WORKER})
        self.assertEqual([x[2] for x in after],[x[2]+1 for x in before])
        self.assertEqual([x[3] for x in after],[x[3] for x in before])
        self.assertEqual(self.events()[0],3)
        self.assertEqual(self.events()[1],4)
        history=self.rt.team_task_history(
            **self.scope(),task_id=self.tasks[0]["task_id"])
        self.assertEqual(history["events"][0]["changed_fields"],["assignee"])

    def test_apply_replay_does_not_double_increment_task_versions(self):
        selected=self.select(self.save())["variant"]
        idk=nonce()
        first=self.apply(selected,key=idk)
        after=self.task_state()
        again=self.apply(selected,key=idk)
        self.assertEqual(first,again)
        self.assertEqual(self.task_state(),after)
        with self.assertRaises(ScenarioLibraryDenied):
            self.apply(selected,key=nonce())

    def test_stale_task_revision_prevents_apply_without_partial_write(self):
        selected=self.select(self.save())["variant"]
        item=self.tasks[1]
        changed=self.rt.update_team_task(
            **self.scope(),task_id=item["task_id"],
            expected_version=item["version"],
            changes={"priority":"urgent"},idempotency_key=nonce())
        before=self.task_state()
        with self.assertRaises(ScenarioLibraryDenied):
            self.apply(selected)
        self.assertEqual(self.task_state(),before)
        self.assertEqual(self.saved()["variants"][0]["status"],"approved")
        self.assertEqual(changed["task"]["priority"],"urgent")

    def test_revoked_destination_prevents_application(self):
        selected=self.select(self.save())["variant"]
        self.rt.policy.revoke_member(
            tenant=TENANT,project_id=self.project,
            owner_actor=OWNER,member_actor=WORKER,now=1799971202)
        before=self.task_state()
        with self.assertRaises(ScenarioLibraryDenied):
            self.apply(selected)
        self.assertEqual(self.task_state(),before)

    def test_atomic_rollback_if_second_task_event_fails(self):
        selected=self.select(self.save())["variant"]
        before=self.task_state()
        decisions,events=self.events()
        from campaign180.team_tasks import _event as real_event
        count={"calls":0}
        def fail_on_second(*args,**kwargs):
            count["calls"]+=1
            if count["calls"]==2:
                raise RuntimeError("injected task event write failure")
            return real_event(*args,**kwargs)
        with patch("campaign180.scenario_library._event",
                   side_effect=fail_on_second):
            with self.assertRaisesRegex(RuntimeError,"injected"):
                self.apply(selected)
        self.assertEqual(count["calls"],2)
        self.assertEqual(self.task_state(),before)
        self.assertEqual(self.events(),(decisions,events))
        self.assertEqual(self.saved()["variants"][0]["status"],"approved")

    def test_cannot_apply_superseded_or_unselected_variant(self):
        a=self.save("First")
        b=self.save("Second",moves=self.moves([self.tasks[0]]))
        with self.assertRaises(ScenarioLibraryDenied):
            self.apply(a)
        self.select(a)
        selected_b=self.select(b)["variant"]
        with self.assertRaises(ScenarioLibraryDenied):
            self.apply({**a,"version":2})
        self.assertEqual(self.apply(selected_b)["applied_count"],1)

    def test_double_select_old_revision_and_key_collision_rejected(self):
        saved=self.save()
        key=nonce()
        first=self.select(saved,key=key)
        self.assertEqual(self.select(saved,key=key),first)
        with self.assertRaises(ScenarioLibraryDenied):
            self.select(saved,key=nonce())
        other=self.save("other")
        with self.assertRaises(ValueError):
            self.select(other,key=key)

    def test_apply_does_not_change_immutable_milestone_baseline(self):
        now=datetime.now(timezone.utc).date()
        phase=self.rt.create_delivery_phase(
            **self.scope(),name="Project Phase",
            baseline_start=now.isoformat(),
            baseline_end=(now+timedelta(days=30)).isoformat(),
            idempotency_key=nonce())["phase"]
        self.rt.create_delivery_milestone(
            **self.scope(),phase_id=phase["phase_id"],
            name="Check",baseline_due=(now+timedelta(days=10)).isoformat(),
            linked_task_id=self.tasks[0]["task_id"],idempotency_key=nonce())
        selected=self.select(self.save())["variant"]
        before=self.rt.delivery_schedule(**self.scope())
        self.apply(selected)
        after=self.rt.delivery_schedule(**self.scope())
        self.assertEqual(before,after)

class HistoryTests(Fixture):
    def test_saved_scenario_decision_history_is_append_only(self):
        variant=self.save()
        selected=self.select(variant)["variant"]
        self.apply(selected)
        history=self.rt.resource_variant_history(
            **self.scope(),scenario_id=variant["scenario_id"])
        self.assertEqual({x["action"] for x in history["events"]},
                         {"SAVE","APPROVE","APPLY"})
        self.assertTrue(history["immutable"])
        self.assertEqual(len(history["events"]),3)
        with self.rt.drafts._tx() as db:
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("DELETE FROM director_scenario_decisions")
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE director_scenario_decisions SET actor='forged'")

    def test_tampered_decision_digest_detected(self):
        variant=self.save()
        with self.rt.drafts._db() as db:
            db.execute("DROP TRIGGER director_scenario_decisions_no_update")
            db.execute("UPDATE director_scenario_decisions SET event_digest='wrong'")
        with self.assertRaises(ScenarioLibraryDenied):
            self.rt.resource_variant_history(
                **self.scope(),scenario_id=variant["scenario_id"])

class HTTPTests(Fixture):
    def send(self,path,data=None,*,method="POST",secret=TOKEN,origin=None):
        app=LocalConsole(self.db,tenant=TENANT,project_id=self.project,
                         actor=OWNER,token=TOKEN,port=PORT)
        env={}
        setup_testing_defaults(env)
        raw=json.dumps(data,ensure_ascii=False).encode("utf-8") if data is not None else b""
        env.update({"REQUEST_METHOD":method,"PATH_INFO":path,
                    "HTTP_HOST":f"127.0.0.1:{PORT}","REMOTE_ADDR":"127.0.0.1",
                    "QUERY_STRING":"","HTTP_AUTHORIZATION":"Bearer "+secret,
                    "CONTENT_TYPE":"application/json","CONTENT_LENGTH":str(len(raw)),
                    "wsgi.input":BytesIO(raw)})
        if origin:env["HTTP_ORIGIN"]=origin
        status=[]
        body=b"".join(app(env,lambda code,headers:status.append(code)))
        return status[0],json.loads(body)

    def test_real_http_save_select_apply_and_audit(self):
        before=self.task_state()
        status,created=self.send("/api/v1/scenarios/saved",{
            "title":"HTTP Plan","expected_snapshot":self.snapshot(),
            "moves":self.moves(),"idempotency_key":nonce()})
        self.assertTrue(status.startswith("201"),(status,created))
        variant=created["variant"]
        status,rows=self.send("/api/v1/scenarios/saved",method="GET")
        self.assertTrue(status.startswith("200"))
        self.assertEqual(len(rows["variants"]),1)
        self.assertEqual(self.task_state(),before)
        url="/api/v1/scenarios/saved/"+variant["scenario_id"]
        status,chosen=self.send(url+"/select",{
            "expected_version":1,
            "expected_snapshot":variant["input_snapshot"],"idempotency_key":nonce()})
        self.assertTrue(status.startswith("200"),(status,chosen))
        self.assertEqual(self.task_state(),before)
        status,applied=self.send(url+"/apply",{
            "expected_version":2,
            "expected_snapshot":variant["input_snapshot"],
            "confirmation":"ПРИМЕНИТЬ","idempotency_key":nonce()})
        self.assertTrue(status.startswith("200"),(status,applied))
        self.assertEqual(applied["applied_count"],2)
        status,hist=self.send(url+"/history",{"limit":30})
        self.assertTrue(status.startswith("200"))
        self.assertEqual(len(hist["events"]),3)

    def test_http_rejects_bad_auth_origin_extra_fields_and_missing_phrase(self):
        variant=self.save()
        path="/api/v1/scenarios/saved/"+variant["scenario_id"]+"/select"
        payload={"expected_version":1,
                 "expected_snapshot":variant["input_snapshot"],
                 "idempotency_key":nonce()}
        status,_=self.send(path,payload,secret="bad")
        self.assertTrue(status.startswith("401"))
        status,_=self.send(path,payload,origin="https://evil.invalid")
        self.assertTrue(status.startswith("403"))
        status,_=self.send(path,{**payload,"actor":OWNER})
        self.assertTrue(status.startswith("400"))
        status,_=self.send("/api/v1/scenarios/saved",{
            "title":"Bad","expected_snapshot":self.snapshot(),
            "moves":self.moves(),"tenant":TENANT,"idempotency_key":nonce()})
        self.assertTrue(status.startswith("400"))
        self.assertEqual(self.task_state()[0][1],OWNER)

if __name__=="__main__":
    unittest.main()
