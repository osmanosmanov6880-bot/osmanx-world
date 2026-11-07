"""Wave 28: evidence-bound manual actions for risks in an applied plan.

A risk signal is a rule over local SQLite records, NOT a confirmed incident.
Managers explicitly create remediation cards; the engine never marks a task
completed, assigns staff, sends messages, or publishes anything on its own.
All writes are tenant-scoped, idempotent and atomic with a versioned journal.
"""
from __future__ import annotations

import csv
from datetime import date
from hashlib import sha256
import io
import json
import time
import uuid
from typing import TYPE_CHECKING, Any

from .contracts import canonical, digest
from .resource_forecast import _project_forecast_db
from .scenario_checkpoints import _application, _observe, _snapshot_chain
from .scenario_library import ScenarioLibraryDenied, _snapshot, _uuid
from .scenario_monitoring import _risk_rules
from .scenario_monitor_export import _safe
from .team_tasks import _principal, _eligible, _due, _text

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

SCHEMA = "osgard.original180.risk-action/1"
EVENT_SCHEMA = "osgard.original180.risk-action-event/1"
CODES = frozenset(("ASSIGNEE_CHANGED", "TASK_BLOCKED", "TASK_OVERDUE",
                   "FORECAST_MISSING", "FORECAST_LATE", "CHECKPOINT_STALE"))
STATUSES = frozenset(("open", "doing", "resolved"))
TRANSITIONS = {"open": {"doing", "resolved"},
               "doing": {"open", "resolved"},
               "resolved": {"open"}}
MAX_ACTIONS = 40
MAX_REVISIONS = 40


class RiskActionDenied(ScenarioLibraryDenied):
    """Invalid, stale, unauthorized or corrupted risk-action request."""


def init_risk_actions(runtime: "LocalAppRuntime") -> None:
    with runtime.drafts._db() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS director_risk_actions(
          tenant TEXT NOT NULL,project_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,action_id TEXT NOT NULL,
          risk_code TEXT NOT NULL,risk_key TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 40),
          status TEXT NOT NULL CHECK(status IN ('open','doing','resolved')),
          payload_json TEXT NOT NULL,payload_sha256 TEXT NOT NULL,
          PRIMARY KEY(tenant,project_id,scenario_id,action_id),
          UNIQUE(tenant,project_id,scenario_id,risk_code,risk_key)
        );
        CREATE INDEX IF NOT EXISTS director_risk_actions_scope
          ON director_risk_actions(tenant,project_id,scenario_id,status);
        CREATE TABLE IF NOT EXISTS director_risk_action_events(
          tenant TEXT NOT NULL,project_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,action_id TEXT NOT NULL,
          seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 40),
          prev_sha256 TEXT,event_json TEXT NOT NULL,event_sha256 TEXT NOT NULL,
          PRIMARY KEY(tenant,project_id,scenario_id,action_id,seq)
        );
        CREATE INDEX IF NOT EXISTS director_risk_action_events_scope
          ON director_risk_action_events(tenant,project_id,scenario_id,action_id,seq);
        CREATE TRIGGER IF NOT EXISTS director_risk_action_event_no_update
          BEFORE UPDATE ON director_risk_action_events BEGIN
            SELECT RAISE(ABORT,'risk action journal immutable'); END;
        CREATE TRIGGER IF NOT EXISTS director_risk_action_event_no_delete
          BEFORE DELETE ON director_risk_action_events BEGIN
            SELECT RAISE(ABORT,'risk action journal immutable'); END;
        """)


def _risk_identity(code: Any, task_id: Any) -> tuple[str, str | None, str]:
    if type(code) is not str or code not in CODES:
        raise RiskActionDenied("Unknown risk signal")
    if task_id is None:
        if code != "CHECKPOINT_STALE":
            raise RiskActionDenied("Task-specific risk requires a task ID")
        return code, None, ""
    if code == "CHECKPOINT_STALE":
        raise RiskActionDenied("Global stale-check risk cannot have a task ID")
    return code, _uuid(task_id), task_id


def _clean(text: Any, name: str, length: int, *, empty: bool = False) -> str:
    return _text(text, name, length, empty=empty)


def _read_events(db, tenant: str, project: str, scenario_id: str,
                 action_id: str) -> list[dict]:
    rows = db.execute(
        """SELECT * FROM director_risk_action_events WHERE tenant=?
           AND project_id=? AND scenario_id=? AND action_id=?
           ORDER BY seq ASC LIMIT ?""",
        (tenant, project, scenario_id, action_id, MAX_REVISIONS + 1)).fetchall()
    if len(rows) > MAX_REVISIONS:
        raise RiskActionDenied("Action history bound violated")
    result = []
    prev = None
    prev_state = None
    for expected, row in enumerate(rows, 1):
        try:
            entry = json.loads(row["event_json"])
        except (ValueError, TypeError) as exc:
            raise RiskActionDenied("Broken action journal encoding") from exc
        if (type(entry) is not dict or entry.get("schema") != EVENT_SCHEMA
                or entry.get("sequence") != expected
                or entry.get("prev_sha256") != prev
                or row["seq"] != expected or row["prev_sha256"] != prev
                or any(entry.get(k) != row[k] for k in (
                    "tenant", "project_id", "scenario_id", "action_id"))
                or entry.get("kind") != ("CREATE" if expected == 1 else "REVISE")
                or entry.get("before_sha256") != (
                    digest(prev_state) if prev_state is not None else None)
                or type(entry.get("state")) is not dict
                or entry["state"].get("version") != expected
                or entry["state"].get("action_id") != action_id
                or entry.get("after_sha256") != digest(entry["state"])
                or canonical(entry).decode("utf-8") != row["event_json"]
                or digest(entry) != row["event_sha256"]):
            raise RiskActionDenied("Action journal chain integrity failure")
        prev_state = entry["state"]
        prev = row["event_sha256"]
        result.append({**entry, "sha256": prev})
    return result


def _stored(db, tenant: str, project: str, scenario_id: str,
            action_id: str) -> tuple[dict, list[dict]]:
    row = db.execute(
        """SELECT * FROM director_risk_actions
           WHERE tenant=? AND project_id=? AND scenario_id=? AND action_id=?""",
        (tenant, project, scenario_id, _uuid(action_id))).fetchone()
    if row is None:
        raise RiskActionDenied("Action not found in this project")
    try:
        p = json.loads(row["payload_json"])
    except (ValueError, TypeError) as exc:
        raise RiskActionDenied("Broken risk action JSON") from exc
    if (type(p) is not dict or p.get("schema") != SCHEMA
            or any(p.get(k) != row[k] for k in (
                "tenant", "project_id", "scenario_id", "action_id",
                "risk_code", "risk_key", "version", "status"))
            or canonical(p).decode("utf-8") != row["payload_json"]
            or digest(p) != row["payload_sha256"]
            or p["version"] not in range(1, MAX_REVISIONS + 1)
            or p["status"] not in STATUSES):
        raise RiskActionDenied("Risk action row integrity failure")
    code, task, key = _risk_identity(p.get("risk_code"), p.get("task_id"))
    if key != p["risk_key"] or code != row["risk_code"] or task != p["task_id"]:
        raise RiskActionDenied("Risk action scope mismatch")
    chain = _read_events(db, tenant, project, scenario_id, action_id)
    if (len(chain) != p["version"] or not chain
            or chain[-1]["state"] != p):
        raise RiskActionDenied("Risk action is inconsistent with immutable journal")
    return p, chain


def _append(db, state: dict, actor: str, previous: dict | None,
            prior_events: list[dict]) -> str:
    sequence = state["version"]
    event = {
        "schema": EVENT_SCHEMA,
        "tenant": state["tenant"], "project_id": state["project_id"],
        "scenario_id": state["scenario_id"], "action_id": state["action_id"],
        "sequence": sequence, "kind": "CREATE" if previous is None else "REVISE",
        "actor": actor, "at_epoch": state["updated_epoch"],
        "prev_sha256": prior_events[-1]["sha256"] if prior_events else None,
        "before_sha256": digest(previous) if previous else None,
        "after_sha256": digest(state), "state": state,
    }
    sha = digest(event)
    db.execute(
        """INSERT INTO director_risk_action_events(
           tenant,project_id,scenario_id,action_id,seq,prev_sha256,
           event_json,event_sha256) VALUES(?,?,?,?,?,?,?,?)""",
        (state["tenant"], state["project_id"], state["scenario_id"],
         state["action_id"], sequence, event["prev_sha256"],
         canonical(event).decode("utf-8"), sha))
    return sha


def _live(runtime, db, tenant, project_id, actor, scenario_id):
    _scenario, application, rollback = _application(
        db, tenant, project_id, scenario_id)
    if rollback is not None:
        return None, [], True
    forecast = _project_forecast_db(
        runtime, db, tenant=tenant, project_id=project_id, actor=actor)
    chain = _snapshot_chain(db, tenant, project_id, scenario_id)
    tasks = _observe(db, tenant=tenant, project_id=project_id,
                     applied=application, forecast=forecast)
    risks = _risk_rules(
        tasks, application, date.fromisoformat(forecast["as_of_utc"]),
        chain, False)
    return forecast["input_snapshot"], risks, False


def create_action(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                  actor: str, scenario_id: str, risk_code: str,
                  task_id: str | None, expected_snapshot: str,
                  plan: str, assignee: str | None, due_date: str | None,
                  idempotency_key: str) -> dict:
    _uuid(scenario_id)
    risk_code, task_id, key = _risk_identity(risk_code, task_id)
    expected_snapshot = _snapshot(expected_snapshot)
    plan = _clean(plan, "action plan", 500)
    due_date = _due(due_date)
    runtime.records._key(idempotency_key)
    request = digest({
        "operation": "risk.action.create", "tenant": tenant,
        "project_id": project_id, "actor": actor, "scenario_id": scenario_id,
        "risk_code": risk_code, "task_id": task_id,
        "snapshot": expected_snapshot, "plan": plan,
        "assignee": assignee, "due_date": due_date,
    })
    with runtime.drafts._tx() as db:
        _principal(runtime, db, tenant, project_id, actor, "task.manage")
        repeated = runtime.records._seen(
            db, tenant, project_id, idempotency_key, request)
        if repeated is not None:
            return repeated
        _eligible(db, tenant, project_id, assignee)
        snapshot, risks, rolled_back = _live(
            runtime, db, tenant, project_id, actor, scenario_id)
        if rolled_back or snapshot != expected_snapshot:
            raise RiskActionDenied("Plan rolled back or live task snapshot changed")
        alert = next((r for r in risks
                      if r["code"] == risk_code and r["task_id"] == task_id), None)
        if alert is None:
            raise RiskActionDenied("Risk is no longer present in live task data")
        count = db.execute(
            """SELECT COUNT(*) FROM director_risk_actions
               WHERE tenant=? AND project_id=? AND scenario_id=?""",
            (tenant, project_id, scenario_id)).fetchone()[0]
        if count >= MAX_ACTIONS:
            raise RiskActionDenied("Action limit reached for this scenario")
        existing = db.execute(
            """SELECT 1 FROM director_risk_actions
               WHERE tenant=? AND project_id=? AND scenario_id=?
               AND risk_code=? AND risk_key=?""",
            (tenant, project_id, scenario_id, risk_code, key)).fetchone()
        if existing is not None:
            raise RiskActionDenied("A decision card already exists for this risk")
        now = int(time.time())
        state = {
            "schema": SCHEMA, "tenant": tenant, "project_id": project_id,
            "scenario_id": scenario_id, "action_id": str(uuid.uuid4()),
            "risk_code": risk_code, "task_id": task_id, "risk_key": key,
            "initial_severity": alert["severity"],
            "source_risk": alert,
            "source_risk_sha256": digest(alert),
            "source_snapshot": snapshot, "created_by": actor,
            "created_epoch": now, "updated_by": actor, "updated_epoch": now,
            "status": "open", "version": 1, "plan": plan,
            "assignee": assignee, "due_date": due_date, "note": "",
        }
        sha = digest(state)
        db.execute(
            """INSERT INTO director_risk_actions(
               tenant,project_id,scenario_id,action_id,risk_code,risk_key,
               version,status,payload_json,payload_sha256)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (tenant, project_id, scenario_id, state["action_id"], risk_code, key,
             1, "open", canonical(state).decode("utf-8"), sha))
        proof = _append(db, state, actor, None, [])
        output = {"action": {**state, "sha256": sha, "last_event_sha256": proof},
                  "persisted_locally": True, "production_published": False}
        runtime.records._remember(
            db, tenant, project_id, idempotency_key, request, output)
        return output


def change_action(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                  actor: str, scenario_id: str, action_id: str,
                  expected_version: int, changes: dict,
                  idempotency_key: str) -> dict:
    _uuid(scenario_id)
    _uuid(action_id)
    runtime.records._key(idempotency_key)
    if (type(expected_version) is not int or not 1 <= expected_version <= MAX_REVISIONS
            or type(changes) is not dict or not changes
            or not set(changes) <= {"status", "plan", "assignee", "due_date", "note"}):
        raise RiskActionDenied("Invalid action update fields or expected version")
    normalized = {}
    for key, value in changes.items():
        if key == "status":
            if type(value) is not str or value not in STATUSES:
                raise RiskActionDenied("Invalid action status")
            normalized[key] = value
        elif key == "plan":
            normalized[key] = _clean(value, "action plan", 500)
        elif key == "note":
            normalized[key] = _clean(value, "decision note", 400, empty=True)
        elif key == "assignee":
            if value is not None and type(value) is not str:
                raise RiskActionDenied("Invalid action owner")
            normalized[key] = value
        else:
            normalized[key] = _due(value)
    request = digest({
        "operation": "risk.action.change", "tenant": tenant, "project_id": project_id,
        "actor": actor, "scenario_id": scenario_id, "action_id": action_id,
        "expected_version": expected_version, "changes": normalized,
    })
    with runtime.drafts._tx() as db:
        _principal(runtime, db, tenant, project_id, actor, "task.manage")
        repeated = runtime.records._seen(
            db, tenant, project_id, idempotency_key, request)
        if repeated is not None:
            return repeated
        previous, events = _stored(
            db, tenant, project_id, scenario_id, action_id)
        if previous["version"] != expected_version or expected_version >= MAX_REVISIONS:
            raise RiskActionDenied("Risk action changed; refresh before saving")
        _scenario, _application_receipt, rollback = _application(
            db, tenant, project_id, scenario_id)
        if rollback is not None:
            raise RiskActionDenied("Rolled-back plans have read-only action history")
        if "assignee" in normalized:
            _eligible(db, tenant, project_id, normalized["assignee"])
        status = normalized.get("status", previous["status"])
        if status != previous["status"] and status not in TRANSITIONS[previous["status"]]:
            raise RiskActionDenied("Unsupported risk action state transition")
        if status == "resolved" and not (
                normalized.get("note", previous["note"]).strip()):
            raise RiskActionDenied("Resolving a risk requires a manual decision note")
        if previous["status"] == "resolved" and status == "open":
            _snapshot_now, risks, _rolled = _live(
                runtime, db, tenant, project_id, actor, scenario_id)
            if not any(r["code"] == previous["risk_code"] and
                       r["task_id"] == previous["task_id"] for r in risks):
                raise RiskActionDenied("Cannot reopen an action without a live risk")
        if all(previous[k] == value for k, value in normalized.items()):
            raise RiskActionDenied("No actual action changes")
        updated = {**previous, **normalized, "version": expected_version + 1,
                   "updated_by": actor, "updated_epoch": int(time.time())}
        digest_after = digest(updated)
        changed = db.execute(
            """UPDATE director_risk_actions
               SET version=?,status=?,payload_json=?,payload_sha256=?
               WHERE tenant=? AND project_id=? AND scenario_id=? AND action_id=?
                 AND version=? AND payload_sha256=?""",
            (updated["version"], updated["status"],
             canonical(updated).decode("utf-8"), digest_after,
             tenant, project_id, scenario_id, action_id,
             expected_version, digest(previous))).rowcount
        if changed != 1:
            raise RiskActionDenied("Concurrent risk action revision conflict")
        proof = _append(db, updated, actor, previous, events)
        output = {"action": {**updated, "sha256": digest_after,
                             "last_event_sha256": proof},
                  "persisted_locally": True, "production_published": False}
        runtime.records._remember(
            db, tenant, project_id, idempotency_key, request, output)
        return output


def list_actions(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                 actor: str, scenario_id: str) -> dict:
    _uuid(scenario_id)
    with runtime.drafts._db() as db:
        db.execute("BEGIN")
        _principal(runtime, db, tenant, project_id, actor, "task.manage")
        snapshot, risks, rolled_back = _live(
            runtime, db, tenant, project_id, actor, scenario_id)
        live = {(r["code"], r["task_id"]) for r in risks}
        rows = db.execute(
            """SELECT action_id FROM director_risk_actions
               WHERE tenant=? AND project_id=? AND scenario_id=?
               ORDER BY action_id LIMIT ?""",
            (tenant, project_id, scenario_id, MAX_ACTIONS + 1)).fetchall()
        if len(rows) > MAX_ACTIONS:
            raise RiskActionDenied("Too many scenario risk actions")
        actions = []
        for row in rows:
            p, events = _stored(
                db, tenant, project_id, scenario_id, row["action_id"])
            actions.append({
                **p, "sha256": digest(p),
                "last_event_sha256": events[-1]["sha256"],
                "history_count": len(events),
                "risk_still_observed": (p["risk_code"], p["task_id"]) in live,
            })
        statuses = {key: sum(x["status"] == key for x in actions) for key in STATUSES}
        overdue = sum(x["status"] != "resolved" and x["due_date"] is not None
                      and x["due_date"] < date.today().isoformat() for x in actions)
        return {
            "scenario_id": scenario_id, "actions": actions,
            "counts": {**statuses, "overdue": overdue, "total": len(actions)},
            "source_snapshot": snapshot, "rolled_back": rolled_back,
            "event_chains_verified": True,
            "local_only": True, "production_published": False,
        }


def action_history(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                   actor: str, scenario_id: str, action_id: str) -> dict:
    _uuid(scenario_id)
    with runtime.drafts._db() as db:
        db.execute("BEGIN")
        _principal(runtime, db, tenant, project_id, actor, "task.manage")
        _application(db, tenant, project_id, scenario_id)
        _state, events = _stored(db, tenant, project_id, scenario_id, action_id)
        return {
            "action_id": action_id, "events": list(reversed(events)),
            "total": len(events), "chain_verified": True,
            "local_only": True, "production_published": False,
        }


def action_csv(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
               actor: str, scenario_id: str) -> dict:
    report = list_actions(
        runtime, tenant=tenant, project_id=project_id,
        actor=actor, scenario_id=scenario_id)
    headers = ("action_id", "scenario_id", "risk_code", "task_id",
               "initial_severity", "risk_still_observed", "status",
               "assignee", "due_date", "plan", "note", "version",
               "source_snapshot", "source_risk_sha256", "last_event_sha256")
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=headers, lineterminator="\r\n")
    writer.writeheader()
    for action in report["actions"]:
        writer.writerow({key: _safe(action.get(key)) for key in headers})
    encoded = "\ufeff" + output.getvalue()
    return {
        "filename": "osgard-risk-actions-" + scenario_id + ".csv",
        "mime": "text/csv;charset=utf-8", "csv": encoded,
        "rows": len(report["actions"]), "sha256": sha256(
            encoded.encode("utf-8")).hexdigest(),
        "verified_history": report["event_chains_verified"],
        "local_only": True, "production_published": False,
    }
