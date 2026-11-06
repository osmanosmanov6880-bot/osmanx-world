"""Wave 20: real SQLite DAG, calendar, deadlines, RBAC and HTTP regressions."""
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
from campaign180.task_planning import TaskPlanningDenied
from campaign180.local_http import LocalConsole

ROOT = Path(__file__).resolve().parents[3]
DEMO = ROOT / "supreme-director/campaign180/examples/demo-site.json"
TENANT = "tenant_demo"
OWNER = "owner-abc"
EDITOR = "editor-abc"
OPERATOR = "operator-abc"
OTHER = "other-abc"
VIEWER = "viewer-abc"
TOKEN = "W20_LocalToken_abcdefghABCDEFGHIJ_0123456789_XYZ"
PORT = 8775


def nonce():
    return "wave20-" + uuid.uuid4().hex


class Setup(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.db = Path(work.name) / "tasks.sqlite3"
        spec = json.loads(DEMO.read_text(encoding="utf-8"))
        self.project = spec["project_id"]
        self.runtime = LocalAppRuntime(str(self.db))
        self.runtime.drafts.create(spec, tenant=TENANT)
        self.runtime.policy.bootstrap_owner(
            tenant=TENANT, project_id=self.project, actor=OWNER, now=1799971200
        )

    def scope(self, actor=OWNER, **fields):
        return {"tenant": TENANT, "project_id": self.project,
                "actor": actor, **fields}

    def enroll(self, actor, role="operator"):
        self.runtime.policy.add_member(
            tenant=TENANT, project_id=self.project, owner_actor=OWNER,
            member_actor=actor, role=role, now=1799971201
        )

    def task(self, name="Выполнить работу", **fields):
        return self.runtime.create_team_task(
            **self.scope(), title=name, idempotency_key=nonce(), **fields
        )["task"]

    def add(self, task, before, **options):
        return self.runtime.add_task_dependency(**{
            **self.scope(), "task_id": task["task_id"],
            "prerequisite_id": before["task_id"],
            "expected_version": task["version"],
            "idempotency_key": nonce(), **options,
        })

    def remove(self, task, before, **options):
        return self.runtime.remove_task_dependency(**{
            **self.scope(), "task_id": task["task_id"],
            "prerequisite_id": before["task_id"],
            "expected_version": task["version"],
            "idempotency_key": nonce(), **options,
        })

    def read(self, task, actor=OWNER):
        return self.runtime.list_task_dependencies(
            **self.scope(actor), task_id=task["task_id"])

    def update(self, task, status, actor=OWNER):
        return self.runtime.update_team_task(
            **self.scope(actor), task_id=task["task_id"],
            expected_version=task["version"],
            changes={"status": status}, idempotency_key=nonce()
        )["task"]

    def agenda(self, actor=OWNER, **args):
        return self.runtime.task_calendar(**self.scope(actor), **args)

    def current(self, task):
        return next(x for x in self.runtime.query_team_tasks(
            **self.scope(), limit=100)["tasks"]
            if x["task_id"] == task["task_id"])


class DependencyTests(Setup):
    def test_create_dependency_updates_task_version_and_immutable_history(self):
        before = self.task("Сперва согласование")
        after = self.task("Потом запуск")
        added = self.add(after, before)
        self.assertTrue(added["persisted_locally"])
        self.assertEqual(added["version"], 2)
        self.assertEqual(self.current(after)["version"], 2)
        graph = self.read(after)
        self.assertEqual(graph["total"], 1)
        self.assertEqual(graph["unfinished"], 1)
        self.assertEqual(graph["prerequisites"][0]["title"], before["title"])
        history = self.runtime.team_task_history(
            **self.scope(), task_id=after["task_id"])
        self.assertEqual(history["events"][0]["changed_fields"], ["dependencies"])
        self.assertEqual(history["events"][0]["version"], 2)

    def test_self_dependency_and_simple_cycle_denied(self):
        a = self.task("A")
        b = self.task("B")
        with self.assertRaises(TaskPlanningDenied):
            self.add(a, a)
        self.add(a, b)
        with self.assertRaises(TaskPlanningDenied):
            self.add(b, a)
        self.assertEqual(self.read(b)["total"], 0)

    def test_longer_cycle_and_transactional_rollback(self):
        a, b, c = self.task("A"), self.task("B"), self.task("C")
        self.add(a, b)
        b = self.current(b)
        self.add(b, c)
        with self.assertRaises(TaskPlanningDenied):
            self.add(c, a)
        self.assertEqual(self.current(c)["version"], 1)
        self.assertEqual(self.read(c)["total"], 0)

    def test_duplicate_dependency_and_missing_dependency_rejected(self):
        a, b = self.task("A"), self.task("B")
        receipt = self.add(a, b)
        a = self.current(a)
        with self.assertRaises(TaskPlanningDenied):
            self.add(a, b)
        with self.assertRaises(TaskPlanningDenied):
            self.remove(a, self.task("Unrelated"))
        self.assertEqual(receipt["dependency_count"], 1)

    def test_remove_dependency_is_versioned_and_audited(self):
        a, b = self.task("A"), self.task("B")
        self.add(a, b)
        updated = self.current(a)
        removed = self.remove(updated, b)
        self.assertEqual(removed["operation"], "REMOVE")
        self.assertEqual(removed["version"], 3)
        self.assertEqual(self.read(a)["total"], 0)
        events = self.runtime.task_dependency_events(
            **self.scope(), task_id=a["task_id"])
        self.assertEqual(len(events["history"]), 2)
        self.assertEqual({e["action"] for e in events["history"]}, {"ADD", "REMOVE"})
        self.assertTrue(events["immutable"])

    def test_stale_version_prevents_adding_or_removing_link(self):
        a, b, c = self.task("A"), self.task("B"), self.task("C")
        self.add(a, b)
        with self.assertRaises(TaskPlanningDenied):
            self.add(a, c)
        with self.assertRaises(TaskPlanningDenied):
            self.remove(a, b)
        self.assertEqual(self.read(a)["total"], 1)

    def test_idempotent_add_receipt_and_collision(self):
        a, b, c = self.task("A"), self.task("B"), self.task("C")
        token = nonce()
        first = self.add(a, b, idempotency_key=token)
        repeated = self.add(a, b, idempotency_key=token)
        self.assertEqual(first, repeated)
        with self.assertRaises(ValueError):
            self.add(a, c, idempotency_key=token)
        self.assertEqual(self.read(a)["total"], 1)

    def test_cross_project_and_unknown_task_edges_denied(self):
        a = self.task("A")
        forged = {"task_id": str(uuid.uuid4())}
        with self.assertRaises(TaskPlanningDenied):
            self.add(a, forged)
        with self.assertRaises(AppAccessDenied):
            self.runtime.list_task_dependencies(
                **{**self.scope(), "tenant": "other_tenant"},
                task_id=a["task_id"])
        with self.assertRaises(AppAccessDenied):
            self.runtime.task_calendar(
                **{**self.scope(), "project_id": str(uuid.uuid4())})

    def test_viewer_and_operator_cannot_manage_links(self):
        self.enroll(OPERATOR)
        self.enroll(VIEWER, "viewer")
        a = self.task("A", assignee=OPERATOR)
        b = self.task("B", assignee=OWNER)
        with self.assertRaises(AppAccessDenied):
            self.add(a, b, actor=OPERATOR)
        with self.assertRaises(AppAccessDenied):
            self.add(a, b, actor=VIEWER)
        with self.assertRaises(AppAccessDenied):
            self.read(a, actor=VIEWER)

    def test_operator_sees_only_own_task_and_redacted_dependencies(self):
        self.enroll(OPERATOR)
        self.enroll(OTHER)
        a = self.task("Секретный план", assignee=OTHER)
        b = self.task("Зависимая задача", assignee=OPERATOR)
        self.add(b, a)
        data = self.read(b, actor=OPERATOR)
        self.assertEqual(data["total"], 1)
        self.assertEqual(data["prerequisites"], [{"completed": False}])
        self.assertNotIn("Секретный план", json.dumps(data, ensure_ascii=False))
        with self.assertRaises(TaskPlanningDenied):
            self.read(a, actor=OPERATOR)

    def test_revoked_editor_cannot_replay_successful_add(self):
        self.enroll(EDITOR, "editor")
        a, b = self.task("A"), self.task("B")
        token = nonce()
        self.add(a, b, actor=EDITOR, idempotency_key=token)
        self.runtime.policy.revoke_member(
            tenant=TENANT, project_id=self.project, owner_actor=OWNER,
            member_actor=EDITOR, now=1799971202)
        with self.assertRaises(AppAccessDenied):
            self.add(a, b, actor=EDITOR, idempotency_key=token)

    def test_completed_task_cannot_have_links_added_or_removed(self):
        a = self.task("A")
        b = self.task("B")
        done = self.update(a, "done")
        with self.assertRaises(TaskPlanningDenied):
            self.add(done, b)

    def test_completion_blocks_until_all_prerequisites_done(self):
        a = self.task("Подготовка")
        b = self.task("Выпуск")
        self.add(b, a)
        b = self.current(b)
        with self.assertRaises(TaskPlanningDenied):
            self.update(b, "done")
        self.assertEqual(self.current(b)["status"], "todo")
        done_first = self.update(a, "done")
        done_second = self.update(b, "done")
        self.assertEqual(done_second["status"], "done")
        self.assertEqual(self.read(b)["unfinished"], 0)
        with self.assertRaises(TaskPlanningDenied):
            self.update(done_first, "todo")
        self.assertEqual(self.current(a)["status"], "done")

    def test_operator_completion_checks_dependencies_in_same_transaction(self):
        self.enroll(OPERATOR)
        before = self.task("Согласовать")
        after = self.task("Исполнить", assignee=OPERATOR)
        self.add(after, before)
        after = self.current(after)
        started = self.update(after, "in_progress", actor=OPERATOR)
        with self.assertRaises(TaskPlanningDenied):
            self.update(started, "done", actor=OPERATOR)
        self.update(before, "done")
        finished = self.update(started, "done", actor=OPERATOR)
        self.assertEqual(finished["status"], "done")

    def test_dependency_limit_is_enforced_without_partial_write(self):
        a = self.task("Большая задача")
        before = [self.task("Шаг " + str(i)) for i in range(21)]
        for target in before[:20]:
            receipt = self.add(a, target)
            a = self.current(a)
        self.assertEqual(receipt["dependency_count"], 20)
        with self.assertRaises(TaskPlanningDenied):
            self.add(a, before[20])
        self.assertEqual(self.read(a)["total"], 20)

    def test_corrupt_edge_digest_fails_closed(self):
        a, b = self.task("A"), self.task("B")
        self.add(a, b)
        with self.runtime.drafts._db() as db:
            db.execute("UPDATE director_task_dependencies SET edge_digest='bad'")
        with self.assertRaises(TaskPlanningDenied):
            self.read(a)
        with self.assertRaises(TaskPlanningDenied):
            self.agenda()

    def test_dependency_audit_is_append_only_with_integrity(self):
        a, b = self.task("A"), self.task("B")
        self.add(a, b)
        with self.runtime.drafts._tx() as db:
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("UPDATE director_dependency_events SET actor='forged'")
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("DELETE FROM director_dependency_events")
        events = self.runtime.task_dependency_events(
            **self.scope(), task_id=a["task_id"])
        self.assertEqual(len(events["history"]), 1)
        with self.runtime.drafts._db() as db:
            db.execute("DROP TRIGGER director_dependency_event_no_update")
            db.execute("UPDATE director_dependency_events SET change_digest='bad'")
        with self.assertRaises(TaskPlanningDenied):
            self.runtime.task_dependency_events(
                **self.scope(), task_id=a["task_id"])


class CalendarTests(Setup):
    def test_real_utc_calendar_metrics_and_risk_are_consistent(self):
        today = datetime.now(timezone.utc).date()
        self.task("Просрочена", due_date=(today-timedelta(days=2)).isoformat(),
                  priority="urgent")
        self.task("Сегодня", due_date=today.isoformat(), priority="normal")
        self.task("Скоро", due_date=(today+timedelta(days=2)).isoformat(),
                  priority="high")
        self.task("Очень далеко", due_date=(today+timedelta(days=90)).isoformat())
        self.task("Без срока")
        report = self.agenda(days=7)
        self.assertEqual(report["metrics"]["overdue"], 1)
        self.assertEqual(report["metrics"]["due_today"], 1)
        self.assertEqual(report["metrics"]["due_in_window"], 2)
        self.assertEqual(report["metrics"]["critical_open"], 2)
        self.assertEqual(report["metrics"]["without_deadline"], 1)
        self.assertEqual(report["selected_total"], 3)
        self.assertEqual(report["tasks"][0]["risk"], "overdue")
        self.assertTrue(report["real_database_values"] if "real_database_values" in report else report["local_only"])

    def test_closed_task_not_counted_as_open_or_overdue(self):
        today = datetime.now(timezone.utc).date()
        task = self.task("Была просрочена",
                         due_date=(today-timedelta(days=3)).isoformat())
        self.update(task, "done")
        result = self.agenda(days=30)
        self.assertEqual(result["metrics"]["overdue"], 0)
        self.assertEqual(result["selected_total"], 0)

    def test_agenda_reports_blocked_predecessor_counts(self):
        today = datetime.now(timezone.utc).date()
        a = self.task("Первый")
        b = self.task("Второй", due_date=(today+timedelta(days=1)).isoformat())
        self.add(b, a)
        result = self.agenda(days=7)
        self.assertEqual(result["metrics"]["blocked_by_dependencies"], 1)
        self.assertEqual(result["tasks"][0]["unfinished_prerequisites"], 1)
        self.assertEqual(result["tasks"][0]["risk"], "blocked")
        self.update(a, "done")
        result = self.agenda(days=7)
        self.assertEqual(result["metrics"]["blocked_by_dependencies"], 0)
        self.assertEqual(result["tasks"][0]["unfinished_prerequisites"], 0)

    def test_custom_window_and_exclude_overdue(self):
        today = datetime.now(timezone.utc).date()
        d1 = (today-timedelta(days=2)).isoformat()
        d2 = (today+timedelta(days=4)).isoformat()
        self.task("Прошлое", due_date=d1)
        self.task("Будущее", due_date=d2)
        no_old = self.agenda(start_date=today.isoformat(), days=7,
                             include_overdue=False)
        self.assertEqual(no_old["selected_total"], 1)
        self.assertEqual(no_old["metrics"]["overdue"], 1)
        with_old = self.agenda(start_date=today.isoformat(),days=7)
        self.assertEqual(with_old["selected_total"], 2)

    def test_calendar_is_assignee_scoped_with_no_other_titles(self):
        self.enroll(OPERATOR)
        self.enroll(OTHER)
        today = datetime.now(timezone.utc).date().isoformat()
        self.task("Секретное поручение", assignee=OTHER, due_date=today)
        self.task("Моё поручение", assignee=OPERATOR, due_date=today)
        result = self.agenda(actor=OPERATOR)
        self.assertEqual(result["scope"], "assigned")
        self.assertEqual(result["visible_total"], 1)
        text = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("Секретное поручение", text)
        self.assertIn("Моё поручение", text)

    def test_invalid_horizons_types_and_date_formats_denied(self):
        bad = ({"days": 0}, {"days": 61}, {"days": True},
               {"start_date": "not-a-date"}, {"start_date": "2026-02-31"},
               {"include_overdue": 1},
               {"start_date": "2100-12-30", "days": 60})
        for options in bad:
            with self.subTest(options=options):
                with self.assertRaises(ValueError):
                    self.agenda(**options)

    def test_viewer_denied_calendar_and_manager_only_dependency_audit(self):
        self.enroll(OPERATOR)
        self.enroll(VIEWER, "viewer")
        a = self.task("A")
        with self.assertRaises(AppAccessDenied):
            self.agenda(actor=VIEWER)
        with self.assertRaises(AppAccessDenied):
            self.runtime.task_dependency_events(
                **self.scope(actor=OPERATOR), task_id=a["task_id"])


class HTTPTests(Setup):
    def send(self, path, data=None, *, method="POST", token=TOKEN, origin=None):
        app = LocalConsole(
            self.db, tenant=TENANT, project_id=self.project, actor=OWNER,
            token=TOKEN, port=PORT)
        env = {}
        setup_testing_defaults(env)
        raw = json.dumps(data, ensure_ascii=False).encode() if data is not None else b""
        env.update({
            "REQUEST_METHOD": method, "PATH_INFO": path,
            "HTTP_HOST": f"127.0.0.1:{PORT}", "REMOTE_ADDR": "127.0.0.1",
            "QUERY_STRING": "", "HTTP_AUTHORIZATION": "Bearer " + token,
            "CONTENT_TYPE": "application/json", "CONTENT_LENGTH": str(len(raw)),
            "wsgi.input": BytesIO(raw),
        })
        if origin:
            env["HTTP_ORIGIN"] = origin
        status = []
        reply = b"".join(app(env, lambda code, headers: status.append(code)))
        return status[0], json.loads(reply)

    def test_http_dependency_dag_and_utc_calendar_end_to_end(self):
        today = datetime.now(timezone.utc).date()
        a = self.task("Подготовка")
        b = self.task("Запуск", due_date=(today+timedelta(days=1)).isoformat(),
                      priority="urgent")
        base = "/api/v1/tasks/" + b["task_id"] + "/dependencies"
        code, added = self.send(base + "/add", {
            "prerequisite_id": a["task_id"], "expected_version": 1,
            "idempotency_key": nonce(),
        })
        self.assertTrue(code.startswith("201"), (code, added))
        code, info = self.send(base, method="GET")
        self.assertTrue(code.startswith("200"))
        self.assertEqual(info["unfinished"], 1)
        code, calendar = self.send("/api/v1/tasks/calendar",{"days":7})
        self.assertTrue(code.startswith("200"))
        self.assertEqual(calendar["metrics"]["blocked_by_dependencies"], 1)
        code, history = self.send(
            "/api/v1/tasks/" + b["task_id"] + "/dependency-history",
            {"limit": 10})
        self.assertTrue(code.startswith("200"))
        self.assertEqual(history["history"][0]["action"], "ADD")
        code, removed = self.send(base + "/remove", {
            "prerequisite_id": a["task_id"], "expected_version": 2,
            "idempotency_key": nonce(),
        })
        self.assertTrue(code.startswith("200"), (code, removed))
        self.assertEqual(self.read(b)["total"], 0)

    def test_http_rejects_token_origin_spoof_and_bad_body(self):
        a, b = self.task("A"), self.task("B")
        url = "/api/v1/tasks/" + a["task_id"] + "/dependencies/add"
        payload = {
            "prerequisite_id": b["task_id"], "expected_version": 1,
            "idempotency_key": nonce(),
        }
        code, _ = self.send(url, payload, token="wrong")
        self.assertTrue(code.startswith("401"))
        code, _ = self.send(url, payload, origin="https://evil.invalid")
        self.assertTrue(code.startswith("403"))
        code, _ = self.send(url, {**payload, "tenant": TENANT, "actor": OWNER})
        self.assertTrue(code.startswith("400"))
        self.assertEqual(self.read(a)["total"], 0)


if __name__ == "__main__":
    unittest.main()
