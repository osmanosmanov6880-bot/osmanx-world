"""Wave 18: real local team tasks, owner/editor assignments and manager KPIs.

One immutable task history per project. Operators can only see their own
assignments and update their status; role revocation is checked in the
same SQLite transaction as writes. HTTP authentication remains loopback-only.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
import re
import sqlite3
import time
from typing import TYPE_CHECKING, Any
import uuid

from .app_policy import PERMISSIONS
from .contracts import ACTOR_RE, canonical, digest

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

STATUSES = frozenset(("todo", "in_progress", "blocked", "done"))
PRIORITIES = frozenset(("low", "normal", "high", "urgent"))
MANAGERS = frozenset(("owner", "editor"))
MAX_TASKS = 10000
MAX_EVENTS = 100000
PAGE_LIMIT = 100
DATE_RX = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
TRANSITIONS = {
    "todo": frozenset(("in_progress", "blocked")),
    "in_progress": frozenset(("blocked", "done")),
    "blocked": frozenset(("in_progress",)),
    "done": frozenset(),
}


class TaskDenied(ValueError):
    """Invalid, conflicting, corrupted or unauthorized task operation."""


def _text(value: Any, field: str, maximum: int, *, empty: bool = False) -> str:
    if type(value) is not str or len(value) > maximum:
        raise TaskDenied("Invalid task " + field)
    if any(ord(char) < 32 and char not in "\n\t" for char in value):
        raise TaskDenied("Control characters in task " + field)
    clean = value.strip()
    if not clean and not empty:
        raise TaskDenied("Empty task " + field)
    return clean


def _due(value: Any) -> str | None:
    if value is None:
        return None
    if type(value) is not str or not DATE_RX.fullmatch(value):
        raise TaskDenied("Task due date must be ISO YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise TaskDenied("Invalid calendar due date") from exc
    if not date(2000, 1, 1) <= parsed <= date(2100, 12, 31):
        raise TaskDenied("Due date outside supported range")
    return value


def _assignee(value: Any) -> str | None:
    if value is None:
        return None
    if type(value) is not str or not ACTOR_RE.fullmatch(value):
        raise TaskDenied("Invalid assignee actor identifier")
    return value


def _patch(raw: Any, *, create: bool) -> dict:
    allowed = {"title", "description", "assignee", "priority", "due_date", "status"}
    if type(raw) is not dict or not set(raw).issubset(allowed):
        raise TaskDenied("Invalid task fields")
    if create and ("title" not in raw or "status" in raw):
        raise TaskDenied("Create requires title and server-managed status")
    if not create and not raw:
        raise TaskDenied("Empty task update")
    data = {}
    for key, value in raw.items():
        if key == "title":
            data[key] = _text(value, key, 140)
        elif key == "description":
            data[key] = _text(value, key, 1200, empty=True)
        elif key == "assignee":
            data[key] = _assignee(value)
        elif key == "due_date":
            data[key] = _due(value)
        elif key == "priority":
            if type(value) is not str or value not in PRIORITIES:
                raise TaskDenied("Unknown task priority")
            data[key] = value
        elif key == "status":
            if type(value) is not str or value not in STATUSES:
                raise TaskDenied("Unknown task status")
            data[key] = value
    if create:
        data = {
            "title": data["title"],
            "description": data.get("description", ""),
            "assignee": data.get("assignee"),
            "due_date": data.get("due_date"),
            "priority": data.get("priority", "normal"),
            "status": "todo",
        }
    return data


def init_tasks(runtime: "LocalAppRuntime") -> None:
    with runtime.drafts._db() as db:
        db.executescript("""
          CREATE TABLE IF NOT EXISTS director_tasks(
            tenant TEXT NOT NULL, project_id TEXT NOT NULL,
            task_id TEXT NOT NULL, title TEXT NOT NULL,
            description TEXT NOT NULL,
            assignee TEXT, due_date TEXT,
            priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
            status TEXT NOT NULL CHECK(status IN ('todo','in_progress','blocked','done')),
            version INTEGER NOT NULL CHECK(version>=1),
            created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
            created_epoch INTEGER NOT NULL, updated_epoch INTEGER NOT NULL,
            task_digest TEXT NOT NULL,
            PRIMARY KEY(tenant,project_id,task_id)
          );
          CREATE INDEX IF NOT EXISTS director_tasks_scope
            ON director_tasks(tenant,project_id,status,assignee,due_date);
          CREATE TABLE IF NOT EXISTS director_task_events(
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            tenant TEXT NOT NULL, project_id TEXT NOT NULL,
            task_id TEXT NOT NULL, event_id TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN ('CREATE','UPDATE')),
            actor TEXT NOT NULL, at_epoch INTEGER NOT NULL,
            before_json TEXT, after_json TEXT NOT NULL,
            changes_json TEXT NOT NULL, event_digest TEXT NOT NULL,
            UNIQUE(tenant,project_id,event_id)
          );
          CREATE INDEX IF NOT EXISTS director_task_events_task
            ON director_task_events(tenant,project_id,task_id,seq);
          CREATE TRIGGER IF NOT EXISTS director_task_event_no_update
            BEFORE UPDATE ON director_task_events BEGIN
              SELECT RAISE(ABORT,'task event journal immutable');END;
          CREATE TRIGGER IF NOT EXISTS director_task_event_no_delete
            BEFORE DELETE ON director_task_events BEGIN
              SELECT RAISE(ABORT,'task event journal immutable');END;
        """)


def _principal(runtime: "LocalAppRuntime", db, tenant: str, project: str,
               actor: str, cap: str) -> str:
    return runtime._guard(db, tenant, project, actor, cap)["role"]


def _eligible(db, tenant: str, project: str, actor: str | None) -> None:
    if actor is None:
        return
    row = db.execute(
        """SELECT role,active FROM app_memberships
           WHERE tenant=? AND project_id=? AND actor=?""",
        (tenant, project, actor),
    ).fetchone()
    if (row is None or row["active"] != 1 or
            "task.progress" not in PERMISSIONS.get(row["role"], ())):
        raise TaskDenied("Task can only be assigned to an active team member")


def _fields(row) -> dict:
    return {
        "tenant": row["tenant"], "project_id": row["project_id"],
        "task_id": row["task_id"], "title": row["title"],
        "description": row["description"], "assignee": row["assignee"],
        "due_date": row["due_date"], "priority": row["priority"],
        "status": row["status"], "version": row["version"],
        "created_by": row["created_by"], "updated_by": row["updated_by"],
        "created_epoch": row["created_epoch"], "updated_epoch": row["updated_epoch"],
    }


def _validate_stored(row) -> dict:
    value = _fields(row)
    if digest(value) != row["task_digest"]:
        raise TaskDenied("Task integrity digest mismatch")
    checked = _patch({
        "title": value["title"], "description": value["description"],
        "assignee": value["assignee"], "due_date": value["due_date"],
        "priority": value["priority"], "status": value["status"],
    }, create=False)
    if (type(value["version"]) is not int or value["version"] < 1
            or any(checked[k] != value[k] for k in checked)):
        raise TaskDenied("Stored task violates schema")
    return value


def _read(db, tenant: str, project: str, task_id: str) -> dict:
    try:
        if type(task_id) is not str or str(uuid.UUID(task_id)) != task_id:
            raise ValueError()
    except ValueError as exc:
        raise TaskDenied("Task ID must be canonical UUID") from exc
    row = db.execute(
        """SELECT * FROM director_tasks
           WHERE tenant=? AND project_id=? AND task_id=?""",
        (tenant, project, task_id),
    ).fetchone()
    if row is None:
        raise TaskDenied("Task not found in project")
    return _validate_stored(row)


def _projected(value: dict) -> dict:
    # Scope information is enforced by SQL but not sent as mutable identity.
    return {k: value[k] for k in (
        "task_id", "title", "description", "assignee", "due_date",
        "priority", "status", "version", "created_by", "updated_by",
        "created_epoch", "updated_epoch",
    )}


def _event(runtime: "LocalAppRuntime", db, value: dict, *,
           actor: str, operation: str,
           before: dict | None, changed: list[str]) -> None:
    tenant, project = value["tenant"], value["project_id"]
    count = db.execute(
        """SELECT COUNT(*) FROM director_task_events
           WHERE tenant=? AND project_id=?""",
        (tenant, project),
    ).fetchone()[0]
    if count >= MAX_EVENTS:
        raise TaskDenied("Local task event retention limit reached")
    event_id = str(uuid.uuid4())
    event = {
        "tenant": tenant, "project_id": project,
        "task_id": value["task_id"], "event_id": event_id,
        "operation": operation, "actor": actor, "at_epoch": value["updated_epoch"],
        "before": before, "after": value, "changes": sorted(changed),
    }
    db.execute(
        """INSERT INTO director_task_events(
           tenant,project_id,task_id,event_id,operation,actor,at_epoch,
           before_json,after_json,changes_json,event_digest)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (
            tenant, project, value["task_id"], event_id, operation,
            actor, value["updated_epoch"],
            None if before is None else canonical(before).decode("utf-8"),
            canonical(value).decode("utf-8"),
            canonical(sorted(changed)).decode("utf-8"),
            digest(event),
        ),
    )


def _checked_event(row) -> dict:
    try:
        before = None if row["before_json"] is None else json.loads(row["before_json"])
        after = json.loads(row["after_json"])
        changes = json.loads(row["changes_json"])
    except (ValueError, TypeError) as exc:
        raise TaskDenied("Corrupt task history event") from exc
    event = {
        "tenant": row["tenant"], "project_id": row["project_id"],
        "task_id": row["task_id"], "event_id": row["event_id"],
        "operation": row["operation"], "actor": row["actor"],
        "at_epoch": row["at_epoch"], "before": before, "after": after,
        "changes": changes,
    }
    if (digest(event) != row["event_digest"]
            or (before is not None and canonical(before).decode("utf-8") != row["before_json"])
            or canonical(after).decode("utf-8") != row["after_json"]
            or canonical(changes).decode("utf-8") != row["changes_json"]
            or type(changes) is not list or not all(type(x) is str for x in changes)):
        raise TaskDenied("Task event integrity mismatch")
    return event


def list_members(runtime: "LocalAppRuntime", *, tenant: str,
                 project_id: str, actor: str) -> dict:
    with runtime.drafts._db() as db:
        _principal(runtime, db, tenant, project_id, actor, "task.manage")
        members = db.execute(
            """SELECT actor,role FROM app_memberships
               WHERE tenant=? AND project_id=? AND active=1
               ORDER BY role,actor LIMIT 150""",
            (tenant, project_id),
        ).fetchall()
        return {
            "members": [
                {"actor": row["actor"], "role": row["role"]}
                for row in members
                if "task.progress" in PERMISSIONS.get(row["role"], ())
            ],
            "local_only": True,
        }


def create_task(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                actor: str, title: str, idempotency_key: str,
                description: str = "", assignee: str | None = None,
                due_date: str | None = None, priority: str = "normal") -> dict:
    value = _patch({
        "title": title, "description": description,
        "assignee": assignee, "due_date": due_date, "priority": priority,
    }, create=True)
    runtime.records._key(idempotency_key)
    request = digest({
        "op": "task.create", "tenant": tenant, "project": project_id,
        "actor": actor, "fields": value,
    })
    with runtime.drafts._tx() as db:
        _principal(runtime, db, tenant, project_id, actor, "task.manage")
        replay = runtime.records._seen(db, tenant, project_id, idempotency_key, request)
        if replay is not None:
            return replay
        _eligible(db, tenant, project_id, value["assignee"])
        count = db.execute(
            "SELECT COUNT(*) FROM director_tasks WHERE tenant=? AND project_id=?",
            (tenant, project_id),
        ).fetchone()[0]
        if count >= MAX_TASKS:
            raise TaskDenied("Task limit reached")
        now = int(time.time())
        current = {
            "tenant": tenant, "project_id": project_id,
            "task_id": str(uuid.uuid4()), **value,
            "version": 1, "created_by": actor, "updated_by": actor,
            "created_epoch": now, "updated_epoch": now,
        }
        db.execute(
            """INSERT INTO director_tasks(
               tenant,project_id,task_id,title,description,assignee,due_date,
               priority,status,version,created_by,updated_by,
               created_epoch,updated_epoch,task_digest)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                tenant, project_id, current["task_id"], current["title"],
                current["description"], current["assignee"], current["due_date"],
                current["priority"], current["status"], 1, actor, actor,
                now, now, digest(current),
            ),
        )
        _event(runtime, db, current, actor=actor, operation="CREATE",
               before=None, changed=list(value))
        response = {
            "task": _projected(current), "production_published": False,
            "persisted_locally": True,
        }
        runtime.records._remember(db, tenant, project_id, idempotency_key, request, response)
        return response


def update_task(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                actor: str, task_id: str, expected_version: int,
                changes: dict, idempotency_key: str) -> dict:
    if type(expected_version) is not int or expected_version < 1:
        raise TaskDenied("Expected exact task version")
    patch = _patch(changes, create=False)
    runtime.records._key(idempotency_key)
    request = digest({
        "op": "task.update", "tenant": tenant, "project": project_id,
        "actor": actor, "task_id": task_id,
        "version": expected_version, "changes": patch,
    })
    with runtime.drafts._tx() as db:
        role = _principal(runtime, db, tenant, project_id, actor, "task.progress")
        is_manager = role in MANAGERS
        if not is_manager and set(patch) != {"status"}:
            raise TaskDenied("Assigned worker may only change task status")
        # Authorization precedes idempotent replay to enforce role revocation.
        current = _read(db, tenant, project_id, task_id)
        if not is_manager:
            if current["assignee"] != actor:
                raise TaskDenied("Task is not assigned to current actor")
            if patch["status"] not in TRANSITIONS[current["status"]]:
                raise TaskDenied("Invalid worker task status transition")
        replay = runtime.records._seen(db, tenant, project_id, idempotency_key, request)
        if replay is not None:
            return replay
        if current["version"] != expected_version:
            raise TaskDenied("Stale task version")
        if "status" in patch:
            # Wave 20: check dependency closure in the SAME write transaction.
            from .task_planning import ensure_transition_safe
            ensure_transition_safe(db,tenant=tenant,project_id=project_id,
                                   current=current,new_status=patch["status"])
        if is_manager and "assignee" in patch:
            _eligible(db, tenant, project_id, patch["assignee"])
        if all(current.get(key) == value for key, value in patch.items()):
            raise TaskDenied("No task fields changed")
        now = max(int(time.time()), current["updated_epoch"])
        modified = {
            **current, **patch, "version": current["version"] + 1,
            "updated_by": actor, "updated_epoch": now,
        }
        applied = db.execute(
            """UPDATE director_tasks SET title=?,description=?,assignee=?,
               due_date=?,priority=?,status=?,version=?,updated_by=?,
               updated_epoch=?,task_digest=?
               WHERE tenant=? AND project_id=? AND task_id=?
               AND version=? AND task_digest=?""",
            (
                modified["title"], modified["description"], modified["assignee"],
                modified["due_date"], modified["priority"], modified["status"],
                modified["version"], actor, now, digest(modified),
                tenant, project_id, task_id, expected_version, digest(current),
            ),
        ).rowcount
        if applied != 1:
            raise TaskDenied("Concurrent task update rejected")
        _event(runtime, db, modified, actor=actor, operation="UPDATE",
               before=current, changed=list(patch))
        response = {
            "task": _projected(modified), "persisted_locally": True,
            "production_published": False,
        }
        runtime.records._remember(db, tenant, project_id, idempotency_key, request, response)
        return response


def _visible(db, tenant: str, project: str, actor: str, role: str) -> list[dict]:
    if role in MANAGERS:
        rows = db.execute(
            """SELECT * FROM director_tasks
               WHERE tenant=? AND project_id=?
               ORDER BY created_epoch DESC,task_id ASC LIMIT ?""",
            (tenant, project, MAX_TASKS + 1),
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT * FROM director_tasks
               WHERE tenant=? AND project_id=? AND assignee=?
               ORDER BY created_epoch DESC,task_id ASC LIMIT ?""",
            (tenant, project, actor, MAX_TASKS + 1),
        ).fetchall()
    if len(rows) > MAX_TASKS:
        raise TaskDenied("Task scan limit exceeded")
    return [_validate_stored(x) for x in rows]


def query_tasks(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                actor: str, limit: int = 25, offset: int = 0,
                status: str | None = None, assignee: str | None = None,
                due: str | None = None) -> dict:
    """Bounded, ACL-checked status/assignee/due filters with stable pagination."""
    due_allowed = (None, "overdue", "today", "next7", "undated")
    if (type(limit) is not int or not 1 <= limit <= PAGE_LIMIT
            or type(offset) is not int or not 0 <= offset <= MAX_TASKS
            or (status is not None and (type(status) is not str or status not in STATUSES))
            or due not in due_allowed or (due is not None and type(due) is not str)
            or (assignee is not None and
                (type(assignee) is not str or
                 (assignee != "__unassigned__" and not ACTOR_RE.fullmatch(assignee))))):
        raise TaskDenied("Invalid bounded task filter parameters")
    with runtime.drafts._db() as db:
        role = _principal(runtime, db, tenant, project_id, actor, "task.read")
        if assignee is not None and role not in MANAGERS and assignee != actor:
            raise TaskDenied("Assignee filter outside assigned task scope")
        visible = _visible(db, tenant, project_id, actor, role)
        today = datetime.now(timezone.utc).date()
        filtered = []
        for task in visible:
            if status is not None and task["status"] != status:
                continue
            if assignee is not None and task["assignee"] != (
                    None if assignee == "__unassigned__" else assignee):
                continue
            if due is not None:
                target = date.fromisoformat(task["due_date"]) if task["due_date"] else None
                if due == "undated":
                    if target is not None:
                        continue
                else:
                    if target is None or task["status"] == "done":
                        continue
                    if due == "overdue" and target >= today:
                        continue
                    if due == "today" and target != today:
                        continue
                    if due == "next7" and not today <= target <= today + timedelta(days=7):
                        continue
            filtered.append(task)
        result = filtered[offset:offset + limit]
        return {
            "tasks": [_projected(x) for x in result],
            "total": len(filtered), "offset": offset, "limit": limit,
            "has_more": offset + limit < len(filtered),
            "scope": "all" if role in MANAGERS else "assigned",
            "filters": {"status": status, "assignee": assignee, "due": due},
            "local_only": True,
        }


def task_summary(runtime: "LocalAppRuntime", *, tenant: str,
                 project_id: str, actor: str) -> dict:
    with runtime.drafts._db() as db:
        role = _principal(runtime, db, tenant, project_id, actor, "task.read")
        items = _visible(db, tenant, project_id, actor, role)
        today = datetime.now(timezone.utc).date()
        metrics = {
            "total": len(items), "todo": 0, "in_progress": 0,
            "blocked": 0, "done": 0, "overdue": 0,
            "due_today": 0, "due_soon": 0, "unassigned": 0,
            "priority_high_open": 0,
        }
        for entry in items:
            metrics[entry["status"]] += 1
            if entry["assignee"] is None:
                metrics["unassigned"] += 1
            if entry["status"] == "done":
                continue
            if entry["priority"] in ("high", "urgent"):
                metrics["priority_high_open"] += 1
            if entry["due_date"] is not None:
                due = date.fromisoformat(entry["due_date"])
                if due < today:
                    metrics["overdue"] += 1
                elif due == today:
                    metrics["due_today"] += 1
                elif due <= today + timedelta(days=7):
                    metrics["due_soon"] += 1
        return {
            "metrics": metrics, "as_of_utc": today.isoformat(),
            "scope": "all" if role in MANAGERS else "assigned",
            "real_database_values": True, "production_published": False,
        }


def task_history(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                 actor: str, task_id: str, limit: int = 25) -> dict:
    if type(limit) is not int or not 1 <= limit <= 50:
        raise TaskDenied("Invalid task history limit")
    with runtime.drafts._db() as db:
        role = _principal(runtime, db, tenant, project_id, actor, "task.read")
        task = _read(db, tenant, project_id, task_id)
        if role not in MANAGERS and task["assignee"] != actor:
            raise TaskDenied("Task history is not assigned to this worker")
        rows = db.execute(
            """SELECT * FROM director_task_events
               WHERE tenant=? AND project_id=? AND task_id=?
               ORDER BY seq DESC LIMIT ?""",
            (tenant, project_id, task_id, limit),
        ).fetchall()
        events = []
        for row in rows:
            entry = _checked_event(row)
            events.append({
                "event_id": entry["event_id"],
                "operation": entry["operation"],
                "actor": entry["actor"], "at_epoch": entry["at_epoch"],
                "version": entry["after"]["version"],
                "changed_fields": entry["changes"],
                "sha256": row["event_digest"],
            })
        return {
            "events": events, "values_exposed": False,
            "immutable": True, "local_only": True,
        }
