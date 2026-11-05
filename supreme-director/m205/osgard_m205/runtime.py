"""OSGARD M205: exact cost source reconciliation and recurring-expense ROI.

M192..M204 remain intact. Only additive tables, explicit owner operations,
same SQLite transactions, tenant isolation, role checks and idempotency.
"""
from __future__ import annotations

import csv
import io
import json

from osgard_m192.runtime import (
    KEY_RE, Invalid, Conflict, Unauthorized, canonical, _secret_hash, _object
)
from osgard_m202.runtime import _plain_csv
from osgard_m204.runtime import Director204

from .reconciliation import link, unlink, inspect
from .recurring import create, void, listed, calendar
from .net_roi import calculate

OPS=frozenset((
    "commerce.reconcile.link",
    "commerce.reconcile.unlink",
    "commerce.reconcile.inspect",
    "commerce.reconcile.portfolio",
    "commerce.reconcile.portfolio.csv",
    "commerce.recurring.add",
    "commerce.recurring.void",
    "commerce.recurring.list",
    "commerce.recurring.calendar",
    "commerce.economics.net_scenarios",
))
WRITES=frozenset((
    "commerce.reconcile.link",
    "commerce.reconcile.unlink",
    "commerce.recurring.add",
    "commerce.recurring.void",
))


def portfolio(db,tenant,now):
    plans=db.execute(
        """SELECT id,title,rule,status,due_at FROM financial_action_plans
           WHERE tenant_id=? ORDER BY created_at,id LIMIT 201""",
        (tenant,)
    ).fetchall()
    if len(plans)>200:
        raise Invalid("M205 portfolio limited to 200 plans; archive before export")
    rows=[]
    stats={
        "active_links":0,"stale_links":0,
        "unlinked_manual_cost_entries":0,
        "manual_candidate_groups":0,
        "recurring_planned_total_12_minor":0,
        "recurring_reported_total_12_minor":0,
    }
    for p in plans:
        report=inspect(db,tenant,p["id"],limit=200)
        planned=calendar(db,tenant,p["id"],"planned",12)
        reported=calendar(db,tenant,p["id"],"reported",12)
        valid=sum(row["match_status"]=="MATCHED_LOCAL_RECORDS"
                  for row in report["links"] if row["state"]=="active")
        drift=sum(row["state"]=="active" and
                  row["match_status"]!="MATCHED_LOCAL_RECORDS"
                  for row in report["links"])
        missing=sum(b["unlinked_count"] for b in report["basis"].values())
        stats["active_links"]+=valid
        stats["stale_links"]+=drift
        stats["unlinked_manual_cost_entries"]+=missing
        stats["manual_candidate_groups"]+=len(report["candidate_groups"])
        stats["recurring_planned_total_12_minor"]+=planned["total_minor"]
        stats["recurring_reported_total_12_minor"]+=reported["total_minor"]
        rows.append({
            "plan_id":p["id"],"title":p["title"],"rule":p["rule"],
            "plan_status":p["status"],"due_at":p["due_at"],
            "linked_costs_valid":valid,"stale_source_links":drift,
            "manual_cost_entries_unlinked":missing,
            "cost_planned_minor":report["basis"]["cost_planned"]["total_cost_minor"],
            "cost_incurred_minor":report["basis"]["cost_incurred"]["total_cost_minor"],
            "recurring_planned_12_month_minor":planned["total_minor"],
            "recurring_reported_12_month_minor":reported["total_minor"],
            "reconciliation_complete_for_planned":report["basis"]["cost_planned"]["complete"],
            "reconciliation_complete_for_incurred":report["basis"]["cost_incurred"]["complete"],
            "bank_verified":False,
        })
    return {
        "schema":"osgard.m205.economic-reconciliation/1",
        "tenant_id":tenant,"generated_at":now,
        "plans_total":len(rows),"items":rows,"totals":stats,
        "cost_bases_never_summed_together":True,
        "m198_expenses_never_added_to_m204_again":True,
        "self_reported_recurring_not_bank_verified":True,
        "external_anchor":False,"bank_verified":False,
        "production_authorized":False,
        "warnings":[
            "Local M198↔M204 equality is not bank reconciliation.",
            "Unlinked manual M204 costs may match M198 records; do not assume a duplicate automatically.",
            "A stale source link must be unlinked or corrected before reliable modeling.",
            "Recurring costs are owner-entered and can be incomplete.",
        ],
    }


def export_csv(db,tenant,now):
    report=portfolio(db,tenant,now)
    output=io.StringIO(newline="")
    w=csv.writer(output,delimiter=";",lineterminator="\r\n")
    w.writerow((
        "ID плана","Название","Статус","Активные связи M198",
        "Устаревшие связи","Непривязанные ручные затраты",
        "Плановые разовые затраты коп.","Заявленные разовые затраты коп.",
        "Плановые регулярные за 12 мес коп.",
        "Заявленные регулярные за 12 мес коп.",
        "Подтверждено банком","Расходы M198 прибавлены повторно"
    ))
    for r in report["items"]:
        w.writerow([_plain_csv(v) for v in (
            r["plan_id"],r["title"],r["plan_status"],r["linked_costs_valid"],
            r["stale_source_links"],r["manual_cost_entries_unlinked"],
            r["cost_planned_minor"],r["cost_incurred_minor"],
            r["recurring_planned_12_month_minor"],
            r["recurring_reported_12_month_minor"],
            False,False
        )])
    return {
        "filename":"osgard-m205-reconciliation.csv",
        "mime":"text/csv; charset=utf-8",
        "content":"\ufeff"+output.getvalue(),"rows":len(report["items"]),
        "formula_injection_guard":True,"bank_verified":False,
        "production_authorized":False,
    }


class Director205(Director204):
    def initialize(self):
        super().initialize()
        with self.connect() as db:
            db.executescript("""
              CREATE TABLE IF NOT EXISTS m205_events(
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id TEXT NOT NULL,plan_id TEXT NOT NULL,
                domain TEXT NOT NULL CHECK(domain IN ('reconciliation','recurring')),
                actor TEXT NOT NULL,action TEXT NOT NULL,
                details_json TEXT NOT NULL,at INTEGER NOT NULL,
                previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL
              );
              CREATE INDEX IF NOT EXISTS idx_m205_events
                ON m205_events(tenant_id,plan_id,domain,seq);
              CREATE TRIGGER IF NOT EXISTS immutable_m205_events_update
                BEFORE UPDATE ON m205_events
                BEGIN SELECT RAISE(ABORT,'M205 evidence is immutable'); END;
              CREATE TRIGGER IF NOT EXISTS immutable_m205_events_delete
                BEFORE DELETE ON m205_events
                BEGIN SELECT RAISE(ABORT,'M205 evidence is immutable'); END;

              CREATE TABLE IF NOT EXISTS m205_cost_links(
                id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,
                plan_id TEXT NOT NULL,economic_entry_id TEXT NOT NULL,
                project_id TEXT NOT NULL,expense_id TEXT NOT NULL,
                economic_version INTEGER NOT NULL,
                source_version INTEGER NOT NULL,
                cost_kind TEXT NOT NULL CHECK(cost_kind IN(
                    'cost_planned','cost_incurred')),
                amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
                created_by TEXT NOT NULL,created_at INTEGER NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('active','unlinked')),
                version INTEGER NOT NULL CHECK(version IN (1,2)),
                unlinked_by TEXT,unlinked_at INTEGER,unlink_reason TEXT
              );
              CREATE INDEX IF NOT EXISTS idx_m205_link_plan
                ON m205_cost_links(tenant_id,plan_id,state);
              CREATE UNIQUE INDEX IF NOT EXISTS unique_m205_cost_entry
                ON m205_cost_links(tenant_id,economic_entry_id)
                WHERE state='active';
              CREATE UNIQUE INDEX IF NOT EXISTS unique_m205_source_expense
                ON m205_cost_links(tenant_id,expense_id)
                WHERE state='active';

              CREATE TABLE IF NOT EXISTS m205_recurring_costs(
                id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,
                plan_id TEXT NOT NULL,
                basis TEXT NOT NULL CHECK(basis IN ('planned','reported')),
                title TEXT NOT NULL,amount_minor INTEGER NOT NULL
                    CHECK(amount_minor BETWEEN 1 AND 1000000000000),
                start_month INTEGER NOT NULL CHECK(
                    start_month BETWEEN 1 AND 36),
                end_month INTEGER NOT NULL CHECK(
                    end_month BETWEEN 1 AND 36),
                evidence_note TEXT NOT NULL,reference TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN('active','voided')),
                version INTEGER NOT NULL CHECK(version IN(1,2)),
                created_by TEXT NOT NULL,created_at INTEGER NOT NULL,
                voided_by TEXT,voided_at INTEGER,void_reason TEXT,
                CHECK(start_month<=end_month)
              );
              CREATE INDEX IF NOT EXISTS idx_m205_recurring_plan
                ON m205_recurring_costs(tenant_id,plan_id,basis,state);
              CREATE UNIQUE INDEX IF NOT EXISTS unique_m205_recurring_ref
                ON m205_recurring_costs(tenant_id,plan_id,basis,reference)
                WHERE state='active';
            """)

    def execute(self,token,op,payload,idem_key=None):
        if op not in OPS:
            return super().execute(token,op,payload,idem_key)
        if type(payload) is not dict:
            raise Invalid("M205 request must be an object")
        writing=op in WRITES
        if writing and (not isinstance(idem_key,str)
                        or not KEY_RE.fullmatch(idem_key)):
            raise Invalid("M205 mutation requires idempotency key")
        if not writing and idem_key is not None:
            raise Invalid("M205 read endpoint does not accept idempotency key")
        with self.connect(transaction=True) as db:
            identity=self._identity(db,token)
            if identity["role"]!="owner":
                raise Unauthorized("M205 economic reconciliation restricted to owner")
            tenant,actor=identity["tenant_id"],identity["actor"]
            if writing:
                try:
                    request_hash=_secret_hash(canonical({"op":op,"payload":payload}))
                except (TypeError,ValueError,OverflowError) as exc:
                    raise Invalid("cannot canonicalize M205 request") from exc
                seen=db.execute(
                    """SELECT op,request_sha,response_json FROM requests
                       WHERE tenant_id=? AND idem_key=?""",
                    (tenant,idem_key)
                ).fetchone()
                if seen is not None:
                    if seen["op"]!=op or seen["request_sha"]!=request_hash:
                        raise Conflict("idempotency key reused for different request")
                    return json.loads(seen["response_json"])
            now=self.clock()
            result=self._apply_205(db,identity,op,payload,now)
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

    def _apply_205(self,db,identity,op,p,now):
        tenant=identity["tenant_id"]
        if op=="commerce.reconcile.link":
            return link(db,identity,p,now)
        if op=="commerce.reconcile.unlink":
            return unlink(db,identity,p,now)
        if op=="commerce.reconcile.inspect":
            _object(p,{"plan_id"},{"limit"})
            return inspect(db,tenant,p["plan_id"],p.get("limit",100))
        if op=="commerce.reconcile.portfolio":
            _object(p,set())
            return portfolio(db,tenant,now)
        if op=="commerce.reconcile.portfolio.csv":
            _object(p,set())
            return export_csv(db,tenant,now)
        if op=="commerce.recurring.add":
            return create(db,identity,p,now)
        if op=="commerce.recurring.void":
            return void(db,identity,p,now)
        if op=="commerce.recurring.list":
            _object(p,{"plan_id"},{"limit"})
            return listed(db,tenant,p["plan_id"],p.get("limit",100))
        if op=="commerce.recurring.calendar":
            _object(p,{"plan_id","basis","horizon_months"})
            return calendar(db,tenant,p["plan_id"],p["basis"],p["horizon_months"])
        if op=="commerce.economics.net_scenarios":
            return calculate(db,tenant,p)
        raise Invalid("unsupported M205 operation")
