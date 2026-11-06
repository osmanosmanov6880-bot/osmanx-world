"""Wave 21: baseline-preserving project phases, milestones and schedule variance.

All authoritative data is SQLite-local. Baseline dates can NEVER be edited;
forecast revisions and completed milestones are CAS/idempotency protected.
Owner/editor access only prevents leaking project-wide planning details to
assigned workers. No scheduled jobs, production endpoints or invented KPIs.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
import json
import time
from typing import TYPE_CHECKING, Any
import uuid

from .contracts import canonical, digest
from .team_tasks import TaskDenied, _due, _principal, _read, _text

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

MAX_PHASES = 30
MAX_MILESTONES = 500
MAX_MILESTONES_PER_PHASE = 40
MAX_DELIVERY_EVENTS = 4000
AUDIT_SCHEMA = "osgard.original180.delivery-milestones/1"


class DeliveryDenied(TaskDenied):
    """Rejected planning command, conflict, permission or integrity fault."""


def _date(value: Any) -> str:
    try:
        checked = _due(value)
    except TaskDenied as exc:
        raise DeliveryDenied(str(exc)) from exc
    if checked is None:
        raise DeliveryDenied("An explicit ISO date is required")
    return checked


def _uuid(value: Any) -> str:
    try:
        if type(value) is not str or str(uuid.UUID(value)) != value:
            raise ValueError()
    except ValueError as exc:
        raise DeliveryDenied("Canonical delivery object ID required") from exc
    return value


def _timestamp() -> int:
    return int(time.time())


def _phase_row(row) -> dict:
    payload = {key: row[key] for key in (
        "tenant", "project_id", "phase_id", "name", "baseline_start",
        "baseline_end", "forecast_end", "version", "created_by",
        "updated_by", "created_epoch", "updated_epoch")}
    if (digest(payload) != row["row_digest"]
            or _text(payload["name"], "phase name", 100) != payload["name"]
            or type(payload["version"]) is not int or payload["version"] < 1
            or _date(payload["baseline_start"]) != payload["baseline_start"]
            or _date(payload["baseline_end"]) != payload["baseline_end"]
            or _date(payload["forecast_end"]) != payload["forecast_end"]
            or not payload["baseline_start"] <= payload["baseline_end"]
            or not payload["baseline_start"] <= payload["forecast_end"]):
        raise DeliveryDenied("Project phase integrity failure")
    return payload


def _milestone_row(row) -> dict:
    payload = {key: row[key] for key in (
        "tenant", "project_id", "phase_id", "milestone_id", "name",
        "baseline_due", "forecast_due", "completed_on", "linked_task_id",
        "version", "created_by", "updated_by", "created_epoch", "updated_epoch")}
    if (digest(payload) != row["row_digest"]
            or _text(payload["name"], "milestone name", 120) != payload["name"]
            or _date(payload["baseline_due"]) != payload["baseline_due"]
            or _date(payload["forecast_due"]) != payload["forecast_due"]
            or (payload["completed_on"] is not None
                and _date(payload["completed_on"]) != payload["completed_on"])
            or type(payload["version"]) is not int or payload["version"] < 1):
        raise DeliveryDenied("Project milestone integrity failure")
    if payload["linked_task_id"] is not None:
        _uuid(payload["linked_task_id"])
    return payload


def init_delivery(runtime: "LocalAppRuntime") -> None:
    with runtime.drafts._db() as db:
        db.executescript("""
          CREATE TABLE IF NOT EXISTS director_delivery_phases(
            tenant TEXT NOT NULL, project_id TEXT NOT NULL, phase_id TEXT NOT NULL,
            name TEXT NOT NULL, baseline_start TEXT NOT NULL,
            baseline_end TEXT NOT NULL, forecast_end TEXT NOT NULL,
            version INTEGER NOT NULL CHECK(version>=1),
            created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
            created_epoch INTEGER NOT NULL, updated_epoch INTEGER NOT NULL,
            row_digest TEXT NOT NULL,
            PRIMARY KEY(tenant,project_id,phase_id)
          );
          CREATE INDEX IF NOT EXISTS director_delivery_phases_dates
            ON director_delivery_phases(tenant,project_id,baseline_start,phase_id);
          CREATE TABLE IF NOT EXISTS director_delivery_milestones(
            tenant TEXT NOT NULL,project_id TEXT NOT NULL,
            phase_id TEXT NOT NULL,milestone_id TEXT NOT NULL,
            name TEXT NOT NULL,baseline_due TEXT NOT NULL,
            forecast_due TEXT NOT NULL,completed_on TEXT,
            linked_task_id TEXT,
            version INTEGER NOT NULL CHECK(version>=1),
            created_by TEXT NOT NULL,updated_by TEXT NOT NULL,
            created_epoch INTEGER NOT NULL,updated_epoch INTEGER NOT NULL,
            row_digest TEXT NOT NULL,
            PRIMARY KEY(tenant,project_id,milestone_id),
            FOREIGN KEY(tenant,project_id,phase_id)
              REFERENCES director_delivery_phases(tenant,project_id,phase_id)
          );
          CREATE INDEX IF NOT EXISTS director_delivery_milestones_phase
            ON director_delivery_milestones(tenant,project_id,phase_id,baseline_due);
          CREATE INDEX IF NOT EXISTS director_delivery_milestones_task
            ON director_delivery_milestones(tenant,project_id,linked_task_id);
          CREATE TABLE IF NOT EXISTS director_delivery_events(
            event_id TEXT PRIMARY KEY,
            tenant TEXT NOT NULL, project_id TEXT NOT NULL,
            entity_id TEXT NOT NULL, entity_type TEXT NOT NULL
              CHECK(entity_type IN('phase','milestone')),
            actor TEXT NOT NULL, operation TEXT NOT NULL
              CHECK(operation IN('CREATE','REFORECAST','COMPLETE')),
            version INTEGER NOT NULL, at_epoch INTEGER NOT NULL,
            event_json TEXT NOT NULL, event_digest TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS director_delivery_events_scope
            ON director_delivery_events(tenant,project_id,entity_id,at_epoch);
          CREATE TRIGGER IF NOT EXISTS director_delivery_events_no_update
            BEFORE UPDATE ON director_delivery_events BEGIN
              SELECT RAISE(ABORT,'delivery events append-only'); END;
          CREATE TRIGGER IF NOT EXISTS director_delivery_events_no_delete
            BEFORE DELETE ON director_delivery_events BEGIN
              SELECT RAISE(ABORT,'delivery events append-only'); END;
        """)


def _get_phase(db, tenant: str, project: str, phase_id: str) -> dict:
    row = db.execute(
        """SELECT * FROM director_delivery_phases
           WHERE tenant=? AND project_id=? AND phase_id=?""",
        (tenant, project, _uuid(phase_id))).fetchone()
    if row is None:
        raise DeliveryDenied("Phase not found in this project")
    return _phase_row(row)


def _get_milestone(db, tenant: str, project: str, milestone_id: str) -> dict:
    row = db.execute(
        """SELECT * FROM director_delivery_milestones
           WHERE tenant=? AND project_id=? AND milestone_id=?""",
        (tenant, project, _uuid(milestone_id))).fetchone()
    if row is None:
        raise DeliveryDenied("Milestone not found in this project")
    return _milestone_row(row)


def _event(db, payload: dict, *, actor: str, operation: str,
           entity: str, before: dict | None) -> None:
    tenant, project = payload["tenant"], payload["project_id"]
    count = db.execute(
        """SELECT COUNT(*) FROM director_delivery_events
           WHERE tenant=? AND project_id=?""", (tenant, project)).fetchone()[0]
    if count >= MAX_DELIVERY_EVENTS:
        raise DeliveryDenied("Local delivery audit limit reached")
    event = {
        "schema": AUDIT_SCHEMA, "event_id": str(uuid.uuid4()),
        "tenant": tenant, "project_id": project,
        "entity_id": payload[entity+"_id"], "entity_type": entity,
        "actor": actor, "operation": operation, "version": payload["version"],
        "at_epoch": payload["updated_epoch"],
        "before": before, "after": payload,
    }
    db.execute(
        """INSERT INTO director_delivery_events(
           event_id,tenant,project_id,entity_id,entity_type,actor,operation,
           version,at_epoch,event_json,event_digest)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (event["event_id"], tenant, project, event["entity_id"], entity,
         actor, operation, payload["version"], payload["updated_epoch"],
         canonical(event).decode("utf-8"), digest(event)),
    )


def _auth(runtime, db, tenant, project, actor) -> None:
    _principal(runtime, db, tenant, project, actor, "task.manage")


def _receipt(runtime, db, tenant, project, key, request, result):
    runtime.records._remember(db, tenant, project, key, request, result)
    return result


def create_phase(runtime: "LocalAppRuntime", *, tenant: str,
                 project_id: str, actor: str, name: str,
                 baseline_start: str, baseline_end: str,
                 idempotency_key: str) -> dict:
    name = _text(name, "phase name", 100)
    start, end = _date(baseline_start), _date(baseline_end)
    if start > end:
        raise DeliveryDenied("Phase baseline must start before end")
    runtime.records._key(idempotency_key)
    request = digest({
        "op": "delivery.phase.create", "tenant": tenant, "project": project_id,
        "actor": actor, "name": name, "start": start, "end": end,
    })
    with runtime.drafts._tx() as db:
        _auth(runtime, db, tenant, project_id, actor)
        replay = runtime.records._seen(
            db, tenant, project_id, idempotency_key, request)
        if replay is not None:
            return replay
        count = db.execute(
            """SELECT COUNT(*) FROM director_delivery_phases
               WHERE tenant=? AND project_id=?""",
            (tenant, project_id)).fetchone()[0]
        if count >= MAX_PHASES:
            raise DeliveryDenied("Project phase limit reached")
        now = _timestamp()
        phase = {
            "tenant": tenant, "project_id": project_id,
            "phase_id": str(uuid.uuid4()), "name": name,
            "baseline_start": start, "baseline_end": end,
            "forecast_end": end, "version": 1,
            "created_by": actor, "updated_by": actor,
            "created_epoch": now, "updated_epoch": now,
        }
        db.execute(
            """INSERT INTO director_delivery_phases(
               tenant,project_id,phase_id,name,baseline_start,baseline_end,
               forecast_end,version,created_by,updated_by,
               created_epoch,updated_epoch,row_digest)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (tenant, project_id, phase["phase_id"], name, start, end, end, 1,
             actor, actor, now, now, digest(phase)),
        )
        _event(db, phase, actor=actor, operation="CREATE",
               entity="phase", before=None)
        result = {
            "phase": {k: phase[k] for k in (
                "phase_id","name","baseline_start","baseline_end",
                "forecast_end","version")},
            "persisted_locally": True, "production_published": False,
        }
        return _receipt(runtime, db, tenant, project_id, idempotency_key,
                        request, result)


def revise_phase_forecast(runtime: "LocalAppRuntime", *, tenant: str,
                          project_id: str, actor: str, phase_id: str,
                          expected_version: int, forecast_end: str,
                          idempotency_key: str) -> dict:
    if type(expected_version) is not int or expected_version < 1:
        raise DeliveryDenied("Exact phase version required")
    _uuid(phase_id)
    end = _date(forecast_end)
    runtime.records._key(idempotency_key)
    request = digest({
        "op": "delivery.phase.forecast", "tenant": tenant, "project": project_id,
        "actor": actor, "phase_id": phase_id, "version": expected_version,
        "forecast_end": end,
    })
    with runtime.drafts._tx() as db:
        _auth(runtime, db, tenant, project_id, actor)
        old = _get_phase(db, tenant, project_id, phase_id)
        replay = runtime.records._seen(
            db, tenant, project_id, idempotency_key, request)
        if replay is not None:
            return replay
        if old["version"] != expected_version:
            raise DeliveryDenied("Stale phase version")
        if end < old["baseline_start"]:
            raise DeliveryDenied("Forecast cannot precede phase start")
        if end == old["forecast_end"]:
            raise DeliveryDenied("No phase forecast change")
        now = max(_timestamp(), old["updated_epoch"])
        new = {**old, "forecast_end": end, "version": old["version"]+1,
               "updated_by": actor, "updated_epoch": now}
        count = db.execute(
            """UPDATE director_delivery_phases
               SET forecast_end=?,version=?,updated_by=?,updated_epoch=?,row_digest=?
               WHERE tenant=? AND project_id=? AND phase_id=?
               AND version=? AND row_digest=?""",
            (end, new["version"], actor, now, digest(new),
             tenant, project_id, phase_id, expected_version, digest(old)),
        ).rowcount
        if count != 1:
            raise DeliveryDenied("Phase forecast concurrency conflict")
        _event(db, new, actor=actor, operation="REFORECAST",
               entity="phase", before=old)
        result = {
            "phase_id": phase_id, "version": new["version"],
            "forecast_end": end,
            "forecast_slip_days": (
                date.fromisoformat(end) - date.fromisoformat(new["baseline_end"])).days,
            "persisted_locally": True, "production_published": False,
        }
        return _receipt(runtime, db, tenant, project_id, idempotency_key,
                        request, result)


def create_milestone(runtime: "LocalAppRuntime", *, tenant: str,
                     project_id: str, actor: str, phase_id: str,
                     name: str, baseline_due: str, idempotency_key: str,
                     linked_task_id: str | None = None) -> dict:
    _uuid(phase_id)
    name = _text(name, "milestone name", 120)
    baseline = _date(baseline_due)
    if linked_task_id is not None:
        _uuid(linked_task_id)
    runtime.records._key(idempotency_key)
    request = digest({
        "op": "delivery.milestone.create", "tenant": tenant,
        "project": project_id, "actor": actor, "phase_id": phase_id,
        "name": name, "baseline_due": baseline, "linked_task_id": linked_task_id,
    })
    with runtime.drafts._tx() as db:
        _auth(runtime, db, tenant, project_id, actor)
        phase = _get_phase(db, tenant, project_id, phase_id)
        if not phase["baseline_start"] <= baseline <= phase["baseline_end"]:
            raise DeliveryDenied("Milestone baseline must lie within phase baseline")
        if linked_task_id is not None:
            try:
                _read(db, tenant, project_id, linked_task_id)
            except TaskDenied as exc:
                raise DeliveryDenied("Linked task not found in project") from exc
        replay = runtime.records._seen(
            db, tenant, project_id, idempotency_key, request)
        if replay is not None:
            return replay
        n_all = db.execute(
            """SELECT COUNT(*) FROM director_delivery_milestones
               WHERE tenant=? AND project_id=?""",
            (tenant, project_id)).fetchone()[0]
        n_phase = db.execute(
            """SELECT COUNT(*) FROM director_delivery_milestones
               WHERE tenant=? AND project_id=? AND phase_id=?""",
            (tenant, project_id, phase_id)).fetchone()[0]
        if n_all >= MAX_MILESTONES or n_phase >= MAX_MILESTONES_PER_PHASE:
            raise DeliveryDenied("Project milestone capacity exceeded")
        now = _timestamp()
        item = {
            "tenant": tenant, "project_id": project_id, "phase_id": phase_id,
            "milestone_id": str(uuid.uuid4()), "name": name,
            "baseline_due": baseline, "forecast_due": baseline,
            "completed_on": None, "linked_task_id": linked_task_id,
            "version": 1, "created_by": actor, "updated_by": actor,
            "created_epoch": now, "updated_epoch": now,
        }
        db.execute(
            """INSERT INTO director_delivery_milestones(
               tenant,project_id,phase_id,milestone_id,name,baseline_due,
               forecast_due,completed_on,linked_task_id,version,created_by,
               updated_by,created_epoch,updated_epoch,row_digest)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (tenant, project_id, phase_id, item["milestone_id"], name, baseline,
             baseline, None, linked_task_id, 1, actor, actor,
             now, now, digest(item)),
        )
        _event(db, item, actor=actor, operation="CREATE",
               entity="milestone", before=None)
        result = {
            "milestone": {k: item[k] for k in (
                "milestone_id","phase_id","name","baseline_due",
                "forecast_due","completed_on","linked_task_id","version")},
            "persisted_locally": True, "production_published": False,
        }
        return _receipt(runtime, db, tenant, project_id,
                        idempotency_key, request, result)


def change_milestone(runtime: "LocalAppRuntime", *, tenant: str,
                     project_id: str, actor: str, milestone_id: str,
                     expected_version: int, operation: str, value: str,
                     idempotency_key: str) -> dict:
    _uuid(milestone_id)
    if type(expected_version) is not int or expected_version < 1:
        raise DeliveryDenied("Exact milestone version required")
    if operation not in ("forecast", "complete"):
        raise DeliveryDenied("Unsupported milestone operation")
    value = _date(value)
    if operation == "complete" and value > datetime.now(timezone.utc).date().isoformat():
        raise DeliveryDenied("Actual completion cannot be a future date")
    runtime.records._key(idempotency_key)
    request = digest({
        "op": "delivery.milestone."+operation, "tenant": tenant,
        "project": project_id, "actor": actor,
        "milestone_id": milestone_id, "version": expected_version,
        "value": value,
    })
    with runtime.drafts._tx() as db:
        _auth(runtime, db, tenant, project_id, actor)
        old = _get_milestone(db, tenant, project_id, milestone_id)
        _get_phase(db, tenant, project_id, old["phase_id"])
        replay = runtime.records._seen(
            db, tenant, project_id, idempotency_key, request)
        if replay is not None:
            return replay
        if old["version"] != expected_version:
            raise DeliveryDenied("Stale milestone version")
        if old["completed_on"] is not None:
            raise DeliveryDenied("Completed milestone is immutable")
        if operation == "forecast":
            if value == old["forecast_due"]:
                raise DeliveryDenied("No milestone forecast change")
            phase = _get_phase(db, tenant, project_id, old["phase_id"])
            if value < phase["baseline_start"]:
                raise DeliveryDenied("Milestone forecast precedes phase start")
            new = {**old, "forecast_due": value}
            journal_op = "REFORECAST"
        else:
            if old["linked_task_id"] is not None:
                linked = _read(db, tenant, project_id, old["linked_task_id"])
                if linked["status"] != "done":
                    raise DeliveryDenied("Linked task must be completed first")
            new = {**old, "completed_on": value}
            journal_op = "COMPLETE"
        now = max(_timestamp(), old["updated_epoch"])
        new = {**new, "version": expected_version+1,
               "updated_by": actor, "updated_epoch": now}
        count = db.execute(
            """UPDATE director_delivery_milestones SET
               forecast_due=?,completed_on=?,version=?,updated_by=?,
               updated_epoch=?,row_digest=?
               WHERE tenant=? AND project_id=? AND milestone_id=?
               AND version=? AND row_digest=?""",
            (new["forecast_due"], new["completed_on"], new["version"], actor,
             now, digest(new), tenant, project_id, milestone_id,
             expected_version, digest(old)),
        ).rowcount
        if count != 1:
            raise DeliveryDenied("Milestone concurrency conflict")
        _event(db, new, actor=actor, operation=journal_op,
               entity="milestone", before=old)
        effective = new["completed_on"] or new["forecast_due"]
        result = {
            "milestone_id": milestone_id, "operation": journal_op,
            "version": new["version"], "forecast_due": new["forecast_due"],
            "completed_on": new["completed_on"],
            "variance_days": (
                date.fromisoformat(effective)
                - date.fromisoformat(new["baseline_due"])).days,
            "persisted_locally": True, "production_published": False,
        }
        return _receipt(runtime, db, tenant, project_id,
                        idempotency_key, request, result)


def ensure_linked_milestone_safe(db, *, tenant: str, project_id: str,
                                 current: dict, new_status: str) -> None:
    """Call inside the existing task-update transaction before changing status."""
    if current["status"] != "done" or new_status == "done":
        return
    rows = db.execute(
        """SELECT * FROM director_delivery_milestones
           WHERE tenant=? AND project_id=? AND linked_task_id=? LIMIT ?""",
        (tenant, project_id, current["task_id"], MAX_MILESTONES+1),
    ).fetchall()
    if len(rows) > MAX_MILESTONES:
        raise DeliveryDenied("Linked milestone scan limit reached")
    for row in rows:
        item = _milestone_row(row)
        if item["completed_on"] is not None:
            raise DeliveryDenied("Cannot reopen a task confirming a completed milestone")


def _phase_and_milestones(db, tenant: str, project: str):
    phases = db.execute(
        """SELECT * FROM director_delivery_phases
           WHERE tenant=? AND project_id=?
           ORDER BY baseline_start,phase_id LIMIT ?""",
        (tenant, project, MAX_PHASES+1)).fetchall()
    milestones = db.execute(
        """SELECT * FROM director_delivery_milestones
           WHERE tenant=? AND project_id=?
           ORDER BY baseline_due,milestone_id LIMIT ?""",
        (tenant, project, MAX_MILESTONES+1)).fetchall()
    if len(phases) > MAX_PHASES or len(milestones) > MAX_MILESTONES:
        raise DeliveryDenied("Delivery report exceeds configured safety bounds")
    valid_phases = [_phase_row(p) for p in phases]
    phase_ids = {p["phase_id"] for p in valid_phases}
    valid_items = [_milestone_row(m) for m in milestones]
    for m in valid_items:
        if m["phase_id"] not in phase_ids:
            raise DeliveryDenied("Orphaned milestone record")
    return valid_phases, valid_items


def delivery_report(runtime: "LocalAppRuntime", *, tenant: str,
                    project_id: str, actor: str) -> dict:
    with runtime.drafts._db() as db:
        _auth(runtime, db, tenant, project_id, actor)
        phases, milestones = _phase_and_milestones(db, tenant, project_id)
        today = datetime.now(timezone.utc).date()
        phase_out = []
        total_done = 0
        late_done = 0
        open_overdue = 0
        slipped_open = 0
        phase_delay_count = 0
        for p in phases:
            subset = [m for m in milestones if m["phase_id"] == p["phase_id"]]
            done = [m for m in subset if m["completed_on"]]
            total_done += len(done)
            late_done += sum(m["completed_on"] > m["baseline_due"] for m in done)
            pending = [m for m in subset if m["completed_on"] is None]
            open_overdue += sum(date.fromisoformat(m["forecast_due"]) < today for m in pending)
            slipped_open += sum(m["forecast_due"] > m["baseline_due"] for m in pending)
            actual_end = max((m["completed_on"] for m in done), default=None)
            complete = bool(subset) and len(done) == len(subset)
            variance = (
                date.fromisoformat(actual_end if complete else p["forecast_end"])
                - date.fromisoformat(p["baseline_end"])).days
            phase_delay_count += int(variance > 0)
            phase_out.append({
                "phase_id": p["phase_id"], "name": p["name"],
                "baseline_start": p["baseline_start"],
                "baseline_end": p["baseline_end"],
                "forecast_end": p["forecast_end"],
                "actual_end": actual_end if complete else None,
                "version": p["version"],
                "milestone_count": len(subset), "milestones_done": len(done),
                "progress_percent": (100*len(done)//len(subset)) if subset else 0,
                "status": ("completed" if complete else
                           "overdue" if date.fromisoformat(p["forecast_end"]) < today
                           else "active" if subset else "unplanned"),
                "variance_days": variance,
            })
        report_items = [{
            "milestone_id": m["milestone_id"], "phase_id": m["phase_id"],
            "name": m["name"], "baseline_due": m["baseline_due"],
            "forecast_due": m["forecast_due"], "completed_on": m["completed_on"],
            "linked_task_id": m["linked_task_id"], "version": m["version"],
            "variance_days": (
                date.fromisoformat(m["completed_on"] or m["forecast_due"])
                - date.fromisoformat(m["baseline_due"])).days,
            "risk": ("completed_late" if m["completed_on"] and
                      m["completed_on"] > m["baseline_due"] else
                     "completed" if m["completed_on"] else
                     "overdue" if date.fromisoformat(m["forecast_due"]) < today else
                     "slipped" if m["forecast_due"] > m["baseline_due"] else "on_track"),
        } for m in milestones]
        return {
            "phases": phase_out, "milestones": report_items,
            "metrics": {
                "phases": len(phases), "phases_slipping": phase_delay_count,
                "milestones": len(milestones), "milestones_done": total_done,
                "milestones_completed_late": late_done,
                "milestones_overdue_open": open_overdue,
                "milestones_forecast_slipping": slipped_open,
            },
            "as_of_utc": today.isoformat(),
            "baseline_immutable": True, "scope": "managers",
            "local_only": True, "production_published": False,
        }


def delivery_history(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                     actor: str, entity_id: str, limit: int = 30) -> dict:
    _uuid(entity_id)
    if type(limit) is not int or not 1 <= limit <= 50:
        raise DeliveryDenied("Bounded audit limit required")
    with runtime.drafts._db() as db:
        _auth(runtime, db, tenant, project_id, actor)
        rows = db.execute(
            """SELECT * FROM director_delivery_events
               WHERE tenant=? AND project_id=? AND entity_id=?
               ORDER BY at_epoch DESC,event_id DESC LIMIT ?""",
            (tenant, project_id, entity_id, limit)).fetchall()
        output = []
        for row in rows:
            try:
                event = json.loads(row["event_json"])
            except (ValueError, TypeError) as exc:
                raise DeliveryDenied("Corrupt milestone journal") from exc
            if (digest(event) != row["event_digest"] or
                canonical(event).decode("utf-8") != row["event_json"] or
                event.get("schema") != AUDIT_SCHEMA or
                any(event.get(k) != row[k] for k in (
                    "event_id","tenant","project_id","entity_id","entity_type",
                    "actor","operation","version","at_epoch"))):
                raise DeliveryDenied("Delivery audit integrity mismatch")
            output.append({
                "entity_type": event["entity_type"],
                "operation": event["operation"], "actor": event["actor"],
                "version": event["version"], "at_epoch": event["at_epoch"],
                "sha256": row["event_digest"],
            })
        return {"events": output, "immutable": True, "local_only": True}
