"""Wave 20 — real task dependencies, critical deadlines and calendar agenda.

Task dependency mutations are bounded, CAS-versioned and idempotent. All
authorization is based on trusted server-side actor/tenant identity. A
prerequisite graph cannot contain self edges, foreign-project edges or cycles.
No clock-based background jobs, outbound alerts or public endpoints.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
import time
from typing import TYPE_CHECKING, Any
import uuid

from .contracts import canonical, digest
from .team_tasks import MANAGERS, TaskDenied, _due, _event, _principal, _read, _visible

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

MAX_DEPENDENCIES = 20
MAX_GRAPH_NODES = 10000
MAX_AGENDA_DAYS = 60
MAX_AGENDA_ITEMS = 200
EVENT_SCHEMA = "osgard.original180.task-dependency/1"


class TaskPlanningDenied(TaskDenied):
    """Invalid dependency, stale task revision or unsafe completion."""


def init_planning(runtime: "LocalAppRuntime") -> None:
    with runtime.drafts._db() as db:
        db.executescript("""
          CREATE TABLE IF NOT EXISTS director_task_dependencies(
            tenant TEXT NOT NULL, project_id TEXT NOT NULL,
            task_id TEXT NOT NULL, prerequisite_id TEXT NOT NULL,
            created_by TEXT NOT NULL, created_epoch INTEGER NOT NULL,
            edge_digest TEXT NOT NULL,
            PRIMARY KEY (tenant,project_id,task_id,prerequisite_id),
            CHECK (task_id <> prerequisite_id)
          );
          CREATE INDEX IF NOT EXISTS director_dependency_reverse
            ON director_task_dependencies(tenant,project_id,prerequisite_id,task_id);
          CREATE TABLE IF NOT EXISTS director_dependency_events(
            event_id TEXT PRIMARY KEY,
            tenant TEXT NOT NULL,project_id TEXT NOT NULL,
            task_id TEXT NOT NULL,prerequisite_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('ADD','REMOVE')),
            actor TEXT NOT NULL,created_epoch INTEGER NOT NULL,
            task_version INTEGER NOT NULL,change_digest TEXT NOT NULL,
            event_json TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS director_dependency_events_scope
            ON director_dependency_events(tenant,project_id,task_id,created_epoch);
          CREATE TRIGGER IF NOT EXISTS director_dependency_event_no_update
            BEFORE UPDATE ON director_dependency_events BEGIN
              SELECT RAISE(ABORT,'dependency events are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS director_dependency_event_no_delete
            BEFORE DELETE ON director_dependency_events BEGIN
              SELECT RAISE(ABORT,'dependency events are immutable'); END;
        """)


def _canonical_id(value: Any) -> str:
    try:
        if type(value) is not str or str(uuid.UUID(value)) != value:
            raise ValueError()
    except ValueError as exc:
        raise TaskPlanningDenied("Canonical prerequisite UUID required") from exc
    return value


def _edge_payload(row) -> dict:
    return {
        "tenant": row["tenant"], "project_id": row["project_id"],
        "task_id": row["task_id"], "prerequisite_id": row["prerequisite_id"],
        "created_by": row["created_by"], "created_epoch": row["created_epoch"],
    }


def _checked_edge(row) -> dict:
    edge = _edge_payload(row)
    if digest(edge) != row["edge_digest"]:
        raise TaskPlanningDenied("Task dependency integrity mismatch")
    return edge


def _edges(db, tenant: str, project: str, task_id: str) -> list[dict]:
    rows = db.execute(
        """SELECT * FROM director_task_dependencies
           WHERE tenant=? AND project_id=? AND task_id=?
           ORDER BY prerequisite_id LIMIT ?""",
        (tenant, project, task_id, MAX_DEPENDENCIES + 1),
    ).fetchall()
    if len(rows) > MAX_DEPENDENCIES:
        raise TaskPlanningDenied("Dependency limit exceeded")
    return [_checked_edge(row) for row in rows]


def _all_edges(db, tenant: str, project: str):
    # Avoid probing the entire project on each graph node during cycle checks.
    # At most 10,000 tasks x 20 edges = 200,000 locally.
    rows = db.execute(
        """SELECT * FROM director_task_dependencies
           WHERE tenant=? AND project_id=? LIMIT ?""",
        (tenant, project, MAX_GRAPH_NODES * MAX_DEPENDENCIES + 1),
    ).fetchall()
    if len(rows) > MAX_GRAPH_NODES * MAX_DEPENDENCIES:
        raise TaskPlanningDenied("Dependency graph exceeds safety bound")
    adjacency: dict[str, set[str]] = {}
    for raw in rows:
        checked = _checked_edge(raw)
        adjacency.setdefault(checked["task_id"], set()).add(
            checked["prerequisite_id"])
    return adjacency


def _cycle_if_added(db, tenant: str, project: str,
                    task_id: str, prerequisite_id: str) -> bool:
    if task_id == prerequisite_id:
        return True
    graph = _all_edges(db, tenant, project)
    seen: set[str] = set()
    stack = [prerequisite_id]
    while stack:
        current = stack.pop()
        if current == task_id:
            return True
        if current in seen:
            continue
        seen.add(current)
        if len(seen) > MAX_GRAPH_NODES:
            raise TaskPlanningDenied("Dependency graph traversal limit exceeded")
        stack.extend(graph.get(current, ()))
    return False


def _write_task_version(db, *, tenant: str, project_id: str,
                        actor: str, old: dict) -> dict:
    modified = {
        **old, "version": old["version"] + 1, "updated_by": actor,
        "updated_epoch": max(int(time.time()), old["updated_epoch"]),
    }
    count = db.execute(
        """UPDATE director_tasks
           SET version=?,updated_by=?,updated_epoch=?,task_digest=?
           WHERE tenant=? AND project_id=? AND task_id=?
           AND version=? AND task_digest=?""",
        (modified["version"], actor, modified["updated_epoch"], digest(modified),
         tenant, project_id, old["task_id"], old["version"], digest(old)),
    ).rowcount
    if count != 1:
        raise TaskPlanningDenied("Task changed during dependency mutation")
    _event(None, db, modified, actor=actor, operation="UPDATE",
           before=old, changed=["dependencies"])
    return modified


def mutate_dependency(runtime: "LocalAppRuntime", *, tenant: str,
                      project_id: str, actor: str, task_id: str,
                      prerequisite_id: str, expected_version: int,
                      idempotency_key: str, action: str) -> dict:
    if action not in ("add", "remove"):
        raise TaskPlanningDenied("Unknown dependency operation")
    _canonical_id(task_id)
    _canonical_id(prerequisite_id)
    if type(expected_version) is not int or expected_version < 1:
        raise TaskPlanningDenied("Exact task version required")
    runtime.records._key(idempotency_key)
    request = digest({
        "op": "task.dependency." + action,
        "tenant": tenant, "project": project_id, "actor": actor,
        "task_id": task_id, "prerequisite_id": prerequisite_id,
        "expected_version": expected_version,
    })
    with runtime.drafts._tx() as db:
        _principal(runtime, db, tenant, project_id, actor, "task.manage")
        task = _read(db, tenant, project_id, task_id)
        try:
            _read(db, tenant, project_id, prerequisite_id)
        except TaskDenied as exc:
            raise TaskPlanningDenied(
                "Prerequisite does not exist within this project") from exc
        replay = runtime.records._seen(
            db, tenant, project_id, idempotency_key, request)
        if replay is not None:
            return replay
        if task["status"] == "done":
            raise TaskPlanningDenied("Dependencies of completed tasks cannot change")
        if task["version"] != expected_version:
            raise TaskPlanningDenied("Task dependency edit has stale version")
        current = _edges(db, tenant, project_id, task_id)
        linked = any(x["prerequisite_id"] == prerequisite_id for x in current)
        now = int(time.time())
        if action == "add":
            if linked or len(current) >= MAX_DEPENDENCIES:
                raise TaskPlanningDenied("Duplicate dependency or dependency quota")
            if _cycle_if_added(db, tenant, project_id, task_id, prerequisite_id):
                raise TaskPlanningDenied("Self or cyclic task dependency denied")
            edge = {
                "tenant": tenant, "project_id": project_id,
                "task_id": task_id, "prerequisite_id": prerequisite_id,
                "created_by": actor, "created_epoch": now,
            }
            db.execute(
                """INSERT INTO director_task_dependencies(
                   tenant,project_id,task_id,prerequisite_id,created_by,
                   created_epoch,edge_digest) VALUES(?,?,?,?,?,?,?)""",
                (tenant, project_id, task_id, prerequisite_id,
                 actor, now, digest(edge)),
            )
        else:
            if not linked:
                raise TaskPlanningDenied("Dependency is not attached to this task")
            count = db.execute(
                """DELETE FROM director_task_dependencies WHERE
                   tenant=? AND project_id=? AND task_id=? AND prerequisite_id=?""",
                (tenant, project_id, task_id, prerequisite_id),
            ).rowcount
            if count != 1:
                raise TaskPlanningDenied("Concurrent dependency removal")
        modified = _write_task_version(
            db, tenant=tenant, project_id=project_id, actor=actor, old=task)
        event = {
            "schema": EVENT_SCHEMA, "event_id": str(uuid.uuid4()),
            "tenant": tenant, "project_id": project_id,
            "task_id": task_id, "prerequisite_id": prerequisite_id,
            "action": action.upper(), "actor": actor, "created_epoch": now,
            "task_version": modified["version"],
        }
        db.execute(
            """INSERT INTO director_dependency_events(
               event_id,tenant,project_id,task_id,prerequisite_id,
               action,actor,created_epoch,task_version,change_digest,event_json)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (event["event_id"], tenant, project_id, task_id, prerequisite_id,
             event["action"], actor, now, modified["version"], digest(event),
             canonical(event).decode("utf-8")),
        )
        result = {
            "task_id": task_id, "prerequisite_id": prerequisite_id,
            "operation": event["action"], "version": modified["version"],
            "dependency_count": len(current) + (1 if action == "add" else -1),
            "persisted_locally": True, "production_published": False,
        }
        runtime.records._remember(
            db, tenant, project_id, idempotency_key, request, result)
        return result


def list_dependencies(runtime: "LocalAppRuntime", *, tenant: str,
                      project_id: str, actor: str, task_id: str) -> dict:
    with runtime.drafts._db() as db:
        role = _principal(runtime, db, tenant, project_id, actor, "task.read")
        task = _read(db, tenant, project_id, task_id)
        if role not in MANAGERS and task["assignee"] != actor:
            raise TaskPlanningDenied("Task is not assigned to this member")
        entries = _edges(db, tenant, project_id, task_id)
        details = [_read(db, tenant, project_id, e["prerequisite_id"])
                   for e in entries]
        # Assigned operators are not shown identities of teammates' tasks.
        public = [
            {"task_id": prerequisite["task_id"],
             "title": prerequisite["title"],
             "status": prerequisite["status"],
             "due_date": prerequisite["due_date"]}
            for prerequisite in details
        ] if role in MANAGERS else [
            {"completed": prerequisite["status"] == "done"}
            for prerequisite in details
        ]
        return {
            "task_id": task_id, "task_version": task["version"],
            "prerequisites": public, "total": len(entries),
            "unfinished": sum(t["status"] != "done" for t in details),
            "can_manage": role in MANAGERS, "local_only": True,
        }


def ensure_transition_safe(db, *, tenant: str, project_id: str,
                           current: dict, new_status: str) -> None:
    """Call inside the EXISTING update_task write transaction."""
    if current["status"] == new_status:
        return
    task_id = current["task_id"]
    if new_status == "done":
        for link in _edges(db, tenant, project_id, task_id):
            prerequisite = _read(db, tenant, project_id, link["prerequisite_id"])
            if prerequisite["status"] != "done":
                raise TaskPlanningDenied("Complete prerequisite tasks before closing")
    if current["status"] == "done" and new_status != "done":
        dependents = db.execute(
            """SELECT * FROM director_task_dependencies
               WHERE tenant=? AND project_id=? AND prerequisite_id=? LIMIT ?""",
            (tenant, project_id, task_id, MAX_GRAPH_NODES + 1),
        ).fetchall()
        if len(dependents) > MAX_GRAPH_NODES:
            raise TaskPlanningDenied("Dependent task graph exceeds safety limit")
        for raw in dependents:
            edge = _checked_edge(raw)
            dependent = _read(db, tenant, project_id, edge["task_id"])
            if dependent["status"] == "done":
                raise TaskPlanningDenied(
                    "Cannot reopen prerequisite of a completed dependent task")


def calendar_agenda(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                    actor: str, start_date: str | None = None,
                    days: int = 30, include_overdue: bool = True) -> dict:
    if type(days) is not int or not 1 <= days <= MAX_AGENDA_DAYS:
        raise TaskPlanningDenied("Calendar horizon must be 1-60 days")
    if type(include_overdue) is not bool:
        raise TaskPlanningDenied("include_overdue must be boolean")
    today = datetime.now(timezone.utc).date()
    start = today if start_date is None else date.fromisoformat(_due(start_date))
    end = start + timedelta(days=days-1)
    if end.year > 2100:
        raise TaskPlanningDenied("Calendar horizon out of supported date range")
    with runtime.drafts._db() as db:
        role = _principal(runtime, db, tenant, project_id, actor, "task.read")
        visible = _visible(db, tenant, project_id, actor, role)
        metrics = {
            "overdue": 0, "due_today": 0, "due_in_window": 0,
            "blocked_by_dependencies": 0, "critical_open": 0,
            "without_deadline": 0,
        }
        selected = []
        for task in visible:
            if task["status"] == "done":
                continue
            prereq_edges = _edges(db, tenant, project_id, task["task_id"])
            incomplete = sum(
                _read(db, tenant, project_id, edge["prerequisite_id"])["status"] != "done"
                for edge in prereq_edges)
            if incomplete:
                metrics["blocked_by_dependencies"] += 1
            due = date.fromisoformat(task["due_date"]) if task["due_date"] else None
            if due is None:
                metrics["without_deadline"] += 1
                continue
            if due < today:
                metrics["overdue"] += 1
            if due == today:
                metrics["due_today"] += 1
            if task["priority"] in ("urgent", "high") and (
                    due <= today + timedelta(days=7)):
                metrics["critical_open"] += 1
            in_window = start <= due <= end
            if in_window:
                metrics["due_in_window"] += 1
            if in_window or (include_overdue and due < start):
                risk = "overdue" if due < today else (
                    "blocked" if incomplete else (
                        "urgent" if task["priority"] in ("urgent", "high")
                        and due <= today + timedelta(days=7) else "normal"))
                selected.append({
                    "task_id": task["task_id"], "title": task["title"],
                    "assignee": task["assignee"], "due_date": task["due_date"],
                    "status": task["status"], "priority": task["priority"],
                    "version": task["version"], "unfinished_prerequisites": incomplete,
                    "risk": risk,
                })
        selected.sort(key=lambda item: (
            item["due_date"], 0 if item["risk"]=="overdue" else 1,
            item["task_id"]))
        return {
            "tasks": selected[:MAX_AGENDA_ITEMS],
            "visible_total": len(visible),
            "selected_total": len(selected),
            "truncated": len(selected) > MAX_AGENDA_ITEMS,
            "from_date": start.isoformat(), "through_date": end.isoformat(),
            "as_of_utc": today.isoformat(), "metrics": metrics,
            "scope": "all" if role in MANAGERS else "assigned",
            "local_only": True, "production_published": False,
        }


def dependency_events(runtime: "LocalAppRuntime", *, tenant: str,
                      project_id: str, actor: str, task_id: str,
                      limit: int = 30) -> dict:
    if type(limit) is not int or not 1 <= limit <= 50:
        raise TaskPlanningDenied("Invalid dependency event limit")
    with runtime.drafts._db() as db:
        _principal(runtime, db, tenant, project_id, actor, "task.manage")
        _read(db, tenant, project_id, task_id)
        rows = db.execute(
            """SELECT * FROM director_dependency_events
               WHERE tenant=? AND project_id=? AND task_id=?
               ORDER BY created_epoch DESC,event_id DESC LIMIT ?""",
            (tenant, project_id, task_id, limit),
        ).fetchall()
        output = []
        for row in rows:
            try:
                event = json.loads(row["event_json"])
            except (ValueError, TypeError) as exc:
                raise TaskPlanningDenied("Corrupt dependency event") from exc
            if (digest(event) != row["change_digest"]
                    or canonical(event).decode("utf-8") != row["event_json"]
                    or event.get("schema") != EVENT_SCHEMA
                    or any(event.get(k) != row[k] for k in (
                        "event_id","tenant","project_id","task_id",
                        "prerequisite_id","action","actor","created_epoch","task_version"))):
                raise TaskPlanningDenied("Dependency audit integrity mismatch")
            output.append({
                "action": event["action"], "actor": event["actor"],
                "prerequisite_id": event["prerequisite_id"],
                "task_version": event["task_version"],
                "created_epoch": event["created_epoch"],
                "sha256": row["change_digest"],
            })
        return {"history": output, "local_only": True, "immutable": True}
