"""Wave 19: project-scoped task discussions, checklists and workforce metrics.

All writes are SQLite BEGIN IMMEDIATE operations and verify active membership
inside the mutation transaction. The HTTP API binds identity server-side.
Comments and checklist events are append-only. No network notifications.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone, date
import json
import time
from typing import TYPE_CHECKING, Any
import uuid

from .contracts import canonical, digest
from .team_tasks import (
    MANAGERS, MAX_TASKS, TaskDenied, _principal, _read, _text, _visible,
)

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

MAX_COMMENTS_PER_TASK = 250
MAX_CHECKLIST_PER_TASK = 60
MAX_COMMENT_PAGE = 50


class TaskCollaborationDenied(TaskDenied):
    """Denied due to scope, permissions, corruption or concurrent change."""


def init_collaboration(runtime: "LocalAppRuntime") -> None:
    with runtime.drafts._db() as db:
        db.executescript("""
          CREATE TABLE IF NOT EXISTS director_task_comments (
            tenant TEXT NOT NULL,project_id TEXT NOT NULL,
            task_id TEXT NOT NULL,comment_id TEXT NOT NULL,
            actor TEXT NOT NULL,body TEXT NOT NULL,
            created_epoch INTEGER NOT NULL,content_digest TEXT NOT NULL,
            PRIMARY KEY(tenant,project_id,task_id,comment_id)
          );
          CREATE INDEX IF NOT EXISTS director_comments_task
            ON director_task_comments(tenant,project_id,task_id,created_epoch);
          CREATE TRIGGER IF NOT EXISTS director_comments_immutable_u
            BEFORE UPDATE ON director_task_comments BEGIN
            SELECT RAISE(ABORT,'comments are append-only'); END;
          CREATE TRIGGER IF NOT EXISTS director_comments_immutable_d
            BEFORE DELETE ON director_task_comments BEGIN
            SELECT RAISE(ABORT,'comments are append-only'); END;

          CREATE TABLE IF NOT EXISTS director_task_checklist (
            tenant TEXT NOT NULL,project_id TEXT NOT NULL,
            task_id TEXT NOT NULL,item_id TEXT NOT NULL,
            label TEXT NOT NULL,done INTEGER NOT NULL CHECK(done IN(0,1)),
            version INTEGER NOT NULL CHECK(version>=1),
            created_by TEXT NOT NULL,updated_by TEXT NOT NULL,
            created_epoch INTEGER NOT NULL,updated_epoch INTEGER NOT NULL,
            item_digest TEXT NOT NULL,
            PRIMARY KEY(tenant,project_id,task_id,item_id)
          );
          CREATE INDEX IF NOT EXISTS director_checklist_task
            ON director_task_checklist(tenant,project_id,task_id,created_epoch);
          CREATE TABLE IF NOT EXISTS director_checklist_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant TEXT NOT NULL,project_id TEXT NOT NULL,
            task_id TEXT NOT NULL,item_id TEXT NOT NULL,
            actor TEXT NOT NULL,event_epoch INTEGER NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN('ADD','TOGGLE')),
            event_json TEXT NOT NULL,event_digest TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS director_checklist_events_scope
            ON director_checklist_events(tenant,project_id,task_id,seq);
          CREATE TRIGGER IF NOT EXISTS director_checklist_events_immutable_u
            BEFORE UPDATE ON director_checklist_events BEGIN
            SELECT RAISE(ABORT,'checklist journal is append-only'); END;
          CREATE TRIGGER IF NOT EXISTS director_checklist_events_immutable_d
            BEFORE DELETE ON director_checklist_events BEGIN
            SELECT RAISE(ABORT,'checklist journal is append-only'); END;
        """)


def _access(runtime: "LocalAppRuntime", db, tenant: str,
            project_id: str, actor: str, task_id: str,
            *, manage: bool = False, write: bool = False) -> dict:
    capability = "task.manage" if manage else "task.progress" if write else "task.read"
    role = _principal(runtime, db, tenant, project_id, actor, capability)
    task = _read(db, tenant, project_id, task_id)
    if role not in MANAGERS and task["assignee"] != actor:
        raise TaskCollaborationDenied("Task not assigned to this active member")
    return task


def _comment_row(row) -> dict:
    item = {
        "tenant": row["tenant"], "project_id": row["project_id"],
        "task_id": row["task_id"], "comment_id": row["comment_id"],
        "actor": row["actor"], "body": row["body"],
        "created_epoch": row["created_epoch"],
    }
    if (digest(item) != row["content_digest"] or
            _text(item["body"], "comment", 1000) != item["body"]):
        raise TaskCollaborationDenied("Comment integrity failure")
    return {k: item[k] for k in ("comment_id", "actor", "body", "created_epoch")}


def add_comment(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                actor: str, task_id: str, body: str,
                idempotency_key: str) -> dict:
    clean = _text(body, "comment", 1000)
    runtime.records._key(idempotency_key)
    request = digest({
        "op": "task.comment", "tenant": tenant, "project": project_id,
        "actor": actor, "task_id": task_id, "body": clean,
    })
    with runtime.drafts._tx() as db:
        _access(runtime, db, tenant, project_id, actor, task_id, write=True)
        replay = runtime.records._seen(
            db, tenant, project_id, idempotency_key, request)
        if replay is not None:
            return replay
        total = db.execute(
            """SELECT count(*) FROM director_task_comments
               WHERE tenant=? AND project_id=? AND task_id=?""",
            (tenant, project_id, task_id),
        ).fetchone()[0]
        if total >= MAX_COMMENTS_PER_TASK:
            raise TaskCollaborationDenied("Task comment limit exceeded")
        payload = {
            "tenant": tenant, "project_id": project_id, "task_id": task_id,
            "comment_id": str(uuid.uuid4()), "actor": actor, "body": clean,
            "created_epoch": int(time.time()),
        }
        db.execute(
            """INSERT INTO director_task_comments(
               tenant,project_id,task_id,comment_id,actor,body,created_epoch,content_digest)
               VALUES(?,?,?,?,?,?,?,?)""",
            (tenant, project_id, task_id, payload["comment_id"], actor, clean,
             payload["created_epoch"], digest(payload)),
        )
        response = {
            "comment": {k: payload[k] for k in (
                "comment_id", "actor", "body", "created_epoch")},
            "persisted_locally": True, "production_published": False,
        }
        runtime.records._remember(
            db, tenant, project_id, idempotency_key, request, response)
        return response


def list_comments(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                  actor: str, task_id: str, limit: int = 25, offset: int = 0) -> dict:
    if (type(limit) is not int or not 1 <= limit <= MAX_COMMENT_PAGE
            or type(offset) is not int or not 0 <= offset <= MAX_COMMENTS_PER_TASK):
        raise TaskCollaborationDenied("Bounded comments page required")
    with runtime.drafts._db() as db:
        _access(runtime, db, tenant, project_id, actor, task_id)
        rows = db.execute(
            """SELECT * FROM director_task_comments
               WHERE tenant=? AND project_id=? AND task_id=?
               ORDER BY created_epoch,comment_id LIMIT ?""",
            (tenant, project_id, task_id, MAX_COMMENTS_PER_TASK + 1),
        ).fetchall()
        if len(rows) > MAX_COMMENTS_PER_TASK:
            raise TaskCollaborationDenied("Task comment read cap exceeded")
        # Verify all records before returning even a partial page.
        checked = [_comment_row(row) for row in rows]
        return {
            "comments": checked[offset:offset + limit],
            "total": len(checked), "offset": offset,
            "has_more": offset + limit < len(checked), "local_only": True,
        }


def _checklist_row(row) -> dict:
    payload = {
        "tenant": row["tenant"], "project_id": row["project_id"],
        "task_id": row["task_id"], "item_id": row["item_id"],
        "label": row["label"], "done": bool(row["done"]),
        "version": row["version"], "created_by": row["created_by"],
        "updated_by": row["updated_by"],
        "created_epoch": row["created_epoch"], "updated_epoch": row["updated_epoch"],
    }
    if (row["done"] not in (0, 1) or
            type(payload["version"]) is not int or payload["version"] < 1 or
            _text(payload["label"], "checklist label", 160) != payload["label"] or
            digest(payload) != row["item_digest"]):
        raise TaskCollaborationDenied("Checklist integrity failure")
    return payload


def _public_item(item: dict) -> dict:
    return {key: item[key] for key in (
        "item_id", "label", "done", "version", "created_by", "updated_by",
        "created_epoch", "updated_epoch")}


def _item_event(db, value: dict, *, actor: str, op: str, previous: dict | None) -> None:
    payload = {
        "tenant": value["tenant"], "project_id": value["project_id"],
        "task_id": value["task_id"], "item_id": value["item_id"],
        "operation": op, "actor": actor, "event_epoch": value["updated_epoch"],
        "before": previous, "after": value,
    }
    db.execute(
        """INSERT INTO director_checklist_events(
           tenant,project_id,task_id,item_id,actor,event_epoch,operation,event_json,event_digest)
           VALUES(?,?,?,?,?,?,?,?,?)""",
        (value["tenant"], value["project_id"], value["task_id"],
         value["item_id"], actor, value["updated_epoch"], op,
         canonical(payload).decode("utf-8"), digest(payload)),
    )


def add_checklist_item(runtime: "LocalAppRuntime", *, tenant: str,
                       project_id: str, actor: str, task_id: str, label: str,
                       idempotency_key: str) -> dict:
    clean = _text(label, "checklist label", 160)
    runtime.records._key(idempotency_key)
    request = digest({
        "op": "checklist.add", "tenant": tenant, "project": project_id,
        "actor": actor, "task_id": task_id, "label": clean,
    })
    with runtime.drafts._tx() as db:
        _access(runtime, db, tenant, project_id, actor, task_id, manage=True)
        replay = runtime.records._seen(
            db, tenant, project_id, idempotency_key, request)
        if replay is not None:
            return replay
        count = db.execute(
            """SELECT count(*) FROM director_task_checklist WHERE
               tenant=? AND project_id=? AND task_id=?""",
            (tenant, project_id, task_id),
        ).fetchone()[0]
        if count >= MAX_CHECKLIST_PER_TASK:
            raise TaskCollaborationDenied("Task checklist limit exceeded")
        now = int(time.time())
        current = {
            "tenant": tenant, "project_id": project_id,
            "task_id": task_id, "item_id": str(uuid.uuid4()),
            "label": clean, "done": False, "version": 1,
            "created_by": actor, "updated_by": actor,
            "created_epoch": now, "updated_epoch": now,
        }
        db.execute(
            """INSERT INTO director_task_checklist(
               tenant,project_id,task_id,item_id,label,done,version,created_by,
               updated_by,created_epoch,updated_epoch,item_digest)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (tenant, project_id, task_id, current["item_id"], clean, 0, 1,
             actor, actor, now, now, digest(current)),
        )
        _item_event(db, current, actor=actor, op="ADD", previous=None)
        receipt = {
            "item": _public_item(current), "persisted_locally": True,
            "production_published": False,
        }
        runtime.records._remember(
            db, tenant, project_id, idempotency_key, request, receipt)
        return receipt


def list_checklist(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                   actor: str, task_id: str) -> dict:
    with runtime.drafts._db() as db:
        _access(runtime, db, tenant, project_id, actor, task_id)
        rows = db.execute(
            """SELECT * FROM director_task_checklist WHERE
               tenant=? AND project_id=? AND task_id=?
               ORDER BY created_epoch,item_id LIMIT ?""",
            (tenant, project_id, task_id, MAX_CHECKLIST_PER_TASK + 1),
        ).fetchall()
        if len(rows) > MAX_CHECKLIST_PER_TASK:
            raise TaskCollaborationDenied("Checklist size cap exceeded")
        items = [_public_item(_checklist_row(row)) for row in rows]
        done = sum(1 for item in items if item["done"])
        return {"items": items, "total": len(items), "completed": done,
                "local_only": True}


def set_checklist_done(runtime: "LocalAppRuntime", *, tenant: str,
                       project_id: str, actor: str, task_id: str,
                       item_id: str, expected_version: int, done: bool,
                       idempotency_key: str) -> dict:
    if type(expected_version) is not int or expected_version < 1:
        raise TaskCollaborationDenied("Exact checklist version required")
    if type(done) is not bool:
        raise TaskCollaborationDenied("Checklist done must be boolean")
    try:
        if type(item_id) is not str or str(uuid.UUID(item_id)) != item_id:
            raise ValueError()
    except ValueError as exc:
        raise TaskCollaborationDenied("Canonical checklist item ID required") from exc
    runtime.records._key(idempotency_key)
    request = digest({
        "op": "checklist.toggle", "tenant": tenant, "project": project_id,
        "actor": actor, "task_id": task_id, "item_id": item_id,
        "expected_version": expected_version, "done": done,
    })
    with runtime.drafts._tx() as db:
        _access(runtime, db, tenant, project_id, actor, task_id, write=True)
        row = db.execute(
            """SELECT * FROM director_task_checklist WHERE
               tenant=? AND project_id=? AND task_id=? AND item_id=?""",
            (tenant, project_id, task_id, item_id),
        ).fetchone()
        if row is None:
            raise TaskCollaborationDenied("Checklist item not in accessible task")
        old = _checklist_row(row)
        replay = runtime.records._seen(
            db, tenant, project_id, idempotency_key, request)
        if replay is not None:
            return replay
        if old["version"] != expected_version:
            raise TaskCollaborationDenied("Stale checklist item version")
        if old["done"] == done:
            raise TaskCollaborationDenied("No checklist state change")
        current = {
            **old, "done": done, "version": expected_version + 1,
            "updated_by": actor,
            "updated_epoch": max(int(time.time()), old["updated_epoch"]),
        }
        count = db.execute(
            """UPDATE director_task_checklist
               SET done=?,version=?,updated_by=?,updated_epoch=?,item_digest=?
               WHERE tenant=? AND project_id=? AND task_id=? AND item_id=?
               AND version=? AND item_digest=?""",
            (int(done), current["version"], actor, current["updated_epoch"],
             digest(current), tenant, project_id, task_id, item_id,
             expected_version, digest(old)),
        ).rowcount
        if count != 1:
            raise TaskCollaborationDenied("Concurrent checklist write rejected")
        _item_event(db, current, actor=actor, op="TOGGLE", previous=old)
        receipt = {
            "item": _public_item(current), "persisted_locally": True,
            "production_published": False,
        }
        runtime.records._remember(
            db, tenant, project_id, idempotency_key, request, receipt)
        return receipt


def team_workload(runtime: "LocalAppRuntime", *, tenant: str,
                  project_id: str, actor: str) -> dict:
    """Manager-only task workload by active employee, plus unassigned tasks."""
    with runtime.drafts._db() as db:
        _principal(runtime, db, tenant, project_id, actor, "task.manage")
        items = _visible(db, tenant, project_id, actor, "owner")
        members = db.execute(
            """SELECT actor,role FROM app_memberships WHERE tenant=? AND project_id=?
               AND active=1 ORDER BY actor LIMIT 151""",
            (tenant, project_id),
        ).fetchall()
        if len(members) > 150:
            raise TaskCollaborationDenied("Team size exceeds bounded report")
        summary = {
            row["actor"]: {
                "actor": row["actor"], "role": row["role"], "total": 0,
                "open": 0, "completed": 0, "overdue": 0,
                "blocked": 0, "high_priority_open": 0,
            } for row in members
        }
        summary["__unassigned__"] = {
            "actor": None, "role": "unassigned", "total": 0,
            "open": 0, "completed": 0, "overdue": 0,
            "blocked": 0, "high_priority_open": 0,
        }
        today = datetime.now(timezone.utc).date()
        for task in items:
            name = task["assignee"] or "__unassigned__"
            if name not in summary:
                # Revoked members may have historical assignments; no hidden task loss.
                summary[name] = {
                    "actor": name, "role": "inactive", "total": 0, "open": 0,
                    "completed": 0, "overdue": 0, "blocked": 0,
                    "high_priority_open": 0,
                }
            row = summary[name]
            row["total"] += 1
            if task["status"] == "done":
                row["completed"] += 1
            else:
                row["open"] += 1
                if task["status"] == "blocked":
                    row["blocked"] += 1
                if task["priority"] in ("high", "urgent"):
                    row["high_priority_open"] += 1
                if task["due_date"] and date.fromisoformat(task["due_date"]) < today:
                    row["overdue"] += 1
        return {
            "members": sorted(summary.values(), key=lambda x: (
                -x["overdue"], -x["open"], x["actor"] or "")),
            "as_of_utc": today.isoformat(), "task_count": len(items),
            "scope": "all", "local_only": True,
        }
