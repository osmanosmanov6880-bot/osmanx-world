"""Wave28: persisted, source-backed risk actions and local security boundaries."""
from __future__ import annotations

from io import BytesIO
import json
import sqlite3
from wsgiref.util import setup_testing_defaults
import unittest

from test_wave26_monitoring import ScenarioFixture, nonce
from campaign180.scenario_actions import RiskActionDenied
from campaign180.app_policy import AppAccessDenied
from campaign180.local_http import LocalConsole

TOKEN = "Wave28LocalToken_abcdefghijklABCDEFGHI_0123456789"
PORT = 8792


class RiskActionTests(ScenarioFixture):
    def blocked(self):
        task_id = self.tasks[0]["task_id"]
        self.change(task_id, status="blocked")
        self.assertIn("TASK_BLOCKED", [r["code"] for r in self.report()["risks"]])
        return task_id

    def create(self, task_id, *, key=None, snapshot=None,
               plan="Устранить блокировку вместе с исполнителем",
               assignee="operator-abc"):
        return self.rt.create_risk_action(
            **self.scope(), scenario_id=self.scenario_id,
            risk_code="TASK_BLOCKED", task_id=task_id,
            expected_snapshot=snapshot or self.snapshot(),
            plan=plan, assignee=assignee, due_date="2027-11-10",
            idempotency_key=key or nonce())["action"]

    def listing(self, actor="owner-abc"):
        return self.rt.list_risk_actions(
            **self.scope(actor), scenario_id=self.scenario_id)

    def revise(self, action, changes, *, key=None):
        return self.rt.change_risk_action(
            **self.scope(), scenario_id=self.scenario_id,
            action_id=action["action_id"], expected_version=action["version"],
            changes=changes, idempotency_key=key or nonce())["action"]

    def test_create_from_actual_blocked_task_and_verified_chain(self):
        task_id = self.blocked()
        action = self.create(task_id)
        report = self.listing()
        self.assertEqual(report["counts"]["open"], 1)
        self.assertTrue(report["event_chains_verified"])
        self.assertEqual(action["risk_code"], "TASK_BLOCKED")
        self.assertEqual(action["task_id"], task_id)
        self.assertTrue(report["actions"][0]["risk_still_observed"])
        self.assertEqual(len(action["source_risk_sha256"]), 64)
        history = self.rt.risk_action_history(
            **self.scope(), scenario_id=self.scenario_id,
            action_id=action["action_id"])
        self.assertEqual(history["total"], 1)
        self.assertTrue(history["chain_verified"])

    def test_idempotency_retry_and_duplicate_risk_rejection(self):
        task_id = self.blocked()
        key = nonce()
        first = self.create(task_id, key=key)
        same = self.create(task_id, key=key)
        self.assertEqual(same, first)
        with self.assertRaises(ValueError):
            self.create(task_id, key=key, plan="Другая операция")
        with self.assertRaises(RiskActionDenied):
            self.create(task_id)
        self.assertEqual(self.listing()["counts"]["total"], 1)

    def test_stale_source_is_refused_without_writes(self):
        old = self.snapshot()
        task_id = self.blocked()
        with self.assertRaises(RiskActionDenied):
            self.create(task_id, snapshot=old)
        self.assertEqual(self.listing()["counts"]["total"], 0)

    def test_phantom_and_invalid_risk_rejected(self):
        task_id = self.tasks[0]["task_id"]
        with self.assertRaises(RiskActionDenied):
            self.create(task_id)
        with self.assertRaises(ValueError):
            self.rt.create_risk_action(
                **self.scope(), scenario_id=self.scenario_id,
                risk_code="INVENTED", task_id=task_id,
                expected_snapshot=self.snapshot(), plan="test",
                assignee=None, due_date=None, idempotency_key=nonce())

    def test_revisions_cas_and_resolve_with_note(self):
        task_id = self.blocked()
        first = self.create(task_id)
        doing = self.revise(first, {"status": "doing", "plan": "Связаться с командой"})
        self.assertEqual(doing["version"], 2)
        self.assertEqual(doing["status"], "doing")
        with self.assertRaises(RiskActionDenied):
            self.revise(first, {"status": "resolved", "note": "Устранено"})
        with self.assertRaises(RiskActionDenied):
            self.revise(doing, {"status": "resolved"})
        resolved = self.revise(doing, {"status": "resolved", "note": "Вручную проверено"})
        self.assertEqual(resolved["version"], 3)
        self.assertEqual(self.listing()["counts"]["resolved"], 1)
        history = self.rt.risk_action_history(
            **self.scope(), scenario_id=self.scenario_id,
            action_id=first["action_id"])
        self.assertEqual([e["sequence"] for e in history["events"]], [3, 2, 1])
        self.assertEqual(history["events"][0]["prev_sha256"],
                         history["events"][1]["sha256"])

    def test_reopen_requires_current_risk(self):
        task_id = self.blocked()
        first = self.create(task_id)
        resolved = self.revise(first, {"status": "resolved", "note": "На проверке"})
        open_again = self.revise(resolved, {"status": "open"})
        self.assertEqual(open_again["status"], "open")
        self.change(task_id, status="in_progress")
        after = self.revise(open_again, {"status": "resolved", "note": "Готово"})
        with self.assertRaises(RiskActionDenied):
            self.revise(after, {"status": "open"})

    def test_invalid_or_revoked_assignee_rejected(self):
        task_id = self.blocked()
        with self.assertRaises(ValueError):
            self.create(task_id, assignee="external-user")
        first = self.create(task_id)
        self.rt.policy.revoke_member(
            tenant="tenant_demo", project_id=self.project,
            owner_actor="owner-abc", member_actor="operator-abc",
            now=1799971202)
        with self.assertRaises(ValueError):
            self.revise(first, {"assignee": "operator-abc"})

    def test_cross_tenant_role_checks_do_not_leak_cards(self):
        task_id = self.blocked()
        action = self.create(task_id)
        self.enroll("viewer-abc", role="viewer")
        with self.assertRaises(AppAccessDenied):
            self.listing(actor="viewer-abc")
        with self.assertRaises(ValueError):
            self.rt.risk_action_history(
                **self.scope(), scenario_id=self.scenario_id,
                action_id="11111111-1111-4111-8111-111111111111")
        self.assertEqual(action["action_id"], self.listing()["actions"][0]["action_id"])

    def test_modifying_history_is_denied_by_sqlite_triggers(self):
        task_id = self.blocked()
        action = self.create(task_id)
        with self.rt.drafts._tx() as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM director_risk_action_events")
        with self.rt.drafts._tx() as db:
            db.execute(
                """UPDATE director_risk_actions SET payload_json='{}'
                   WHERE tenant=? AND project_id=? AND scenario_id=? AND action_id=?""",
                ("tenant_demo", self.project, self.scenario_id, action["action_id"]))
        with self.assertRaises(RiskActionDenied):
            self.listing()

    def test_csv_formula_neutralization_and_sha256(self):
        task_id = self.blocked()
        self.create(task_id, plan="=1+1")
        export = self.rt.risk_actions_csv(
            **self.scope(), scenario_id=self.scenario_id)
        self.assertEqual(export["rows"], 1)
        self.assertIn("'=1+1", export["csv"])
        self.assertTrue(export["verified_history"])
        import hashlib
        self.assertEqual(export["sha256"],
                         hashlib.sha256(export["csv"].encode("utf-8")).hexdigest())

    def test_wsgi_auth_and_request_allowlist(self):
        task_id = self.blocked()
        app = LocalConsole(self.db, tenant="tenant_demo", project_id=self.project,
                           actor="owner-abc", token=TOKEN, port=PORT)
        path = "/api/v1/scenarios/saved/" + self.scenario_id + "/actions"
        def invoke(method, uri, body=None, token=TOKEN):
            env = {}
            setup_testing_defaults(env)
            raw = b"" if body is None else json.dumps(body).encode("utf-8")
            env.update({"REQUEST_METHOD": method, "PATH_INFO": uri,
                        "REMOTE_ADDR": "127.0.0.1", "HTTP_HOST": f"127.0.0.1:{PORT}",
                        "HTTP_AUTHORIZATION": "Bearer "+token,
                        "CONTENT_TYPE": "application/json",
                        "CONTENT_LENGTH": str(len(raw)),
                        "wsgi.input": BytesIO(raw)})
            status = []
            data = b"".join(app(env, lambda code, headers: status.append(code)))
            return status[0], json.loads(data)
        self.assertTrue(invoke("GET", path, token="bad")[0].startswith("401"))
        self.assertTrue(invoke("POST", path, body={"junk": True})[0].startswith("400"))
        status, created = invoke("POST", path, body={
            "risk_code": "TASK_BLOCKED", "task_id": task_id,
            "expected_snapshot": self.snapshot(), "plan": "Проверить доступы",
            "assignee": None, "due_date": None, "idempotency_key": nonce()})
        self.assertTrue(status.startswith("201"), (status, created))
        self.assertEqual(invoke("GET", path)[1]["counts"]["total"], 1)
        actid = created["action"]["action_id"]
        patch = path + "/" + actid
        status, result = invoke("PATCH", patch, body={
            "expected_version": 1, "changes": {
                "status": "resolved", "note": "Причина проверена"},
            "idempotency_key": nonce()})
        self.assertTrue(status.startswith("200"), (status, result))
        self.assertEqual(invoke("GET", patch+"/history")[1]["total"], 2)
        self.assertEqual(invoke("GET", path+"/export")[1]["rows"], 1)


if __name__ == "__main__":
    unittest.main()
