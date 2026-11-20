"""M202 local financial monitor, trends, SLA and executive reports.

Four substantial subsystems, additive SQLite migration. Never executes
external notifications, banking operations or a background job on its own.
"""
from __future__ import annotations

from collections import Counter
import csv
from hashlib import sha256
import io
import json

from osgard_m192.runtime import (
    KEY_RE, Conflict, Invalid, Unauthorized, canonical, _secret_hash,
    _object, _identifier,
)
from osgard_m193.runtime import _version
from osgard_m201.runtime import Director201, _policy, _snapshot
from .risk_scheduler import configure, schedule_status, run_due, runs
from .risk_history import capture, history, comparison
from .risk_sla import refresh_sla, board

OPERATIONS = frozenset({
    "commerce.monitor.schedule.get", "commerce.monitor.schedule.set",
    "commerce.monitor.schedule.run_due", "commerce.monitor.runs.list",
    "commerce.monitor.scan", "commerce.monitor.snapshots.list",
    "commerce.monitor.snapshots.compare",
    "commerce.monitor.sla.refresh","commerce.monitor.sla.board",
    "commerce.monitor.report","commerce.monitor.report.csv",
})
WRITES = frozenset({
    "commerce.monitor.schedule.set","commerce.monitor.schedule.run_due",
    "commerce.monitor.scan","commerce.monitor.sla.refresh",
})


def _plain_csv(value):
    text=str(value if value is not None else "")
    # Mitigate Excel/LibreOffice formula injection, including leading whitespace.
    if text.lstrip().startswith(("=","+","-","@")) or text.startswith(("\t","\r","\n")):
        text="'"+text
    return text


def executive_report(db,identity,now):
    tenant=identity["tenant_id"]
    monitor=schedule_status(db,tenant)
    count_rows=db.execute(
        """SELECT status,COUNT(*) AS amount FROM financial_alerts
           WHERE tenant_id=? GROUP BY status""",(tenant,)
    ).fetchall()
    counts={k:0 for k in ("open","acknowledged","dismissed","cleared")}
    counts.update({r["status"]:r["amount"] for r in count_rows})
    latest=history(db,tenant,limit=1)
    alerts=db.execute(
        """SELECT a.id,a.rule,a.label,a.severity,a.status,a.observed_value,
                  a.threshold_value,a.unit,a.first_gap_month,a.created_at,
                  a.updated_at,a.version,a.work_id,w.assignee,w.status AS task_status,
                  w.due_at AS task_due_at
           FROM financial_alerts a
           LEFT JOIN team_work w
             ON w.tenant_id=a.tenant_id AND w.id=a.work_id
           WHERE a.tenant_id=? ORDER BY a.created_at DESC,a.id DESC LIMIT 200""",
        (tenant,)
    ).fetchall()
    total=db.execute(
        "SELECT COUNT(*) FROM financial_alerts WHERE tenant_id=?",
        (tenant,)
    ).fetchone()[0]
    policy=db.execute(
        """SELECT version,config_json FROM financial_alert_policies
           WHERE tenant_id=?""",(tenant,)
    ).fetchone()
    live=None
    if policy is not None:
        _,cfg=_policy(db,tenant)
        live=_snapshot(db,identity,cfg,now)
    sla=None
    if monitor["exists"]:
        cfg=db.execute("SELECT * FROM financial_monitor_schedule WHERE tenant_id=?",
                       (tenant,)).fetchone()
        sla=board(db,tenant,now,cfg,limit=100)
    return {
        "schema":"osgard.m202.executive-report/1",
        "generated_at":now, "scope":"TENANT_OWNER",
        "tenant_id":tenant,"policy_version":policy["version"] if policy else 0,
        "schedule":monitor,"alert_counts":counts,
        "alerts":[dict(row) for row in alerts],
        "alerts_total":total,"alerts_truncated":total>len(alerts),
        "current_risk_preview":live,
        "last_persisted_snapshot":(
            latest["snapshots"][-1] if latest["snapshots"] else None),
        "snapshots_total":latest["total"],
        "snapshot_chain_head":latest["head"],
        "sla":sla,
        "warnings":[
            "All cash balances and receipts are hypothetical or entered manually.",
            "The local chain is not independently signed or externally anchored.",
            "Schedule is evaluated only by explicit run_due calls, not a daemon.",
            "Employee assignment does not send email or messenger notifications.",
        ],
        "bank_verified":False,"production_authorized":False,
        "external_messages_sent":False,
        "original_tasks_independently_accepted":0,
    }


def export_csv(db,identity,now):
    report=executive_report(db,identity,now)
    if report["alerts_total"]>3000:
        raise Invalid("CSV requires at most 3000 alerts; use archival export")
    rows=db.execute(
        """SELECT a.rule,a.label,a.severity,a.status,a.episode,
                  a.observed_value,a.threshold_value,a.unit,a.created_at,
                  a.updated_at,a.work_id,w.assignee,w.status AS task_status
           FROM financial_alerts a
           LEFT JOIN team_work w
             ON w.tenant_id=a.tenant_id AND w.id=a.work_id
           WHERE a.tenant_id=? ORDER BY a.created_at,a.id""",
        (identity["tenant_id"],)
    ).fetchall()
    out=io.StringIO(newline="")
    writer=csv.writer(out,delimiter=";",lineterminator="\r\n")
    writer.writerow(("Правило","Название","Важность","Статус","Эпизод",
        "Показатель","Порог","Единица","Создано UTC epoch",
        "Обновлено UTC epoch","ID задачи","Исполнитель","Статус задачи"))
    for row in rows:
        writer.writerow([_plain_csv(value) for value in tuple(row)])
    return {
        "filename":"osgard-m202-risk-report.csv",
        "mime":"text/csv; charset=utf-8",
        "content":"\ufeff"+out.getvalue(),
        "rows":len(rows),
        "formula_injection_guard":True,
        "bank_verified":False,
        "production_authorized":False,
    }


class Director202(Director201):
    def initialize(self):
        super().initialize()
        with self.connect() as db:
            db.executescript("""
              CREATE TABLE IF NOT EXISTS financial_monitor_schedule (
                tenant_id TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
                interval_seconds INTEGER NOT NULL CHECK(
                    interval_seconds BETWEEN 3600 AND 604800),
                next_due_at INTEGER,
                ack_sla_seconds INTEGER NOT NULL CHECK(ack_sla_seconds>=300),
                resolve_sla_seconds INTEGER NOT NULL CHECK(resolve_sla_seconds>=300),
                version INTEGER NOT NULL CHECK(version>=1),
                updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,
                last_ran_at INTEGER
              );
              CREATE TABLE IF NOT EXISTS financial_monitor_runs (
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,
                scheduled_for INTEGER NOT NULL,ran_at INTEGER NOT NULL,
                policy_version INTEGER NOT NULL,
                schedule_version INTEGER NOT NULL,
                snapshot_id TEXT NOT NULL,
                result_json TEXT NOT NULL,
                UNIQUE(tenant_id,schedule_version,scheduled_for)
              );
              CREATE INDEX IF NOT EXISTS idx_monitor_runs_tenant
                ON financial_monitor_runs(tenant_id,ran_at);
              CREATE TABLE IF NOT EXISTS financial_risk_snapshots (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id TEXT NOT NULL,
                id TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL,actor TEXT NOT NULL,
                origin TEXT NOT NULL CHECK(origin IN ('manual','scheduled')),
                policy_version INTEGER NOT NULL,
                rules_json TEXT NOT NULL,cashflow_json TEXT NOT NULL,
                overbudget_count INTEGER NOT NULL,
                previous_hash TEXT NOT NULL,chain_hash TEXT NOT NULL
              );
              CREATE INDEX IF NOT EXISTS idx_risk_snapshots_tenant
                ON financial_risk_snapshots(tenant_id,seq);
              CREATE TRIGGER IF NOT EXISTS immutable_risk_snapshots_update
                BEFORE UPDATE ON financial_risk_snapshots
                BEGIN SELECT RAISE(ABORT,'risk snapshots are immutable'); END;
              CREATE TRIGGER IF NOT EXISTS immutable_risk_snapshots_delete
                BEFORE DELETE ON financial_risk_snapshots
                BEGIN SELECT RAISE(ABORT,'risk snapshots are immutable'); END;
              CREATE TABLE IF NOT EXISTS financial_sla_episodes (
                id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,
                alert_id TEXT NOT NULL,kind TEXT NOT NULL
                  CHECK(kind IN ('ACK_OVERDUE','RESOLUTION_OVERDUE',
                                 'WORK_DUE_OVERDUE')),
                episode INTEGER NOT NULL CHECK(episode>=1),
                state TEXT NOT NULL CHECK(state IN ('active','cleared')),
                deadline INTEGER NOT NULL,assignee TEXT,
                created_at INTEGER NOT NULL,closed_at INTEGER,
                UNIQUE(tenant_id,alert_id,kind,episode)
              );
              CREATE INDEX IF NOT EXISTS idx_sla_episodes_tenant
                ON financial_sla_episodes(tenant_id,state,created_at);
              CREATE TABLE IF NOT EXISTS financial_sla_state (
                tenant_id TEXT NOT NULL,alert_id TEXT NOT NULL,
                kind TEXT NOT NULL,episode_id TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(tenant_id,alert_id,kind)
              );
              CREATE TABLE IF NOT EXISTS financial_sla_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id TEXT NOT NULL, escalation_id TEXT NOT NULL,
                actor TEXT NOT NULL,kind TEXT NOT NULL,
                reason_json TEXT NOT NULL,at INTEGER NOT NULL,
                previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL
              );
              CREATE INDEX IF NOT EXISTS idx_sla_events_tenant
                ON financial_sla_events(tenant_id,escalation_id,seq);
              CREATE TRIGGER IF NOT EXISTS immutable_sla_events_update
                BEFORE UPDATE ON financial_sla_events
                BEGIN SELECT RAISE(ABORT,'sla history is immutable'); END;
              CREATE TRIGGER IF NOT EXISTS immutable_sla_events_delete
                BEFORE DELETE ON financial_sla_events
                BEGIN SELECT RAISE(ABORT,'sla history is immutable'); END;
            """)

    def execute(self,token,op,payload,idem_key=None):
        if op not in OPERATIONS:
            return super().execute(token,op,payload,idem_key)
        if type(payload) is not dict:
            raise Invalid("monitor payload must be a JSON object")
        writing=op in WRITES
        if writing and (not isinstance(idem_key,str)
                        or not KEY_RE.fullmatch(idem_key)):
            raise Invalid("monitor writes need an idempotency key")
        if not writing and idem_key is not None:
            raise Invalid("monitor reads do not accept idempotency keys")
        with self.connect(transaction=True) as db:
            identity=self._identity(db,token)
            if identity["role"]!="owner":
                raise Unauthorized("financial monitoring restricted to tenant owner")
            tenant,actor=identity["tenant_id"],identity["actor"]
            if writing:
                try:
                    request_hash=_secret_hash(canonical({"op":op,"payload":payload}))
                except (TypeError,ValueError) as e:
                    raise Invalid("monitor request cannot be canonicalized") from e
                cached=db.execute(
                    "SELECT op,request_sha,response_json FROM requests "
                    "WHERE tenant_id=? AND idem_key=?",
                    (tenant,idem_key)
                ).fetchone()
                if cached:
                    if cached["op"]!=op or cached["request_sha"]!=request_hash:
                        raise Conflict("idempotency key reused for a different operation")
                    return json.loads(cached["response_json"])
            result=self._apply_202(db,identity,op,payload)
            if writing:
                db.execute("INSERT INTO requests VALUES (?,?,?,?,?)",
                           (tenant,idem_key,op,request_hash,canonical(result)))
                db.execute(
                    """INSERT INTO audit(tenant_id,actor,operation,request_sha,recorded_at)
                       VALUES (?,?,?,?,?)""",
                    (tenant,actor,op,request_hash,self.clock())
                )
            return result

    def _apply_202(self,db,identity,op,p):
        tenant,actor,now=identity["tenant_id"],identity["actor"],self.clock()
        if op=="commerce.monitor.schedule.get":
            _object(p,set())
            return schedule_status(db,tenant)
        if op=="commerce.monitor.schedule.set":
            return configure(db,identity,p,now)
        if op=="commerce.monitor.schedule.run_due":
            _object(p,{"expected_schedule_version"})
            return run_due(db,self,identity,p["expected_schedule_version"],now)
        if op=="commerce.monitor.runs.list":
            _object(p,set(),{"limit"})
            return runs(db,tenant,p.get("limit",30))
        if op=="commerce.monitor.scan":
            _object(p,{"expected_policy_version"})
            policy,cfg=_policy(db,tenant)
            if policy["version"]!=_version(p["expected_policy_version"]):
                raise Conflict("stale M201 risk policy version")
            snapshot=_snapshot(db,identity,cfg,now)
            scan=self._scan(db,identity,policy,snapshot,now)
            captured,_=capture(db,identity,policy,cfg,now,actor,"manual")
            return {
                "status":"MANUAL_SCAN_COMPLETE","alert_changes":scan,
                "snapshot":captured,
                "bank_verified":False,"external_notifications_sent":False,
            }
        if op=="commerce.monitor.snapshots.list":
            _object(p,set(),{"limit"})
            return history(db,tenant,p.get("limit",60))
        if op=="commerce.monitor.snapshots.compare":
            _object(p,{"previous_id","current_id"})
            return comparison(db,tenant,p["previous_id"],p["current_id"])
        if op=="commerce.monitor.sla.refresh":
            _object(p,set())
            settings=db.execute(
                "SELECT * FROM financial_monitor_schedule WHERE tenant_id=?",
                (tenant,)
            ).fetchone()
            if settings is None:
                raise Invalid("configure monitoring SLA before refreshing")
            return refresh_sla(db,identity,settings,now,actor)
        if op=="commerce.monitor.sla.board":
            _object(p,set(),{"limit"})
            settings=db.execute(
                "SELECT * FROM financial_monitor_schedule WHERE tenant_id=?",
                (tenant,)
            ).fetchone()
            if settings is None:
                raise Invalid("configure monitoring SLA before opening board")
            return board(db,tenant,now,settings,p.get("limit",100))
        if op=="commerce.monitor.report":
            _object(p,set())
            return executive_report(db,identity,now)
        if op=="commerce.monitor.report.csv":
            _object(p,set())
            return export_csv(db,identity,now)
        raise Invalid("unrecognized M202 monitor operation")
