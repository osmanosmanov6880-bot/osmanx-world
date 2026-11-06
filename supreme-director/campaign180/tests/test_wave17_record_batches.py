"""Wave 17: actual SQLite batch mutation, immutable history and safe undo tests."""
from __future__ import annotations

from io import BytesIO
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from wsgiref.util import setup_testing_defaults

from campaign180.app_runtime import LocalAppRuntime, RULE_SCHEMA
from campaign180.app_policy import AppAccessDenied
from campaign180.record_batches import RecordBatchDenied
from campaign180.local_http import LocalConsole

REPO = Path(__file__).resolve().parents[3]
DEMO = REPO / "supreme-director/campaign180/examples/demo-site.json"
TENANT = "tenant_demo"
OWNER = "owner-abc"
EDITOR = "editor-abc"
OPERATOR = "operator-abc"
VIEWER = "viewer-abc"
TOKEN = "BATCH_LOCAL_CHECK_abcdefghijklmnopqrstuv_0123456789"
PORT = 8768


def nonce():
    return "batch-" + uuid.uuid4().hex


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.database = Path(tmp.name) / "test.sqlite3"
        self.spec = json.loads(DEMO.read_text(encoding="utf-8"))
        self.project = self.spec["project_id"]
        self.runtime = LocalAppRuntime(str(self.database))
        self.runtime.drafts.create(self.spec, tenant=TENANT)
        self.runtime.policy.bootstrap_owner(
            tenant=TENANT, project_id=self.project, actor=OWNER, now=1799971200
        )

    def ctx(self, model="customers", actor=OWNER):
        return {"tenant": TENANT, "project_id": self.project,
                "actor": actor, "model": model}

    def create(self, name, email=None):
        data = {"name": name}
        if email is not None:
            data["email"] = email
        return self.runtime.create_row(
            **self.ctx(), data=data, idempotency_key=nonce()
        )

    def rows(self, model="customers"):
        return self.runtime.list_rows(**self.ctx(model=model))

    def item(self, row_id):
        return next(x for x in self.rows() if x["row_id"] == row_id)

    @staticmethod
    def patch(receipt, **changes):
        return {"row_id": receipt["row_id"],
                "expected_version": receipt["version"],
                "changes": changes}

    def inspect(self, patches, **options):
        return self.runtime.inspect_batch_update(
            **{**self.ctx(), "expected_revision": 1,
               "patches": patches, **options}
        )

    def apply(self, patches, plan=None, **options):
        if plan is None:
            plan = self.inspect(patches)
        return self.runtime.apply_batch_update(
            **{**self.ctx(), "expected_revision": 1,
               "patches": patches,
               "expected_plan_sha256": plan["expected_plan_sha256"],
               "idempotency_key": nonce(), **options}
        )

    def undo_inspect(self, batch_id, **options):
        return self.runtime.inspect_batch_restore(
            **{**self.ctx(), "batch_id": batch_id,
               "expected_revision": 1, **options}
        )

    def undo(self, batch_id, plan=None, **options):
        if plan is None:
            plan = self.undo_inspect(batch_id)
        return self.runtime.apply_batch_restore(
            **{**self.ctx(), "batch_id": batch_id,
               "expected_revision": 1,
               "expected_plan_sha256": plan["expected_plan_sha256"],
               "idempotency_key": nonce(), **options}
        )

    def history(self, **options):
        return self.runtime.list_batch_history(**{**self.ctx(), **options})


class BatchEditTests(Base):
    def test_two_rows_change_atomically_and_unselected_row_remains(self):
        a, b, extra = self.create("Алина"), self.create("Борис"), self.create("Другой")
        patches = [self.patch(a, email="group@example.org"),
                   self.patch(b, email="group@example.org")]
        preview = self.inspect(patches)
        self.assertEqual(preview["count"], 2)
        self.assertTrue(preview["preview_only"])
        self.assertEqual(len(self.history()["history"]), 0)
        receipt = self.apply(patches, preview)
        self.assertEqual(receipt["updated"], 2)
        self.assertTrue(receipt["persisted_locally"])
        self.assertEqual(self.item(a["row_id"])["fields"]["email"], "group@example.org")
        self.assertEqual(self.item(b["row_id"])["version"], 2)
        self.assertNotIn("email", self.item(extra["row_id"])["fields"])

    def test_shuffled_patches_produce_same_plan_digest(self):
        a, b = self.create("Алина"), self.create("Борис")
        patches = [self.patch(a, name="Имя 1"), self.patch(b, name="Имя 2")]
        self.assertEqual(self.inspect(patches)["expected_plan_sha256"],
                         self.inspect(list(reversed(patches)))["expected_plan_sha256"])

    def test_batch_replay_has_one_effect_and_changed_request_is_rejected(self):
        a = self.create("Начало")
        patches = [self.patch(a, name="Финиш")]
        plan = self.inspect(patches)
        key = nonce()
        first = self.apply(patches, plan, idempotency_key=key)
        second = self.apply(patches, plan, idempotency_key=key)
        self.assertEqual(first, second)
        self.assertEqual(len(self.history()["history"]), 1)
        with self.assertRaises(ValueError):
            self.apply([self.patch(a, name="Разное")],
                       plan, idempotency_key=key)

    def test_stale_edit_rolls_back_all_rows(self):
        a, b = self.create("Алина"), self.create("Борис")
        patches = [self.patch(a, email="a@example.org"),
                   self.patch(b, email="b@example.org")]
        plan = self.inspect(patches)
        self.runtime.update_row(
            **self.ctx(), row_id=b["row_id"], expected_version=1,
            changes={"name": "Текущее"}, idempotency_key=nonce()
        )
        with self.assertRaises(RecordBatchDenied):
            self.apply(patches, plan)
        self.assertNotIn("email", self.item(a["row_id"])["fields"])
        self.assertFalse(self.history()["history"])

    def test_invalid_second_row_prevents_first_update(self):
        a = self.create("Первый")
        b = self.create("Второй")
        with self.assertRaises(ValueError):
            self.inspect([self.patch(a, name="Новый"),
                          self.patch(b, email="invalid-email")])
        self.assertEqual(self.item(a["row_id"])["fields"]["name"], "Первый")
        self.assertEqual(len(self.history()["history"]), 0)

    def test_duplicate_unknown_and_unchanged_patches_denied(self):
        a = self.create("Первый")
        for patches in (
            [self.patch(a, name="X"), self.patch(a, name="Y")],
            [self.patch(a, hidden="no")],
            [self.patch(a, name="Первый")],
            [self.patch(a, name=123)],
            [self.patch(a, name="Новое"), self.patch(
                {"row_id": str(uuid.uuid4()), "version": 1}, name="Нет")],
        ):
            with self.subTest(patches=patches):
                with self.assertRaises(ValueError):
                    self.inspect(patches)
        self.assertEqual(self.item(a["row_id"])["version"], 1)

    def test_batch_size_and_boolean_version_restrictions(self):
        a = self.create("Алина")
        with self.assertRaises(RecordBatchDenied):
            self.inspect([])
        with self.assertRaises(RecordBatchDenied):
            self.inspect([self.patch(a, name="Другой")] * 26)
        with self.assertRaises(RecordBatchDenied):
            self.inspect([{"row_id": a["row_id"],
                           "expected_version": True,
                           "changes": {"name": "Новый"}}])
        with self.assertRaises(RecordBatchDenied):
            self.inspect([{"row_id": a["row_id"],
                           "expected_version": 1,
                           "changes": {"name": "Новый"}, "tenant": TENANT}])

    def test_workflow_triggers_and_journal_captures_final_snapshot(self):
        rule = {
            "schema": RULE_SCHEMA, "name": "Отметить правку",
            "model": "customers", "trigger": "record.updated",
            "condition": None,
            "action": {"type": "set_field", "field": "email",
                       "value": "workflow@example.org"},
        }
        self.runtime.add_workflow(
            tenant=TENANT, project_id=self.project, actor=OWNER, rule=rule
        )
        a = self.create("До")
        patches = [self.patch(a, name="После")]
        receipt = self.apply(patches)
        self.assertEqual(receipt["automatic_workflows"], 1)
        current = self.item(a["row_id"])
        self.assertEqual(current["version"], 3)
        self.assertEqual(current["fields"]["email"], "workflow@example.org")
        undo_plan = self.undo_inspect(receipt["batch_id"])
        self.assertEqual(undo_plan["count"], 1)

    def test_record_reference_updates_link_index_and_undo_recovers_it(self):
        a, b = self.create("A"), self.create("B")
        request = self.runtime.create_row(
            **self.ctx(model="requests"),
            data={"customer": a["row_id"], "summary": "Исходная заявка"},
            idempotency_key=nonce(),
        )
        patch = [{
            "row_id": request["row_id"], "expected_version": 1,
            "changes": {"customer": b["row_id"]},
        }]
        plan = self.inspect(patch, model="requests")
        receipt = self.apply(patch, plan, model="requests")
        with self.runtime.drafts._db() as db:
            link = db.execute(
                """SELECT target_row_id FROM builder_links WHERE tenant=? AND
                   project_id=? AND model='requests' AND row_id=?""",
                (TENANT, self.project, request["row_id"]),
            ).fetchone()
            self.assertEqual(link["target_row_id"], b["row_id"])
        undo_plan = self.undo_inspect(receipt["batch_id"], model="requests")
        restored = self.undo(receipt["batch_id"], undo_plan, model="requests")
        self.assertEqual(restored["restored"], 1)
        with self.runtime.drafts._db() as db:
            link = db.execute(
                """SELECT target_row_id FROM builder_links WHERE tenant=? AND
                   project_id=? AND model='requests' AND row_id=?""",
                (TENANT, self.project, request["row_id"]),
            ).fetchone()
            self.assertEqual(link["target_row_id"], a["row_id"])

    def test_owner_editor_can_apply_operator_can_apply_but_cannot_undo(self):
        a = self.create("Алина")
        for actor, role in ((EDITOR, "editor"), (OPERATOR, "operator"),
                            (VIEWER, "viewer")):
            self.runtime.policy.add_member(
                tenant=TENANT, project_id=self.project, owner_actor=OWNER,
                member_actor=actor, role=role, now=1799971201,
            )
        patch = [self.patch(a, name="Ирина")]
        with self.assertRaises(AppAccessDenied):
            self.inspect(patch, actor=VIEWER)
        inspected = self.inspect(patch, actor=OPERATOR)
        receipt = self.apply(patch, inspected, actor=OPERATOR)
        self.assertEqual(receipt["updated"], 1)
        with self.assertRaises(AppAccessDenied):
            self.undo_inspect(receipt["batch_id"], actor=OPERATOR)
        self.assertEqual(self.undo_inspect(receipt["batch_id"], actor=EDITOR)["count"], 1)

    def test_cross_tenant_project_model_are_not_accessible(self):
        a = self.create("A")
        patch = [self.patch(a, name="B")]
        for changed in ({"tenant": "tenant_other"},
                        {"project_id": str(uuid.uuid4())},
                        {"model": "requests"}):
            with self.subTest(changed=changed):
                with self.assertRaises(ValueError):
                    self.inspect(patch, **changed)
        self.assertEqual(self.rows()[0]["fields"]["name"], "A")


class JournalUndoTests(Base):
    def test_history_never_exposes_before_after_customer_values(self):
        a = self.create("PRIVATE BEFORE", "private@example.org")
        receipt = self.apply([self.patch(a, name="PRIVATE AFTER")])
        history = self.history()
        self.assertTrue(history["immutable"])
        self.assertFalse(history["values_exposed"])
        self.assertEqual(len(history["history"]), 1)
        serialized = json.dumps(history, ensure_ascii=False)
        self.assertNotIn("PRIVATE BEFORE", serialized)
        self.assertNotIn("PRIVATE AFTER", serialized)
        self.assertNotIn("private@example.org", serialized)
        self.assertEqual(history["history"][0]["entry_digest"],
                         receipt["entry_digest"])

    def test_restore_is_new_revision_and_journal_is_append_only(self):
        a = self.create("Старое")
        receipt = self.apply([self.patch(a, name="Новое")])
        self.assertEqual(self.item(a["row_id"])["version"], 2)
        inspection = self.undo_inspect(receipt["batch_id"])
        self.assertTrue(inspection["automatic_workflows_will_not_replay"])
        restored = self.undo(receipt["batch_id"], inspection)
        self.assertEqual(restored["restored"], 1)
        self.assertEqual(self.item(a["row_id"])["fields"]["name"], "Старое")
        self.assertEqual(self.item(a["row_id"])["version"], 3)
        history = self.history()["history"]
        self.assertEqual(len(history), 2)
        self.assertEqual({x["operation"] for x in history}, {"UPDATE", "RESTORE"})
        self.assertTrue(any(x["parent_batch_id"] == receipt["batch_id"] for x in history))

    def test_undo_idempotent_and_second_independent_undo_denied(self):
        a = self.create("До")
        batch = self.apply([self.patch(a, name="После")])
        review = self.undo_inspect(batch["batch_id"])
        key = nonce()
        first = self.undo(batch["batch_id"], review, idempotency_key=key)
        replay = self.undo(batch["batch_id"], review, idempotency_key=key)
        self.assertEqual(first, replay)
        with self.assertRaises(RecordBatchDenied):
            self.undo(batch["batch_id"], review, idempotency_key=nonce())
        self.assertEqual(len(self.history()["history"]), 2)

    def test_restore_blocked_after_any_subsequent_row_edit(self):
        a = self.create("Старая")
        batch = self.apply([self.patch(a, name="Новая")])
        current = self.item(a["row_id"])
        self.runtime.update_row(
            **self.ctx(), row_id=a["row_id"],
            expected_version=current["version"],
            changes={"name": "Позднее изменение"}, idempotency_key=nonce(),
        )
        with self.assertRaises(RecordBatchDenied):
            self.undo_inspect(batch["batch_id"])
        self.assertEqual(self.item(a["row_id"])["fields"]["name"],
                         "Позднее изменение")

    def test_schema_change_blocks_old_batch_restore(self):
        a = self.create("До")
        batch = self.apply([self.patch(a, name="После")])
        new_spec = self.runtime.get_spec(
            tenant=TENANT, project_id=self.project, actor=OWNER)["spec"]
        new_spec["description"] = "Изменённая схема"
        self.runtime.drafts.save(
            tenant=TENANT, project_id=self.project, expected_revision=1,
            spec=new_spec,
        )
        with self.assertRaises(RecordBatchDenied):
            self.undo_inspect(batch["batch_id"])
        self.assertEqual(self.item(a["row_id"])["fields"]["name"], "После")

    def test_wrong_digest_rejects_restore_without_mutation(self):
        a = self.create("До")
        batch = self.apply([self.patch(a, name="После")])
        with self.assertRaises(RecordBatchDenied):
            self.undo(batch["batch_id"], expected_plan_sha256="0" * 64)
        self.assertEqual(self.item(a["row_id"])["fields"]["name"], "После")

    def test_revoked_actor_cannot_replay_successful_batch(self):
        a = self.create("До")
        self.runtime.policy.add_member(
            tenant=TENANT, project_id=self.project, owner_actor=OWNER,
            member_actor=EDITOR, role="editor", now=1799971201,
        )
        patch = [self.patch(a, name="После")]
        plan = self.inspect(patch, actor=EDITOR)
        key = nonce()
        self.apply(patch, plan, actor=EDITOR, idempotency_key=key)
        self.runtime.policy.revoke_member(
            tenant=TENANT, project_id=self.project, owner_actor=OWNER,
            member_actor=EDITOR, now=1799971202,
        )
        with self.assertRaises(AppAccessDenied):
            self.apply(patch, plan, actor=EDITOR, idempotency_key=key)
        self.assertEqual(len(self.history()["history"]), 1)

    def test_sqlite_journal_is_immutable_by_trigger(self):
        a = self.create("До")
        batch = self.apply([self.patch(a, name="После")])
        with self.runtime.drafts._tx() as db:
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute(
                    "UPDATE record_batch_journal SET actor='x' WHERE batch_id=?",
                    (batch["batch_id"],),
                )
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute(
                    "DELETE FROM record_batch_journal WHERE batch_id=?",
                    (batch["batch_id"],),
                )

    def test_digest_tampering_fails_closed_even_when_trigger_is_removed(self):
        a = self.create("До")
        self.apply([self.patch(a, name="После")])
        with self.runtime.drafts._db() as db:
            db.execute("DROP TRIGGER record_batch_journal_immutable_update")
            db.execute("UPDATE record_batch_journal SET entry_digest='broken'")
        with self.assertRaises(RecordBatchDenied):
            self.history()

    def test_rollback_does_not_replay_automatic_workflows(self):
        rule = {
            "schema": RULE_SCHEMA, "name": "Пометить",
            "model": "customers", "trigger": "record.updated",
            "condition": None,
            "action": {"type": "set_field", "field": "email",
                       "value": "workflow@example.org"},
        }
        self.runtime.add_workflow(
            tenant=TENANT, project_id=self.project, actor=OWNER, rule=rule
        )
        a = self.create("До")
        batch = self.apply([self.patch(a, name="После")])
        with self.runtime.drafts._db() as db:
            before = db.execute("SELECT COUNT(*) FROM app_workflow_runs").fetchone()[0]
        self.undo(batch["batch_id"])
        with self.runtime.drafts._db() as db:
            after = db.execute("SELECT COUNT(*) FROM app_workflow_runs").fetchone()[0]
        self.assertEqual(before, after)
        self.assertEqual(self.item(a["row_id"])["fields"]["name"], "До")
        self.assertNotIn("email", self.item(a["row_id"])["fields"])

    def test_history_limit_and_unknown_model_fail_closed(self):
        a = self.create("До")
        self.apply([self.patch(a, name="После")])
        with self.assertRaises(RecordBatchDenied):
            self.history(limit=31)
        with self.assertRaises(ValueError):
            self.history(model="invalid")
        self.assertEqual(len(self.history(limit=1)["history"]), 1)


class HTTPTests(Base):
    def request(self, path, data, *, token=TOKEN, origin=None):
        web = LocalConsole(
            self.database, tenant=TENANT, project_id=self.project,
            actor=OWNER, token=TOKEN, port=PORT,
        )
        env = {}
        setup_testing_defaults(env)
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        env.update({
            "REQUEST_METHOD": "POST", "PATH_INFO": path,
            "HTTP_HOST": f"127.0.0.1:{PORT}",
            "REMOTE_ADDR": "127.0.0.1", "QUERY_STRING": "",
            "CONTENT_TYPE": "application/json", "CONTENT_LENGTH": str(len(raw)),
            "wsgi.input": BytesIO(raw),
            "HTTP_AUTHORIZATION": "Bearer " + token,
        })
        if origin:
            env["HTTP_ORIGIN"] = origin
        status = []
        response = b"".join(
            web(env, lambda code, headers: status.append(code))
        )
        return status[0], json.loads(response)

    def test_full_http_inspect_apply_journal_and_confirmed_undo(self):
        a = self.create("Исходное")
        stem = "/api/v1/models/customers/batch"
        inspection = {
            "expected_revision": 1,
            "patches": [self.patch(a, name="Новый вариант")],
        }
        status, plan = self.request(stem + "/inspect", inspection)
        self.assertTrue(status.startswith("200"), (status, plan))
        status, applied = self.request(stem + "/apply", {
            **inspection, "expected_plan_sha256": plan["expected_plan_sha256"],
            "idempotency_key": nonce(),
        })
        self.assertTrue(status.startswith("201"), (status, applied))
        status, history = self.request(stem + "/history", {"limit": 20})
        self.assertTrue(status.startswith("200"))
        self.assertFalse(history["values_exposed"])
        self.assertEqual(history["history"][0]["batch_id"], applied["batch_id"])
        status, restore_plan = self.request(stem + "/restore/inspect", {
            "batch_id": applied["batch_id"], "expected_revision": 1,
        })
        self.assertTrue(status.startswith("200"), (status, restore_plan))
        status, restored = self.request(stem + "/restore/apply", {
            "batch_id": applied["batch_id"], "expected_revision": 1,
            "expected_plan_sha256": restore_plan["expected_plan_sha256"],
            "idempotency_key": nonce(),
        })
        self.assertTrue(status.startswith("201"), (status, restored))
        self.assertEqual(self.item(a["row_id"])["fields"]["name"], "Исходное")
        self.assertEqual(self.item(a["row_id"])["version"], 3)

    def test_http_denies_no_token_origin_and_spoofed_principal(self):
        a = self.create("Алина")
        payload = {"expected_revision": 1,
                   "patches": [self.patch(a, name="Другое")]}
        route = "/api/v1/models/customers/batch/inspect"
        status, _ = self.request(route, payload, token="invalid")
        self.assertTrue(status.startswith("401"))
        status, _ = self.request(route, payload, origin="https://evil.invalid")
        self.assertTrue(status.startswith("403"))
        status, _ = self.request(route, {
            **payload, "actor": "owner-abc", "tenant": "tenant_demo",
        })
        self.assertTrue(status.startswith("400"))
        self.assertEqual(self.item(a["row_id"])["fields"]["name"], "Алина")


if __name__ == "__main__":
    unittest.main()
