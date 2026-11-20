"""OSGARD SUPREME DIRECTOR M206: diagnostics and evidence-grade local backtests.

Additive SQLite schema and inherited M192..M205 auth/isolation. No bank or
external signing. Only owner can read or write financial assurance material.
"""
from __future__ import annotations

import json

from osgard_m192.runtime import (
    Invalid, Conflict, Unauthorized, KEY_RE, canonical, _secret_hash
)
from osgard_m205.runtime import Director205

from .diagnostics import scan,latest,acknowledge,history
from .forecast_quality import (
    freeze,add_observation,void_observation,list_baselines,backtest
)
from .reporting import packet,portfolio,export_csv

OPS=frozenset((
    "commerce.assurance.scan",
    "commerce.assurance.latest",
    "commerce.assurance.acknowledge",
    "commerce.assurance.history",
    "commerce.assurance.packet",
    "commerce.assurance.portfolio",
    "commerce.assurance.portfolio.csv",
    "commerce.forecast.freeze",
    "commerce.forecast.list",
    "commerce.forecast.observation.add",
    "commerce.forecast.observation.void",
    "commerce.forecast.backtest",
))
WRITES=frozenset((
    "commerce.assurance.scan",
    "commerce.assurance.acknowledge",
    "commerce.forecast.freeze",
    "commerce.forecast.observation.add",
    "commerce.forecast.observation.void",
))


class Director206(Director205):
    def initialize(self):
        super().initialize()
        with self.connect() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS m206_events(
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id TEXT NOT NULL,
                plan_id TEXT NOT NULL,
                domain TEXT NOT NULL CHECK(domain IN('diagnostics','forecast')),
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                details_json TEXT NOT NULL,
                at INTEGER NOT NULL,
                previous_hash TEXT NOT NULL,
                event_hash TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_m206_events
                ON m206_events(tenant_id,plan_id,domain,seq);
            CREATE TRIGGER IF NOT EXISTS immutable_m206_events_update
                BEFORE UPDATE ON m206_events
                BEGIN SELECT RAISE(ABORT,'M206 event journal is immutable'); END;
            CREATE TRIGGER IF NOT EXISTS immutable_m206_events_delete
                BEFORE DELETE ON m206_events
                BEGIN SELECT RAISE(ABORT,'M206 event journal is immutable'); END;

            CREATE TABLE IF NOT EXISTS m206_scans(
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,plan_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,created_by TEXT NOT NULL,
                payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,
                previous_hash TEXT NOT NULL,head_hash TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_m206_scans
                ON m206_scans(tenant_id,plan_id,created_at);
            CREATE TRIGGER IF NOT EXISTS immutable_m206_scans_update
                BEFORE UPDATE ON m206_scans
                BEGIN SELECT RAISE(ABORT,'M206 diagnostic snapshots immutable'); END;
            CREATE TRIGGER IF NOT EXISTS immutable_m206_scans_delete
                BEFORE DELETE ON m206_scans
                BEGIN SELECT RAISE(ABORT,'M206 diagnostic snapshots immutable'); END;

            CREATE TABLE IF NOT EXISTS m206_reviews(
                id TEXT PRIMARY KEY,
                tenant_id TEXT NOT NULL,plan_id TEXT NOT NULL,
                scan_id TEXT NOT NULL,finding_id TEXT NOT NULL,
                reason TEXT NOT NULL,actor TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS unique_m206_review
                ON m206_reviews(tenant_id,scan_id,finding_id);
            CREATE INDEX IF NOT EXISTS idx_m206_review_plan
                ON m206_reviews(tenant_id,plan_id);
            CREATE TRIGGER IF NOT EXISTS immutable_m206_reviews_update
                BEFORE UPDATE ON m206_reviews
                BEGIN SELECT RAISE(ABORT,'M206 acknowledgements immutable'); END;
            CREATE TRIGGER IF NOT EXISTS immutable_m206_reviews_delete
                BEFORE DELETE ON m206_reviews
                BEGIN SELECT RAISE(ABORT,'M206 acknowledgements immutable'); END;

            CREATE TABLE IF NOT EXISTS m206_forecasts(
                id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,
                plan_id TEXT NOT NULL,
                captured_at INTEGER NOT NULL,created_by TEXT NOT NULL,
                payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_m206_forecasts_plan
                ON m206_forecasts(tenant_id,plan_id,captured_at);
            CREATE TRIGGER IF NOT EXISTS immutable_m206_forecasts_update
                BEFORE UPDATE ON m206_forecasts
                BEGIN SELECT RAISE(ABORT,'M206 frozen forecasts immutable'); END;
            CREATE TRIGGER IF NOT EXISTS immutable_m206_forecasts_delete
                BEFORE DELETE ON m206_forecasts
                BEGIN SELECT RAISE(ABORT,'M206 frozen forecasts immutable'); END;

            CREATE TABLE IF NOT EXISTS m206_observations(
                id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,
                plan_id TEXT NOT NULL,baseline_id TEXT NOT NULL,
                month_index INTEGER NOT NULL CHECK(month_index BETWEEN 1 AND 36),
                reported_gross_minor INTEGER NOT NULL CHECK(
                    reported_gross_minor BETWEEN 0 AND 1000000000000),
                reported_operating_minor INTEGER NOT NULL CHECK(
                    reported_operating_minor BETWEEN 0 AND 1000000000000),
                evidence_note TEXT NOT NULL,
                reference TEXT NOT NULL,created_at INTEGER NOT NULL,
                created_by TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN('active','voided')),
                version INTEGER NOT NULL CHECK(version IN(1,2)),
                void_reason TEXT,voided_at INTEGER,voided_by TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS unique_m206_observed_month
                ON m206_observations(tenant_id,baseline_id,month_index)
                WHERE state='active';
            CREATE INDEX IF NOT EXISTS idx_m206_observation_plan
                ON m206_observations(tenant_id,plan_id,baseline_id);
            """)

    def execute(self,token,op,payload,idem_key=None):
        if op not in OPS:
            return super().execute(token,op,payload,idem_key)
        if type(payload) is not dict:
            raise Invalid("M206 payload must be a JSON object")
        writing=op in WRITES
        if writing and (not isinstance(idem_key,str) or
                        not KEY_RE.fullmatch(idem_key)):
            raise Invalid("M206 mutation requires an idempotency key")
        if not writing and idem_key is not None:
            raise Invalid("M206 read does not accept idempotency key")
        with self.connect(transaction=True) as db:
            identity=self._identity(db,token)
            if identity["role"]!="owner":
                raise Unauthorized("M206 financial assurance restricted to owner")
            tenant,actor=identity["tenant_id"],identity["actor"]
            if writing:
                try:
                    request_hash=_secret_hash(canonical({
                        "operation":op,"payload":payload
                    }))
                except (TypeError,ValueError,OverflowError) as exc:
                    raise Invalid("M206 request cannot be canonicalized") from exc
                prior=db.execute(
                    """SELECT op,request_sha,response_json FROM requests
                       WHERE tenant_id=? AND idem_key=?""",
                    (tenant,idem_key)
                ).fetchone()
                if prior is not None:
                    if prior["op"]!=op or prior["request_sha"]!=request_hash:
                        raise Conflict("M206 idempotency key reused with different request")
                    return json.loads(prior["response_json"])
            now=self.clock()
            result=self._apply_206(db,identity,op,payload,now)
            if writing:
                db.execute(
                    "INSERT INTO requests VALUES (?,?,?,?,?)",
                    (tenant,idem_key,op,request_hash,canonical(result))
                )
                db.execute(
                    """INSERT INTO audit
                       (tenant_id,actor,operation,request_sha,recorded_at)
                       VALUES (?,?,?,?,?)""",
                    (tenant,actor,op,request_hash,now)
                )
            return result

    def _apply_206(self,db,identity,op,p,now):
        tenant=identity["tenant_id"]
        if op=="commerce.assurance.scan":
            return scan(db,identity,p,now)
        if op=="commerce.assurance.latest":
            return latest(db,tenant,p)
        if op=="commerce.assurance.acknowledge":
            return acknowledge(db,identity,p,now)
        if op=="commerce.assurance.history":
            return history(db,tenant,p)
        if op=="commerce.assurance.packet":
            return packet(db,tenant,p,now)
        if op=="commerce.assurance.portfolio":
            if p:
                raise Invalid("assurance portfolio does not accept filters")
            return portfolio(db,tenant,now)
        if op=="commerce.assurance.portfolio.csv":
            if p:
                raise Invalid("assurance CSV does not accept filters")
            return export_csv(db,tenant,now)
        if op=="commerce.forecast.freeze":
            return freeze(db,identity,p,now)
        if op=="commerce.forecast.list":
            return list_baselines(db,tenant,p)
        if op=="commerce.forecast.observation.add":
            return add_observation(db,identity,p,now)
        if op=="commerce.forecast.observation.void":
            return void_observation(db,identity,p,now)
        if op=="commerce.forecast.backtest":
            return backtest(db,tenant,p)
        raise Invalid("unknown M206 assurance operation")
