"""Wave 19: real team conversations, checklist CAS and manager workload."""
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
from campaign180.task_collaboration import TaskCollaborationDenied
from campaign180.team_tasks import TaskDenied
from campaign180.local_http import LocalConsole

REPO = Path(__file__).resolve().parents[3]
DEMO = REPO / "supreme-director/campaign180/examples/demo-site.json"
TENANT = "tenant_demo"
OWNER = "owner-abc"
OPERATOR = "operator-abc"
OTHER = "other-abc"
VIEWER = "viewer-abc"
TOKEN = "W19_LocalToken_abcdefghABCDEFGHIJ_0123456789_XYZ"
PORT = 8774


def key():
    return "wave19-" + uuid.uuid4().hex


class Fixture(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db = Path(temp.name) / "tasks.sqlite3"
        spec = json.loads(DEMO.read_text(encoding="utf-8"))
        self.project = spec["project_id"]
        self.runtime = LocalAppRuntime(str(self.db))
        self.runtime.drafts.create(spec, tenant=TENANT)
        self.runtime.policy.bootstrap_owner(
            tenant=TENANT, project_id=self.project, actor=OWNER, now=1799971200
        )

    def scope(self, actor=OWNER, **params):
        return {"tenant": TENANT, "project_id": self.project,
                "actor": actor, **params}

    def enroll(self, actor, role="operator"):
        return self.runtime.policy.add_member(
            tenant=TENANT, project_id=self.project, owner_actor=OWNER,
            member_actor=actor, role=role, now=1799971201
        )

    def revoke(self, actor):
        return self.runtime.policy.revoke_member(
            tenant=TENANT, project_id=self.project, owner_actor=OWNER,
            member_actor=actor, now=1799971202
        )

    def task(self, *, title="Тестовая задача", assignee=None, due_date=None,
             priority="normal"):
        return self.runtime.create_team_task(
            **self.scope(), title=title, assignee=assignee,
            due_date=due_date, priority=priority,
            idempotency_key=key()
        )["task"]

    def comment(self, task, body="Запись обсуждения", *, actor=OWNER,
                idempotency_key=None):
        return self.runtime.add_task_comment(
            **self.scope(actor), task_id=task["task_id"], body=body,
            idempotency_key=idempotency_key or key()
        )

    def comments(self, task, *, actor=OWNER, **extra):
        return self.runtime.list_task_comments(
            **self.scope(actor), task_id=task["task_id"], **extra
        )

    def item(self, task, label="Принять результат", *, actor=OWNER,
             idempotency_key=None):
        return self.runtime.add_task_checklist_item(
            **self.scope(actor), task_id=task["task_id"], label=label,
            idempotency_key=idempotency_key or key()
        )["item"]

    def checklist(self, task, *, actor=OWNER):
        return self.runtime.list_task_checklist(
            **self.scope(actor), task_id=task["task_id"]
        )

    def toggle(self, task, item, done=True, *, actor=OWNER,
               idempotency_key=None, **extras):
        return self.runtime.set_task_checklist_done(
            **self.scope(actor), task_id=task["task_id"],
            item_id=item["item_id"], done=done,
            expected_version=item["version"],
            idempotency_key=idempotency_key or key(),
            **extras
        )["item"]

    def workload(self, actor=OWNER):
        return self.runtime.team_workload(**self.scope(actor))


class CommentsTests(Fixture):
    def test_comment_writes_real_database_record(self):
        task = self.task()
        saved = self.comment(task, "  Проверить готовность  ")
        self.assertTrue(saved["persisted_locally"])
        self.assertFalse(saved["production_published"])
        result = self.comments(task)
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["comments"][0]["body"], "Проверить готовность")

    def test_assigned_operator_can_comment_and_see_discussion(self):
        self.enroll(OPERATOR)
        task = self.task(assignee=OPERATOR)
        self.comment(task, "Владелец подготовил поручение")
        added = self.comment(task, "Выполняю", actor=OPERATOR)
        self.assertEqual(added["comment"]["actor"], OPERATOR)
        self.assertEqual(self.comments(task, actor=OPERATOR)["total"], 2)

    def test_unassigned_or_viewer_cannot_comment_or_read(self):
        self.enroll(OPERATOR)
        self.enroll(VIEWER, "viewer")
        task = self.task()
        with self.assertRaises(TaskCollaborationDenied):
            self.comment(task, actor=OPERATOR)
        with self.assertRaises(TaskCollaborationDenied):
            self.comments(task, actor=OPERATOR)
        with self.assertRaises(AppAccessDenied):
            self.comments(task, actor=VIEWER)
        with self.assertRaises(AppAccessDenied):
            self.comment(task, actor=VIEWER)

    def test_revocation_blocks_replay_and_discussion(self):
        self.enroll(OPERATOR)
        task = self.task(assignee=OPERATOR)
        nonce = key()
        first = self.comment(task, actor=OPERATOR, idempotency_key=nonce)
        self.assertEqual(first, self.comment(task, actor=OPERATOR,
                                             idempotency_key=nonce))
        self.revoke(OPERATOR)
        with self.assertRaises(AppAccessDenied):
            self.comment(task, actor=OPERATOR, idempotency_key=nonce)
        with self.assertRaises(AppAccessDenied):
            self.comments(task, actor=OPERATOR)
        self.assertEqual(self.comments(task)["total"], 1)

    def test_idempotency_collision_does_not_create_second_comment(self):
        task = self.task()
        nonce = key()
        self.comment(task, "Один", idempotency_key=nonce)
        with self.assertRaises(ValueError):
            self.comment(task, "Два", idempotency_key=nonce)
        self.assertEqual(self.comments(task)["total"], 1)

    def test_invalid_control_characters_and_comment_bounds(self):
        task = self.task()
        for value in ("", " ", "a" * 1001, "a\x00b"):
            with self.subTest(value=repr(value[:10])):
                with self.assertRaises(TaskDenied):
                    self.comment(task, value)
        with self.assertRaises(TaskCollaborationDenied):
            self.comments(task, limit=51)
        with self.assertRaises(TaskCollaborationDenied):
            self.comments(task, offset=-1)

    def test_comments_are_append_only_sqlite(self):
        task = self.task()
        self.comment(task, "Первоначальное сообщение")
        with self.runtime.drafts._tx() as db:
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE director_task_comments SET body='fake'")
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("DELETE FROM director_task_comments")
        self.assertEqual(self.comments(task)["total"], 1)

    def test_comment_digest_corruption_fails_closed(self):
        task = self.task()
        self.comment(task)
        with self.runtime.drafts._db() as db:
            db.execute("DROP TRIGGER director_comments_immutable_u")
            db.execute("UPDATE director_task_comments SET content_digest='broken'")
        with self.assertRaises(TaskCollaborationDenied):
            self.comments(task)

    def test_assignee_changed_hides_old_discussion_from_previous_operator(self):
        self.enroll(OPERATOR)
        self.enroll(OTHER)
        task = self.task(assignee=OPERATOR)
        self.comment(task, actor=OPERATOR)
        self.runtime.update_team_task(
            **self.scope(), task_id=task["task_id"],
            expected_version=1, changes={"assignee": OTHER},
            idempotency_key=key()
        )
        with self.assertRaises(TaskCollaborationDenied):
            self.comments(task, actor=OPERATOR)
        self.assertEqual(self.comments(task, actor=OTHER)["total"], 1)


class ChecklistTests(Fixture):
    def test_manager_creates_progress_items_in_sqlite(self):
        task = self.task()
        a = self.item(task, "Проанализировать")
        b = self.item(task, "Подтвердить")
        self.assertEqual(a["version"], 1)
        self.assertFalse(a["done"])
        result = self.checklist(task)
        self.assertEqual(result["total"], 2)
        self.assertEqual(result["completed"], 0)
        updated = self.toggle(task, a)
        self.assertEqual(updated["version"], 2)
        self.assertTrue(updated["done"])
        self.assertEqual(self.checklist(task)["completed"], 1)
        self.assertFalse(b["done"])

    def test_operator_can_toggle_only_assigned_task_checklist(self):
        self.enroll(OPERATOR)
        task = self.task(assignee=OPERATOR)
        item = self.item(task)
        changed = self.toggle(task, item, actor=OPERATOR)
        self.assertTrue(changed["done"])
        with self.assertRaises(AppAccessDenied):
            self.item(task, label="Сам себе приказал", actor=OPERATOR)

    def test_worker_reassignment_revokes_checklist_visibility_and_updates(self):
        self.enroll(OPERATOR)
        self.enroll(OTHER)
        task = self.task(assignee=OPERATOR)
        item = self.item(task)
        self.runtime.update_team_task(
            **self.scope(), task_id=task["task_id"], expected_version=1,
            changes={"assignee": OTHER}, idempotency_key=key()
        )
        with self.assertRaises(TaskCollaborationDenied):
            self.checklist(task, actor=OPERATOR)
        with self.assertRaises(TaskCollaborationDenied):
            self.toggle(task, item, actor=OPERATOR)
        self.assertEqual(self.checklist(task, actor=OTHER)["total"], 1)

    def test_stale_version_noop_and_invalid_boolean_denied(self):
        task = self.task()
        item = self.item(task)
        new = self.toggle(task, item)
        with self.assertRaises(TaskCollaborationDenied):
            self.toggle(task, item, done=False)
        with self.assertRaises(TaskCollaborationDenied):
            self.toggle(task, new, done=True)
        with self.assertRaises(TaskCollaborationDenied):
            self.runtime.set_task_checklist_done(
                **self.scope(), task_id=task["task_id"],
                item_id=item["item_id"], done=1,
                expected_version=new["version"], idempotency_key=key()
            )
        self.assertTrue(self.checklist(task)["items"][0]["done"])

    def test_retry_receipt_and_collision(self):
        task = self.task()
        item = self.item(task)
        nonce = key()
        first = self.toggle(task, item, idempotency_key=nonce)
        retry = self.toggle(task, item, idempotency_key=nonce)
        self.assertEqual(first, retry)
        with self.assertRaises(ValueError):
            self.toggle(task, item, done=False, idempotency_key=nonce)
        self.assertEqual(self.checklist(task)["completed"], 1)

    def test_invalid_item_label_quota_and_id_scope(self):
        task = self.task()
        for label in ("", " ", "x" * 161, "a\x00b"):
            with self.subTest(label=repr(label[:10])):
                with self.assertRaises(TaskDenied):
                    self.item(task, label)
        item = self.item(task)
        different = self.task(title="Другая задача")
        with self.assertRaises(TaskCollaborationDenied):
            self.toggle(different, item)
        with self.assertRaises(TaskCollaborationDenied):
            self.runtime.set_task_checklist_done(
                **self.scope(), task_id=task["task_id"],
                item_id="not-uuid", done=True,
                expected_version=1, idempotency_key=key()
            )

    def test_checklist_digest_corruption_detected(self):
        task = self.task()
        self.item(task)
        with self.runtime.drafts._db() as db:
            db.execute("UPDATE director_task_checklist SET item_digest='bad'")
        with self.assertRaises(TaskCollaborationDenied):
            self.checklist(task)

    def test_checklist_event_journal_immutable(self):
        task = self.task()
        item = self.item(task)
        self.toggle(task, item)
        with self.runtime.drafts._tx() as db:
            n = db.execute("SELECT COUNT(*) FROM director_checklist_events").fetchone()[0]
            self.assertEqual(n, 2)
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE director_checklist_events SET event_digest='bad'")
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("DELETE FROM director_checklist_events")

    def test_revocation_precedes_checklist_replay(self):
        self.enroll(OPERATOR)
        task = self.task(assignee=OPERATOR)
        item = self.item(task)
        nonce = key()
        self.toggle(task, item, actor=OPERATOR, idempotency_key=nonce)
        self.revoke(OPERATOR)
        with self.assertRaises(AppAccessDenied):
            self.toggle(task, item, actor=OPERATOR, idempotency_key=nonce)


classWorkloadPlaceholder = None


class WorkloadTests(Fixture):
    def test_manager_workload_counts_real_assignees_and_unassigned(self):
        self.enroll(OPERATOR)
        self.enroll(OTHER)
        self.task(title="Просрочено", assignee=OPERATOR,
                  due_date="2001-01-01", priority="urgent")
        active = self.task(title="В работе", assignee=OTHER)
        self.runtime.update_team_task(
            **self.scope(), task_id=active["task_id"], expected_version=1,
            changes={"status": "blocked"}, idempotency_key=key()
        )
        self.task(title="Без владельца")
        view = self.workload()
        self.assertEqual(view["task_count"], 3)
        members = {r["actor"]: r for r in view["members"]}
        self.assertEqual(members[OPERATOR]["overdue"], 1)
        self.assertEqual(members[OPERATOR]["high_priority_open"], 1)
        self.assertEqual(members[OTHER]["blocked"], 1)
        self.assertEqual(members[None]["open"], 1)
        self.assertTrue(view["local_only"])

    def test_operator_and_viewer_cannot_query_team_workload(self):
        self.enroll(OPERATOR)
        self.enroll(VIEWER, "viewer")
        with self.assertRaises(AppAccessDenied):
            self.workload(actor=OPERATOR)
        with self.assertRaises(AppAccessDenied):
            self.workload(actor=VIEWER)

    def test_revoked_member_is_kept_as_inactive_group_for_historical_tasks(self):
        self.enroll(OPERATOR)
        self.task(assignee=OPERATOR)
        self.revoke(OPERATOR)
        group = {x["actor"]: x for x in self.workload()["members"]}
        self.assertEqual(group[OPERATOR]["role"], "inactive")
        self.assertEqual(group[OPERATOR]["total"], 1)

    def test_due_filter_and_assignee_filter_preserve_project_boundaries(self):
        self.enroll(OPERATOR)
        today = datetime.now(timezone.utc).date()
        self.task(title="Пропущена", assignee=OPERATOR, due_date="2001-01-01")
        self.task(title="Сегодня", assignee=OPERATOR, due_date=today.isoformat())
        self.task(title="Позже", due_date=(today+timedelta(days=3)).isoformat())
        self.task(title="Без срока")
        query = self.runtime.query_team_tasks
        self.assertEqual(query(**self.scope(), due="overdue")["total"], 1)
        self.assertEqual(query(**self.scope(), due="today")["total"], 1)
        self.assertEqual(query(**self.scope(), due="next7")["total"], 2)
        self.assertEqual(query(**self.scope(), due="undated")["total"], 1)
        self.assertEqual(query(**self.scope(), assignee=OPERATOR)["total"], 2)
        self.assertEqual(query(**self.scope(), assignee="__unassigned__")["total"], 2)
        self.assertEqual(query(**self.scope(actor=OPERATOR))["total"], 2)
        with self.assertRaises(TaskDenied):
            query(**self.scope(actor=OPERATOR), assignee=OWNER)
        with self.assertRaises(TaskDenied):
            query(**self.scope(actor=OPERATOR), assignee="__unassigned__")

    def test_bad_due_and_assignee_filters_fail_closed(self):
        for arg in ({"due":"yesterday"}, {"due":100},
                    {"assignee":17}, {"assignee":"unknown!"}):
            with self.subTest(arg=arg):
                with self.assertRaises(TaskDenied):
                    self.runtime.query_team_tasks(**self.scope(), **arg)


class HTTPTests(Fixture):
    def call(self, path, data=None, *, method="POST", token=TOKEN, origin=None):
        app = LocalConsole(
            self.db, tenant=TENANT, project_id=self.project,
            actor=OWNER, token=TOKEN, port=PORT
        )
        env = {}
        setup_testing_defaults(env)
        body = json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else b""
        env.update({
            "REQUEST_METHOD": method, "PATH_INFO": path,
            "HTTP_HOST": f"127.0.0.1:{PORT}", "REMOTE_ADDR": "127.0.0.1",
            "QUERY_STRING": "", "HTTP_AUTHORIZATION": "Bearer " + token,
            "CONTENT_TYPE": "application/json",
            "CONTENT_LENGTH": str(len(body)),
            "wsgi.input": BytesIO(body),
        })
        if origin:
            env["HTTP_ORIGIN"] = origin
        result = []
        response = b"".join(app(env, lambda status, headers: result.append(status)))
        return result[0], json.loads(response)

    def test_http_comments_checklist_and_workload_end_to_end(self):
        task = self.task()
        stem = "/api/v1/tasks/" + task["task_id"]
        status, posted = self.call(stem + "/comments", {
            "body": "Пример комментария", "idempotency_key": key()
        })
        self.assertTrue(status.startswith("201"), (status, posted))
        status, listed = self.call(stem + "/comments", method="GET")
        self.assertTrue(status.startswith("200"))
        self.assertEqual(listed["total"], 1)
        status, item_resp = self.call(stem + "/checklist", {
            "label": "Проверить результат", "idempotency_key": key()
        })
        self.assertTrue(status.startswith("201"), (status, item_resp))
        item = item_resp["item"]
        status, toggle = self.call(
            stem + "/checklist/" + item["item_id"],
            {"expected_version": 1, "done": True, "idempotency_key": key()},
            method="PATCH")
        self.assertTrue(status.startswith("200"), (status, toggle))
        status, checklist = self.call(stem + "/checklist", method="GET")
        self.assertTrue(status.startswith("200"))
        self.assertEqual(checklist["completed"], 1)
        status, workload = self.call("/api/v1/tasks/workload", method="GET")
        self.assertTrue(status.startswith("200"))
        self.assertEqual(workload["task_count"], 1)

    def test_http_rejects_spoofed_identity_invalid_origin_and_token(self):
        task = self.task()
        route = "/api/v1/tasks/" + task["task_id"] + "/comments"
        payload = {"body": "Плохой запрос", "idempotency_key": key()}
        code, _ = self.call(route, payload, token="invalid")
        self.assertTrue(code.startswith("401"))
        code, _ = self.call(route, payload, origin="https://evil.invalid")
        self.assertTrue(code.startswith("403"))
        code, _ = self.call(route, {**payload, "actor": OWNER})
        self.assertTrue(code.startswith("400"))
        self.assertEqual(self.comments(task)["total"], 0)


if __name__ == "__main__":
    unittest.main()
