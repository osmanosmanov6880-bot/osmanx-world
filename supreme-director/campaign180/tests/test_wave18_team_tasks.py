"""Wave 18: real task assignments, role-limited progress and manager metrics."""
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
from campaign180.team_tasks import TaskDenied
from campaign180.local_http import LocalConsole

REPO = Path(__file__).resolve().parents[3]
DEMO = REPO / "supreme-director/campaign180/examples/demo-site.json"
TENANT = "tenant_demo"
OWNER = "owner-abc"
EDITOR = "editor-abc"
OPERATOR = "operator-abc"
OTHER = "other-abc"
VIEWER = "viewer-abc"
TOKEN = "TaskLocalStrongToken_abcdefgh0123456789_XYZ-Pq"
PORT = 8773


def key():
    return "task-" + uuid.uuid4().hex


class TaskFixture(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.db = Path(scratch.name) / "work.sqlite3"
        spec = json.loads(DEMO.read_text(encoding="utf-8"))
        self.project = spec["project_id"]
        self.runtime = LocalAppRuntime(str(self.db))
        self.runtime.drafts.create(spec, tenant=TENANT)
        self.runtime.policy.bootstrap_owner(
            tenant=TENANT, project_id=self.project,
            actor=OWNER, now=1799971200,
        )

    def enroll(self, actor, role="operator"):
        return self.runtime.policy.add_member(
            tenant=TENANT, project_id=self.project,
            owner_actor=OWNER, member_actor=actor, role=role,
            now=1799971201,
        )

    def args(self, actor=OWNER):
        return {"tenant": TENANT, "project_id": self.project, "actor": actor}

    def create(self, title="Новая задача", **other):
        return self.runtime.create_team_task(
            **self.args(), title=title,
            idempotency_key=key(), **other,
        )["task"]

    def change(self, task, changes, actor=OWNER, **extra):
        return self.runtime.update_team_task(
            **self.args(actor=actor), task_id=task["task_id"],
            expected_version=task["version"],
            changes=changes,
            idempotency_key=key(), **extra,
        )["task"]

    def tasks(self, actor=OWNER, **other):
        return self.runtime.query_team_tasks(**self.args(actor=actor), **other)["tasks"]

    def summary(self, actor=OWNER):
        return self.runtime.team_task_summary(**self.args(actor=actor))["metrics"]

    def history(self, task, actor=OWNER):
        return self.runtime.team_task_history(
            **self.args(actor=actor), task_id=task["task_id"]
        )


class TaskCoreTests(TaskFixture):
    def test_default_task_written_and_visible_in_sqlite(self):
        task = self.create("Проверить заказ", description="Сверить счет")
        self.assertEqual(task["title"], "Проверить заказ")
        self.assertEqual(task["status"], "todo")
        self.assertEqual(task["priority"], "normal")
        self.assertEqual(task["version"], 1)
        self.assertIsNone(task["assignee"])
        self.assertEqual(self.tasks()[0]["task_id"], task["task_id"])
        self.assertEqual(self.summary()["total"], 1)

    def test_explicit_assignee_and_calendar_priority(self):
        self.enroll(OPERATOR)
        task = self.create("Срочная задача", assignee=OPERATOR,
                           due_date="2027-05-18", priority="urgent")
        self.assertEqual(self.tasks(actor=OPERATOR)[0]["task_id"], task["task_id"])
        self.assertEqual(task["due_date"], "2027-05-18")
        self.assertEqual(task["priority"], "urgent")

    def test_invalid_fields_and_unknown_priority_rejected(self):
        for values in (
            {"title": ""},
            {"title": "X" * 141},
            {"title": "New\nBad\u0000"},
            {"description": "Y" * 1201},
            {"priority": "super-admin"},
            {"due_date": "2026-02-30"},
            {"due_date": "06-11-2026"},
            {"due_date": "1901-01-01"},
            {"due_date": 12},
            {"assignee": "??"},
        ):
            with self.subTest(values=values):
                with self.assertRaises(TaskDenied):
                    self.runtime.create_team_task(
                        **self.args(), idempotency_key=key(),
                        **{"title": "Valid", **values},
                    )
        self.assertEqual(self.summary()["total"], 0)

    def test_cannot_assign_missing_or_viewer_or_revoked_worker(self):
        self.enroll(VIEWER, "viewer")
        self.enroll(OPERATOR, "operator")
        for assignee in (VIEWER, OTHER):
            with self.subTest(assignee=assignee):
                with self.assertRaises(TaskDenied):
                    self.create("Назначение", assignee=assignee)
        self.runtime.policy.revoke_member(
            tenant=TENANT, project_id=self.project, owner_actor=OWNER,
            member_actor=OPERATOR, now=1799971202,
        )
        with self.assertRaises(TaskDenied):
            self.create("После отзыва", assignee=OPERATOR)
        self.assertEqual(self.summary()["total"], 0)

    def test_assignee_list_is_active_and_manager_only(self):
        self.enroll(OPERATOR)
        self.enroll(EDITOR, "editor")
        self.enroll(VIEWER, "viewer")
        members = self.runtime.task_members(**self.args())["members"]
        self.assertEqual({m["actor"] for m in members}, {OWNER, OPERATOR, EDITOR})
        with self.assertRaises(AppAccessDenied):
            self.runtime.task_members(**self.args(actor=OPERATOR))

    def test_manager_can_edit_description_priority_due_and_reassign(self):
        self.enroll(OPERATOR)
        self.enroll(OTHER)
        original = self.create("Начало", assignee=OPERATOR)
        result = self.change(original, {
            "title": "Новый заголовок", "description": "Новый результат",
            "priority": "high", "assignee": OTHER, "due_date": "2028-10-23",
        })
        self.assertEqual(result["version"], 2)
        self.assertEqual(result["assignee"], OTHER)
        self.assertEqual(self.tasks(actor=OTHER)[0]["task_id"], original["task_id"])
        self.assertEqual(self.tasks(actor=OPERATOR), [])

    def test_worker_can_only_advance_own_status(self):
        self.enroll(OPERATOR)
        self.enroll(OTHER)
        task = self.create("В работу", assignee=OPERATOR)
        with self.assertRaises(TaskDenied):
            self.change(task, {"status": "done"}, actor=OPERATOR)
        with self.assertRaises(TaskDenied):
            self.change(task, {"title": "Смена текста"}, actor=OPERATOR)
        with self.assertRaises(TaskDenied):
            self.change(task, {"status": "in_progress"}, actor=OTHER)
        started = self.change(task, {"status": "in_progress"}, actor=OPERATOR)
        blocked = self.change(started, {"status": "blocked"}, actor=OPERATOR)
        resumed = self.change(blocked, {"status": "in_progress"}, actor=OPERATOR)
        finished = self.change(resumed, {"status": "done"}, actor=OPERATOR)
        self.assertEqual(finished["version"], 5)
        with self.assertRaises(TaskDenied):
            self.change(finished, {"status": "in_progress"}, actor=OPERATOR)
        self.assertEqual(self.summary()["done"], 1)

    def test_manager_can_reopen_task(self):
        self.enroll(OPERATOR)
        start = self.create("Проверить", assignee=OPERATOR)
        running = self.change(start, {"status": "in_progress"}, actor=OPERATOR)
        done = self.change(running, {"status": "done"}, actor=OPERATOR)
        reopened = self.change(done, {"status": "todo"})
        self.assertEqual(reopened["status"], "todo")
        self.assertEqual(reopened["version"], 4)

    def test_stale_update_does_not_overwrite_newer_task(self):
        initial = self.create("Версия 1")
        newer = self.change(initial, {"priority": "high"})
        with self.assertRaises(TaskDenied):
            self.change(initial, {"priority": "urgent"})
        self.assertEqual(self.tasks()[0]["version"], newer["version"])
        self.assertEqual(self.tasks()[0]["priority"], "high")

    def test_create_idempotent_and_reused_key_collision(self):
        request = {**self.args(), "title": "Повторный запрос",
                   "idempotency_key": key()}
        first = self.runtime.create_team_task(**request)
        replay = self.runtime.create_team_task(**request)
        self.assertEqual(first, replay)
        with self.assertRaises(ValueError):
            self.runtime.create_team_task(**{**request, "title": "Подмена"})
        self.assertEqual(self.summary()["total"], 1)

    def test_update_idempotency_rejects_changed_request(self):
        first = self.create("Изменить")
        request = {
            **self.args(), "task_id": first["task_id"],
            "expected_version": 1, "changes": {"priority": "high"},
            "idempotency_key": key(),
        }
        a = self.runtime.update_team_task(**request)
        b = self.runtime.update_team_task(**request)
        self.assertEqual(a, b)
        with self.assertRaises(ValueError):
            self.runtime.update_team_task(**{
                **request, "changes": {"priority": "urgent"},
            })
        self.assertEqual(self.tasks()[0]["version"], 2)

    def test_noop_and_invalid_update_and_unrecognized_field(self):
        task = self.create("Текущая")
        for changes in ({}, {"title": "Текущая"}, {"state": "hidden"},
                        {"status": "garbage"}, {"due_date": "2026-02-30"}):
            with self.subTest(changes=changes):
                with self.assertRaises(TaskDenied):
                    self.change(task, changes)
        self.assertEqual(self.tasks()[0]["version"], 1)

    def test_operator_sees_only_assigned_and_viewer_none(self):
        self.enroll(OPERATOR)
        self.enroll(OTHER)
        self.enroll(VIEWER, "viewer")
        own = self.create("Оператору", assignee=OPERATOR)
        self.create("Другому", assignee=OTHER)
        self.create("Без ответственного")
        self.assertEqual(len(self.tasks(actor=OPERATOR)), 1)
        self.assertEqual(self.tasks(actor=OPERATOR)[0]["task_id"], own["task_id"])
        self.assertEqual(self.summary(actor=OPERATOR)["total"], 1)
        with self.assertRaises(AppAccessDenied):
            self.runtime.query_team_tasks(**self.args(actor=VIEWER))
        with self.assertRaises(AppAccessDenied):
            self.runtime.team_task_summary(**self.args(actor=VIEWER))

    def test_role_revocation_blocks_reads_status_and_receipt_replay(self):
        self.enroll(OPERATOR)
        initial = self.create("Оператор", assignee=OPERATOR)
        request = {
            **self.args(actor=OPERATOR), "task_id": initial["task_id"],
            "expected_version": 1, "changes": {"status": "in_progress"},
            "idempotency_key": key(),
        }
        self.runtime.update_team_task(**request)
        self.runtime.policy.revoke_member(
            tenant=TENANT, project_id=self.project, owner_actor=OWNER,
            member_actor=OPERATOR, now=1799971202,
        )
        with self.assertRaises(AppAccessDenied):
            self.runtime.query_team_tasks(**self.args(actor=OPERATOR))
        with self.assertRaises(AppAccessDenied):
            self.runtime.update_team_task(**request)

    def test_query_status_filter_and_pagination(self):
        for index in range(32):
            self.create("Задача " + str(index))
        one = self.runtime.query_team_tasks(
            **self.args(), limit=10, offset=0
        )
        two = self.runtime.query_team_tasks(
            **self.args(), limit=10, offset=10
        )
        self.assertEqual(one["total"], 32)
        self.assertTrue(one["has_more"])
        self.assertEqual(len(set(x["task_id"] for x in one["tasks"] + two["tasks"])),20)
        self.assertEqual(self.runtime.query_team_tasks(
            **self.args(), status="done"
        )["total"], 0)

    def test_bad_pagination_and_cross_project_denied(self):
        for kwargs in ({"limit": False}, {"limit": 0}, {"limit": 101},
                       {"offset": -1}, {"status": "deleted"},
                       {"status": 12}):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(TaskDenied):
                    self.runtime.query_team_tasks(**self.args(), **kwargs)
        with self.assertRaises(AppAccessDenied):
            self.runtime.query_team_tasks(
                **{**self.args(), "tenant": "tenant_other"}
            )
        with self.assertRaises(AppAccessDenied):
            self.runtime.query_team_tasks(
                **{**self.args(), "project_id": str(uuid.uuid4())}
            )

    def test_real_utc_overdue_due_today_due_soon(self):
        today = datetime.now(timezone.utc).date()
        self.create("Пропущена", due_date="2001-01-01", priority="urgent")
        self.create("Сегодня", due_date=today.isoformat())
        self.create("На неделе", due_date=(today+timedelta(days=3)).isoformat())
        done = self.create("Завершить", due_date="2001-01-01")
        self.change(done, {"status": "done"})
        values = self.summary()
        self.assertEqual(values["overdue"], 1)
        self.assertEqual(values["due_today"], 1)
        self.assertEqual(values["due_soon"], 1)
        self.assertEqual(values["priority_high_open"], 1)
        self.assertEqual(values["done"], 1)
        self.assertEqual(values["unassigned"], 4)

    def test_history_immutable_metadata_only(self):
        task = self.create("Очень приватное имя")
        updated = self.change(task, {"description": "SECRET_UNIQUE_TEXT"})
        journal = self.history(task)
        self.assertTrue(journal["immutable"])
        self.assertFalse(journal["values_exposed"])
        self.assertEqual(len(journal["events"]), 2)
        self.assertEqual(journal["events"][0]["version"], updated["version"])
        self.assertEqual(journal["events"][0]["changed_fields"], ["description"])
        as_text = json.dumps(journal, ensure_ascii=False)
        self.assertNotIn("Очень приватное имя", as_text)
        self.assertNotIn("SECRET_UNIQUE_TEXT", as_text)
        self.assertEqual(len(journal["events"][0]["sha256"]), 64)

    def test_operator_cannot_read_unassigned_history(self):
        self.enroll(OPERATOR)
        task = self.create("Для владельца", assignee=OWNER)
        with self.assertRaises(TaskDenied):
            self.history(task, actor=OPERATOR)

    def test_sql_triggers_forbid_journal_changes(self):
        task = self.create()
        with self.runtime.drafts._tx() as db:
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute(
                    "UPDATE director_task_events SET actor='evil' WHERE task_id=?",
                    (task["task_id"],),
                )
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute(
                    "DELETE FROM director_task_events WHERE task_id=?",
                    (task["task_id"],),
                )
        self.assertEqual(len(self.history(task)["events"]), 1)

    def test_journal_hash_tampering_fails_closed(self):
        task = self.create()
        with self.runtime.drafts._db() as db:
            db.execute("DROP TRIGGER director_task_event_no_update")
            db.execute(
                "UPDATE director_task_events SET event_digest='forged'"
            )
        with self.assertRaises(TaskDenied):
            self.history(task)

    def test_task_row_hash_tampering_rejected(self):
        self.create()
        with self.runtime.drafts._db() as db:
            db.execute("UPDATE director_tasks SET task_digest='forged'")
        with self.assertRaises(TaskDenied):
            self.tasks()
        with self.assertRaises(TaskDenied):
            self.summary()


class HTTPTaskTests(TaskFixture):
    def post(self, route, data, *, token=TOKEN, origin=None, method="POST"):
        app = LocalConsole(
            self.db, tenant=TENANT, project_id=self.project,
            actor=OWNER, token=TOKEN, port=PORT,
        )
        env = {}
        setup_testing_defaults(env)
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        env.update({
            "HTTP_HOST": f"127.0.0.1:{PORT}",
            "REMOTE_ADDR": "127.0.0.1", "QUERY_STRING": "",
            "REQUEST_METHOD": method, "PATH_INFO": route,
            "HTTP_AUTHORIZATION": "Bearer " + token,
            "CONTENT_TYPE": "application/json",
            "CONTENT_LENGTH": str(len(raw)),
            "wsgi.input": BytesIO(raw),
        })
        if origin is not None:
            env["HTTP_ORIGIN"] = origin
        status = []
        result = b"".join(
            app(env, lambda code, headers: status.append(code))
        )
        return status[0], json.loads(result)

    def test_http_real_task_creation_assignment_progress_and_manager_metrics(self):
        self.enroll(OPERATOR)
        status, members = self.post("/api/v1/tasks/members", {},
                                     method="GET")
        self.assertEqual(status[:3], "200")
        self.assertTrue(any(x["actor"] == OPERATOR for x in members["members"]))
        body = {"title": "Реальная задача",
                "description": "Критерий проверки",
                "assignee": OPERATOR, "priority": "high",
                "due_date": "2027-10-20", "idempotency_key": key()}
        code, result = self.post("/api/v1/tasks", body)
        self.assertTrue(code.startswith("201"), (code, result))
        task = result["task"]
        code, tasks = self.post("/api/v1/tasks/query", {"limit": 25})
        self.assertTrue(code.startswith("200"))
        self.assertEqual(tasks["total"], 1)
        code, summary = self.post(
            "/api/v1/tasks/summary", {}, method="GET")
        self.assertTrue(code.startswith("200"))
        self.assertEqual(summary["metrics"]["priority_high_open"], 1)
        code, updated = self.post(
            "/api/v1/tasks/" + task["task_id"], {
                "expected_version": 1,
                "changes": {"status": "in_progress"},
                "idempotency_key": key(),
            }, method="PATCH")
        self.assertTrue(code.startswith("200"), (code, updated))
        self.assertEqual(updated["task"]["version"], 2)
        code, hist = self.post(
            "/api/v1/tasks/" + task["task_id"] + "/history", {"limit": 20})
        self.assertTrue(code.startswith("200"))
        self.assertEqual(len(hist["events"]), 2)

    def test_http_blocks_unauthorized_origin_actor_injection_and_invalid_status(self):
        body = {"title": "Только серверная личность", "idempotency_key": key()}
        route = "/api/v1/tasks"
        code, _ = self.post(route, body, token="invalid")
        self.assertTrue(code.startswith("401"))
        code, _ = self.post(route, body, origin="https://evil.invalid")
        self.assertTrue(code.startswith("403"))
        code, _ = self.post(route, {**body, "actor": OWNER, "tenant": TENANT})
        self.assertTrue(code.startswith("400"))
        code, _ = self.post(route, {**body, "status": "done"})
        self.assertTrue(code.startswith("400"))
        self.assertEqual(self.summary()["total"], 0)


if __name__ == "__main__":
    unittest.main()
