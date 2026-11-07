"""Wave29 SQLite acceptance: remediation steps, evidence, owner review, queue."""
import hashlib
import sqlite3
import unittest
from io import BytesIO
import json
from wsgiref.util import setup_testing_defaults
from test_wave26_monitoring import ScenarioFixture, nonce
from campaign180.risk_execution import ExecutionDenied
from campaign180.app_policy import AppAccessDenied
from campaign180.local_http import LocalConsole

class Wave29Tests(ScenarioFixture):
    def risk(self,plan="Проверить блокировку"):
        task=self.tasks[0]["task_id"]
        self.change(task,status="blocked")
        return self.rt.create_risk_action(
            **self.scope(),scenario_id=self.scenario_id,risk_code="TASK_BLOCKED",
            task_id=task,expected_snapshot=self.snapshot(),plan=plan,
            assignee="operator-abc",due_date="2027-11-11",
            idempotency_key=nonce())["action"]

    def step(self,action,title="Проверка критерия",key=None,assignee=None):
        return self.rt.create_risk_step(
            **self.scope(),scenario_id=self.scenario_id,
            action_id=action["action_id"],title=title,assignee=assignee,
            due_date=None,idempotency_key=key or nonce())["step"]

    def update_step(self,action,step,changes):
        return self.rt.revise_risk_step(
            **self.scope(),scenario_id=self.scenario_id,
            action_id=action["action_id"],step_id=step["step_id"],
            expected_version=step["version"],changes=changes,
            idempotency_key=nonce())["step"]

    def book(self,action,actor="owner-abc"):
        return self.rt.risk_workbook(
            **self.scope(actor),scenario_id=self.scenario_id,
            action_id=action["action_id"])

    def evidence(self,action,kind="task",sha=None,snapshot=None,key=None):
        return self.rt.capture_risk_evidence(
            **self.scope(),scenario_id=self.scenario_id,
            action_id=action["action_id"],kind=kind,
            expected_snapshot=snapshot or self.snapshot(),
            note="Непосредственная проверка локальной записи",
            checkpoint_sha256=sha,idempotency_key=key or nonce())["evidence"]

    def review(self,action,decision="needs_work",note="Нужна проверка"):
        book=self.book(action)
        return self.rt.review_risk_execution(
            **self.scope(),scenario_id=self.scenario_id,
            action_id=action["action_id"],
            expected_action_version=book["action_version"],
            expected_snapshot=book["source_snapshot"],
            expected_evidence_sha256=book["last_evidence_sha256"],
            expected_review_sha256=book["last_review_sha256"],
            decision=decision,note=note,idempotency_key=nonce())["review"]

    def test_create_step_and_signed_revision(self):
        action=self.risk()
        step=self.step(action,assignee="operator-abc")
        self.assertEqual(step["version"],1)
        with self.assertRaises(ExecutionDenied):
            self.update_step(action,step,{"status":"done"})
        done=self.update_step(action,step,{"status":"done","note":"Этап проверен"})
        self.assertEqual(done["version"],2)
        self.assertTrue(self.book(action)["verification"]["all_steps_done"])
        with self.assertRaises(ExecutionDenied):
            self.update_step(action,step,{"status":"doing"})
        with self.assertRaises(ExecutionDenied):
            self.update_step(action,done,{"status":"doing"})

    def test_create_idempotency_and_bound(self):
        action=self.risk()
        key=nonce()
        a=self.step(action,key=key)
        self.assertEqual(a,self.step(action,key=key))
        with self.assertRaises(ValueError):
            self.step(action,key=key,title="Другая задача")
        for i in range(11):
            self.step(action,title="Проверка "+str(i))
        with self.assertRaises(ExecutionDenied):
            self.step(action,title="Тринадцатый этап")
        self.assertEqual(len(self.book(action)["steps"]),12)

    def test_reject_bad_step_and_revoked_owner(self):
        action=self.risk()
        with self.assertRaises(ValueError):
            self.step(action,title="")
        with self.assertRaises(ValueError):
            self.step(action,assignee="unknown-abc")
        self.enroll("viewer-abc",role="viewer")
        with self.assertRaises(AppAccessDenied):
            self.book(action,actor="viewer-abc")
        with self.assertRaises(Exception):
            self.rt.create_risk_step(
                tenant="tenant_other",project_id=self.project,actor="owner-abc",
                scenario_id=self.scenario_id,action_id=action["action_id"],
                title="Несанкционированный",assignee=None,due_date=None,
                idempotency_key=nonce())

    def test_step_sql_journal_cannot_delete_and_corrupt_state_fails(self):
        action=self.risk();step=self.step(action)
        with self.rt.drafts._tx() as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM director_action_step_events")
            db.execute("UPDATE director_action_steps SET payload_json='{}'")
        with self.assertRaises(ExecutionDenied):
            self.book(action)

    def test_evidence_is_real_task_fact_and_checked_checkpoint(self):
        action=self.risk()
        first=self.evidence(action)
        self.assertEqual(first["source"]["status"],"blocked")
        self.assertEqual(first["source"]["task_id"],action["task_id"])
        point=self.capture("Контрольный замер")
        second=self.evidence(action,kind="checkpoint",sha=point["sha256"])
        self.assertEqual(second["prev_sha256"],first["sha256"])
        self.assertEqual(second["source"]["checkpoint_sha256"],point["sha256"])
        self.assertEqual(len(self.book(action)["evidence"]),2)
        with self.assertRaises(ExecutionDenied):
            self.evidence(action,kind="checkpoint",sha="a"*64)

    def test_stale_snapshot_and_idempotency_are_respected(self):
        action=self.risk();old=self.snapshot();key=nonce()
        first=self.evidence(action,key=key)
        self.assertEqual(first,self.evidence(action,key=key))
        self.change(action["task_id"],status="in_progress")
        with self.assertRaises(ExecutionDenied):
            self.evidence(action,snapshot=old)
        self.assertFalse(self.book(action)["verification"]["evidence_current"])

    def test_evidence_immutable(self):
        action=self.risk();self.evidence(action)
        with self.rt.drafts._tx() as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM director_action_evidence")
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE director_action_evidence SET payload_sha256='bad'")
        # The immutable SQL triggers reject the tamper before a bad digest
        # can persist, so the original chain must remain valid.
        self.assertTrue(self.book(action)["chains_verified"])

    def test_owner_verification_enforces_no_active_risk_and_fresh_proof(self):
        action=self.risk()
        step=self.step(action)
        with self.assertRaises(ExecutionDenied):
            self.review(action,"verified","Не выполнено")
        self.update_step(action,step,{"status":"done","note":"Работа проверена"})
        self.change(action["task_id"],status="in_progress")
        action=self.rt.change_risk_action(
            **self.scope(),scenario_id=self.scenario_id,
            action_id=action["action_id"],expected_version=action["version"],
            changes={"status":"resolved","note":"Проверено руководителем"},
            idempotency_key=nonce())["action"]
        self.evidence(action)
        v=self.review(action,"verified","Сверено с локальными данными")
        self.assertEqual(v["decision"],"verified")
        self.assertTrue(self.book(action)["verification"]["review_verified_on_current_data"])
        self.change(action["task_id"],status="done")
        self.assertFalse(self.book(action)["verification"]["review_verified_on_current_data"])

    def test_verified_denied_if_risk_active_or_evidence_missing(self):
        action=self.risk();step=self.step(action)
        self.update_step(action,step,{"status":"done","note":"Этап отмечен"})
        action=self.rt.change_risk_action(
            **self.scope(),scenario_id=self.scenario_id,action_id=action["action_id"],
            expected_version=1,changes={"status":"resolved","note":"Решение владельца"},
            idempotency_key=nonce())["action"]
        self.evidence(action)
        with self.assertRaises(ExecutionDenied):
            self.review(action,"verified","Риск остался")

    def test_only_owner_can_review(self):
        action=self.risk()
        self.enroll("editor-abc",role="editor")
        book=self.book(action)
        with self.assertRaises(AppAccessDenied):
            self.rt.review_risk_execution(
                **self.scope("editor-abc"),scenario_id=self.scenario_id,
                action_id=action["action_id"],expected_action_version=1,
                expected_snapshot=book["source_snapshot"],
                expected_evidence_sha256=None,expected_review_sha256=None,
                decision="needs_work",note="Нужна проверка",idempotency_key=nonce())

    def test_review_cas_and_immutable_history(self):
        action=self.risk()
        self.review(action)
        book=self.book(action)
        with self.assertRaises(ExecutionDenied):
            self.rt.review_risk_execution(
                **self.scope(),scenario_id=self.scenario_id,
                action_id=action["action_id"],expected_action_version=1,
                expected_snapshot=book["source_snapshot"],
                expected_evidence_sha256=None,expected_review_sha256=None,
                decision="needs_work",note="Повтор",idempotency_key=nonce())
        with self.rt.drafts._tx() as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM director_action_reviews")
        self.assertEqual(len(self.book(action)["reviews"]),1)

    def test_portfolio_queue_and_csv(self):
        action=self.risk(plan="=HYPERLINK(1)")
        self.step(action)
        queue=self.rt.risk_portfolio(**self.scope())
        self.assertEqual(queue["total"],1)
        self.assertEqual(queue["counts"]["open"],1)
        self.assertEqual(queue["actions"][0]["step_count"],1)
        exported=self.rt.risk_portfolio_csv(**self.scope())
        self.assertIn("'=HYPERLINK",exported["csv"])
        self.assertEqual(hashlib.sha256(exported["csv"].encode()).hexdigest(),
                         exported["sha256"])
        self.assertEqual(self.rt.risk_portfolio(**self.scope(),offset=1)["actions"],[])
        for limit in (0,101,False):
            with self.assertRaises(ValueError):
                self.rt.risk_portfolio(**self.scope(),limit=limit)

    def test_wsgi_endpoints_use_real_sqlite_and_auth(self):
        action=self.risk()
        token="Wave29Token_abcdefghijklABCDEFGHI_0123456789"
        app=LocalConsole(self.db,tenant="tenant_demo",project_id=self.project,
                         actor="owner-abc",token=token,port=8793)
        base="/api/v1/scenarios/saved/"+self.scenario_id+"/actions/"+action["action_id"]
        def invoke(method,path,body=None,secret=token):
            env={};setup_testing_defaults(env)
            raw=b"" if body is None else json.dumps(body).encode()
            env.update({"REQUEST_METHOD":method,"PATH_INFO":path,
                        "REMOTE_ADDR":"127.0.0.1","HTTP_HOST":"127.0.0.1:8793",
                        "HTTP_AUTHORIZATION":"Bearer "+secret,
                        "CONTENT_TYPE":"application/json","CONTENT_LENGTH":str(len(raw)),
                        "wsgi.input":BytesIO(raw)})
            status=[];resp=b"".join(app(env,lambda c,h:status.append(c)))
            return status[0],json.loads(resp)
        self.assertTrue(invoke("GET","/api/v1/risk/queue",secret="bad")[0].startswith("401"))
        status,step=invoke("POST",base+"/steps",{
            "title":"Проверить факт","assignee":None,"due_date":None,
            "idempotency_key":nonce()})
        self.assertTrue(status.startswith("201"),(status,step))
        patch=base+"/steps/"+step["step"]["step_id"]
        status,result=invoke("PATCH",patch,{
            "expected_version":1,"changes":{"status":"done","note":"Факт"},
            "idempotency_key":nonce()})
        self.assertTrue(status.startswith("200"),(status,result))
        status,fact=invoke("POST",base+"/evidence",{
            "kind":"task","expected_snapshot":self.snapshot(),
            "note":"Осмотр записи","checkpoint_sha256":None,
            "idempotency_key":nonce()})
        self.assertTrue(status.startswith("201"),(status,fact))
        self.assertEqual(invoke("GET",base+"/workbook")[1]["steps"][0]["status"],"done")
        self.assertEqual(invoke("GET","/api/v1/risk/queue")[1]["total"],1)
        status,review=invoke("POST",base+"/reviews",{
            "expected_action_version":action["version"],
            "expected_snapshot":self.snapshot(),
            "expected_evidence_sha256":fact["evidence"]["sha256"],
            "expected_review_sha256":None,
            "decision":"needs_work","note":"Дополнительная проверка",
            "idempotency_key":nonce()})
        self.assertTrue(status.startswith("201"),(status,review))
        self.assertTrue(invoke("POST",base+"/steps",{"untrusted":True})[0].startswith("400"))


if __name__=="__main__":
    unittest.main()
