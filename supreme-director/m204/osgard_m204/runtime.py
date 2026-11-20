"""OSGARD M204: real local economic ledger, scenario ROI and priority board.

Extends M203. No external side effects. All money manually supplied, limited
to integer kopecks. Model effects and owner claims are not bank verified.
"""
from __future__ import annotations

import csv
import io
import json

from osgard_m192.runtime import (
    KEY_RE, Invalid, Conflict, Unauthorized, canonical, _secret_hash, _object
)
from osgard_m203.runtime import Director203
from osgard_m202.runtime import _plain_csv

from .economics_ledger import add, void, ledger
from .economics_roi import scenarios
from .economics_priority import set_priority, board

PREFIX="commerce.economics."
OP_ADD=PREFIX+"entry.add"
OP_VOID=PREFIX+"entry.void"
OP_LEDGER=PREFIX+"ledger"
OP_SCENARIOS=PREFIX+"scenarios"
OP_PRIORITY_SET=PREFIX+"priority.set"
OP_BOARD=PREFIX+"priority.board"
OP_PORTFOLIO=PREFIX+"portfolio"
OP_CSV=PREFIX+"portfolio.csv"
OPS=frozenset((
    OP_ADD,OP_VOID,OP_LEDGER,OP_SCENARIOS,OP_PRIORITY_SET,
    OP_BOARD,OP_PORTFOLIO,OP_CSV
))
WRITES=frozenset((OP_ADD,OP_VOID,OP_PRIORITY_SET))


def portfolio(db,tenant,now):
    listing=board(db,tenant,{"limit":200,"include_closed":True},now)
    rows=listing["items"]
    costs=sum(item["cost_incurred_minor"] for item in rows)
    planned=sum(item["cost_planned_minor"] for item in rows)
    forecast=sum(item["forecast_monthly_minor"] for item in rows)
    return {
        "schema":"osgard.m204.economics-portfolio/1",
        "as_of":now,"tenant_id":tenant,
        "plans_total":listing["total"],
        "plans_returned":len(rows),
        "plans_truncated":listing["truncated"],
        "cost_planned_minor":planned,
        "cost_incurred_minor":costs,
        "forecast_monthly_minor":forecast,
        "totals_cover_entire_tenant":not listing["truncated"],
        "planned_and_incurred_not_combined":True,
        "forecast_not_realized_revenue":True,
        "items":rows,
        "bank_verified":False,"causation_proven":False,
        "production_authorized":False,
        "warnings":[
            "All costs and benefits are manually entered, not reconciled.",
            "Planned and incurred costs are separate bases; do not add both.",
            "Monthly forecasts are not one-off self-reported benefits.",
            "Manual ranks are preferences, not profit predictions.",
        ],
    }


def export_csv(db,tenant,now):
    data=portfolio(db,tenant,now)
    if data["plans_truncated"]:
        raise Invalid("CSV export limited to 200 plans; segment the portfolio first")
    out=io.StringIO(newline="")
    writer=csv.writer(out,delimiter=";",lineterminator="\r\n")
    writer.writerow((
        "Ранг","ID плана","План","Правило","Статус",
        "Срок UTC epoch","Субъективная оценка x100",
        "Плановые затраты, коп.","Заявленные затраты, коп.",
        "Прогноз ежемесячной выгоды, коп.","Есть данные для сценария",
        "Подтверждено банком","Доказана причинность"
    ))
    for row in data["items"]:
        writer.writerow([_plain_csv(v) for v in (
            row["rank"],row["plan_id"],row["title"],
            row["rule"],row["status"],row["due_at"],
            row["manual_score_x100"],
            row["cost_planned_minor"],row["cost_incurred_minor"],
            row["forecast_monthly_minor"],
            (row["projected_cost_basis_available"] and
             row["monthly_benefit_forecast_available"]),
            False,False
        )])
    return {
        "filename":"osgard-m204-decision-portfolio.csv",
        "mime":"text/csv; charset=utf-8",
        "content":"\ufeff"+out.getvalue(),"rows":len(data["items"]),
        "formula_injection_guard":True,
        "source":"MANUAL_LOCAL_RECORDS",
        "bank_verified":False,"production_authorized":False,
    }


class Director204(Director203):
    def initialize(self):
        super().initialize()
        with self.connect() as db:
            db.executescript("""
              CREATE TABLE IF NOT EXISTS economics_entries(
                id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,
                plan_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN(
                    'cost_planned','cost_incurred',
                    'benefit_forecast_monthly','benefit_reported_once')),
                amount_minor INTEGER NOT NULL
                    CHECK(amount_minor BETWEEN 1 AND 1000000000000),
                title TEXT NOT NULL,evidence_note TEXT NOT NULL,
                evaluation_id TEXT,reference TEXT,
                state TEXT NOT NULL CHECK(state IN('active','voided')),
                version INTEGER NOT NULL CHECK(version IN(1,2)),
                created_by TEXT NOT NULL,created_at INTEGER NOT NULL,
                voided_by TEXT,voided_at INTEGER,void_reason TEXT
              );
              CREATE INDEX IF NOT EXISTS economics_entries_plan
                ON economics_entries(tenant_id,plan_id,created_at,id);
              CREATE UNIQUE INDEX IF NOT EXISTS economics_active_reference
                ON economics_entries(tenant_id,plan_id,kind,reference)
                WHERE state='active' AND reference IS NOT NULL;
              CREATE TABLE IF NOT EXISTS economics_priorities(
                tenant_id TEXT NOT NULL,plan_id TEXT NOT NULL,
                urgency INTEGER NOT NULL CHECK(urgency BETWEEN 1 AND 5),
                impact INTEGER NOT NULL CHECK(impact BETWEEN 1 AND 5),
                effort INTEGER NOT NULL CHECK(effort BETWEEN 1 AND 5),
                confidence INTEGER NOT NULL CHECK(confidence BETWEEN 1 AND 5),
                rationale TEXT NOT NULL,version INTEGER NOT NULL
                    CHECK(version>=1),
                updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL,
                PRIMARY KEY(tenant_id,plan_id)
              );
              CREATE TABLE IF NOT EXISTS economics_events(
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id TEXT NOT NULL,plan_id TEXT NOT NULL,
                actor TEXT NOT NULL,action TEXT NOT NULL,
                details_json TEXT NOT NULL,at INTEGER NOT NULL,
                previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL
              );
              CREATE INDEX IF NOT EXISTS economics_events_plan
                ON economics_events(tenant_id,plan_id,seq);
              CREATE TRIGGER IF NOT EXISTS immutable_economics_events_update
                BEFORE UPDATE ON economics_events
                BEGIN SELECT RAISE(ABORT,'economics events immutable'); END;
              CREATE TRIGGER IF NOT EXISTS immutable_economics_events_delete
                BEFORE DELETE ON economics_events
                BEGIN SELECT RAISE(ABORT,'economics events immutable'); END;
            """)

    def execute(self,token,op,payload,idem_key=None):
        if op not in OPS:
            return super().execute(token,op,payload,idem_key)
        if type(payload) is not dict:
            raise Invalid("M204 economic payload must be an object")
        writing=op in WRITES
        if writing and (not isinstance(idem_key,str)
                        or not KEY_RE.fullmatch(idem_key)):
            raise Invalid("economic mutation requires an idempotency key")
        if not writing and idem_key is not None:
            raise Invalid("economic reads do not accept an idempotency key")
        with self.connect(transaction=True) as db:
            identity=self._identity(db,token)
            if identity["role"]!="owner":
                raise Unauthorized("financial economics restricted to tenant owner")
            tenant,actor=identity["tenant_id"],identity["actor"]
            if writing:
                try:
                    request_hash=_secret_hash(canonical({"op":op,"payload":payload}))
                except (ValueError,TypeError,OverflowError) as exc:
                    raise Invalid("invalid economic request value") from exc
                old=db.execute(
                    """SELECT op,request_sha,response_json FROM requests
                       WHERE tenant_id=? AND idem_key=?""",
                    (tenant,idem_key)
                ).fetchone()
                if old is not None:
                    if old["op"]!=op or old["request_sha"]!=request_hash:
                        raise Conflict("idempotency key reused with different request")
                    return json.loads(old["response_json"])
            now=self.clock()
            result=self._apply_204(db,identity,op,payload,now)
            if writing:
                db.execute("INSERT INTO requests VALUES (?,?,?,?,?)",
                           (tenant,idem_key,op,request_hash,canonical(result)))
                db.execute(
                    """INSERT INTO audit
                       (tenant_id,actor,operation,request_sha,recorded_at)
                       VALUES (?,?,?,?,?)""",
                    (tenant,actor,op,request_hash,now)
                )
            return result

    def _apply_204(self,db,identity,op,p,now):
        tenant=identity["tenant_id"]
        if op==OP_ADD:
            return add(db,identity,p,now)
        if op==OP_VOID:
            return void(db,identity,p,now)
        if op==OP_LEDGER:
            _object(p,{"plan_id"},{"limit"})
            return ledger(db,tenant,p["plan_id"],p.get("limit",200))
        if op==OP_SCENARIOS:
            return scenarios(db,tenant,p)
        if op==OP_PRIORITY_SET:
            return set_priority(db,identity,p,now)
        if op==OP_BOARD:
            return board(db,tenant,p,now)
        if op==OP_PORTFOLIO:
            _object(p,set())
            return portfolio(db,tenant,now)
        if op==OP_CSV:
            _object(p,set())
            return export_csv(db,tenant,now)
        raise Invalid("unknown economics operation")
