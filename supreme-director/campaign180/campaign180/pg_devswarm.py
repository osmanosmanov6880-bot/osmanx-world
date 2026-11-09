"""TITAN-X14 (also X11/X12/X13/X15): central PostgreSQL DevSwarm scheduler.

Unlike SQLite, PostgreSQL coordinates multiple processes and hosts over a
shared database with row locks, atomic leases, fencing and tenant budgets.
This is a *local integration candidate*, NOT a certified upstream DevSwarm
service. No external task effects, network client dispatch or worker code.

Requires psycopg 3 installed by the operator; the X14 CI provisions a
temporary PostgreSQL service and tests concurrent independent clients.
"""
from __future__ import annotations
from contextlib import contextmanager
from dataclasses import dataclass
import json
from typing import Mapping

from .contracts import TENANT_RE,ContractError,canonical,digest,validate_task,validate_result
from .queue import _WORKER
from .scheduler import ResourceCost

class SharedSchedulerDenied(ValueError):
    pass

@dataclass(frozen=True)
class SharedLease:
    tenant_id: str
    task_id: str
    task_digest: str
    worker_id: str
    fence: int
    deadline: int
    attempt: int
    task: dict

DDL="""
CREATE TABLE IF NOT EXISTS titan_pg_budgets(
    tenant text PRIMARY KEY,
    max_inflight integer NOT NULL CHECK(max_inflight BETWEEN 1 AND 1000000),
    max_cpu bigint NOT NULL CHECK(max_cpu>0),
    max_memory bigint NOT NULL CHECK(max_memory>0),
    max_disk bigint NOT NULL CHECK(max_disk>0),
    max_pending integer NOT NULL CHECK(max_pending BETWEEN 1 AND 1000000));
CREATE TABLE IF NOT EXISTS titan_pg_jobs(
    tenant text NOT NULL,task_id text NOT NULL,idem text NOT NULL,actor text NOT NULL,
    task_digest text NOT NULL,task_json text NOT NULL,capability text NOT NULL,
    expires_at bigint NOT NULL,ready_at bigint NOT NULL,created_at bigint NOT NULL,
    state text NOT NULL CHECK(state IN ('ready','leased','done','dead')),
    attempts integer NOT NULL DEFAULT 0,fence bigint NOT NULL DEFAULT 0,
    lease_owner text,lease_until bigint,result_digest text,
    PRIMARY KEY(tenant,task_id),UNIQUE(tenant,idem));
CREATE INDEX IF NOT EXISTS titan_pg_jobs_ready
    ON titan_pg_jobs(tenant,state,ready_at,created_at);
CREATE TABLE IF NOT EXISTS titan_pg_allocations(
    tenant text NOT NULL,task_id text NOT NULL,worker text NOT NULL,
    fence bigint NOT NULL,cpu bigint NOT NULL,memory bigint NOT NULL,
    disk bigint NOT NULL,deadline bigint NOT NULL,
    PRIMARY KEY(tenant,task_id));
CREATE INDEX IF NOT EXISTS titan_pg_alloc_worker ON titan_pg_allocations(worker);
CREATE TABLE IF NOT EXISTS titan_pg_effects(
    tenant text NOT NULL,task_id text NOT NULL,idem text NOT NULL,
    task_digest text NOT NULL,result_digest text NOT NULL,fence bigint NOT NULL,
    PRIMARY KEY(tenant,task_id),UNIQUE(tenant,idem));
CREATE TABLE IF NOT EXISTS titan_pg_cursor(
    id integer PRIMARY KEY CHECK(id=1),last_tenant text NOT NULL);
INSERT INTO titan_pg_cursor(id,last_tenant) VALUES(1,'')
    ON CONFLICT(id) DO NOTHING;
CREATE OR REPLACE FUNCTION titan_pg_forbid_effect_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'committed DevSwarm effect is immutable'; END;
$$;
DROP TRIGGER IF EXISTS titan_pg_effect_no_update ON titan_pg_effects;
CREATE TRIGGER titan_pg_effect_no_update BEFORE UPDATE OR DELETE ON titan_pg_effects
    FOR EACH ROW EXECUTE FUNCTION titan_pg_forbid_effect_mutation();
"""

class PostgresDevSwarmScheduler:
    def __init__(self,dsn:str,capability_costs:Mapping[str,ResourceCost],*,
                 max_attempts:int=3,worker_max_inflight:int=16):
        if (type(dsn) is not str or not dsn or
            not isinstance(capability_costs,Mapping) or not capability_costs or
            any(type(k) is not str or type(v) is not ResourceCost
                for k,v in capability_costs.items()) or
            type(max_attempts) is not int or not 1<=max_attempts<=20 or
            type(worker_max_inflight) is not int or not 1<=worker_max_inflight<=1000):
            raise SharedSchedulerDenied("Trusted PostgreSQL configuration required")
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:
            raise SharedSchedulerDenied("psycopg 3 required for shared PostgreSQL") from exc
        self._psycopg=psycopg
        self._dict_row=dict_row
        self.dsn=dsn
        self.costs=dict(capability_costs)
        self.max_attempts=max_attempts
        self.worker_max_inflight=worker_max_inflight
        with self._tx() as db:
            # Dedicated test schema/DB should be used. Never give this role
            # privileges over production KRAKEN/DevSwarm by default.
            db.execute(DDL,prepare=False)

    @contextmanager
    def _tx(self):
        db=self._psycopg.connect(self.dsn,autocommit=False,row_factory=self._dict_row,
                                 connect_timeout=10)
        try:
            with db.transaction():
                yield db
        finally:
            db.close()

    @staticmethod
    def _time(now:int):
        if type(now) is not int or now<0:
            raise SharedSchedulerDenied("Trusted epoch required")

    def set_budget(self,tenant:str,*,max_inflight:int,max_cpu:int,
                   max_memory:int,max_disk:int,max_pending:int=1000):
        if type(tenant) is not str or not TENANT_RE.fullmatch(tenant):
            raise SharedSchedulerDenied("Valid explicit tenant required")
        if any(type(x) is not int or not 1<=x<=1000000 for x in
               (max_inflight,max_cpu,max_memory,max_disk,max_pending)):
            raise SharedSchedulerDenied("Bounded positive capacity required")
        with self._tx() as db:
            current=db.execute("""SELECT * FROM titan_pg_budgets WHERE tenant=%s
                FOR UPDATE""",(tenant,)).fetchone()
            n,cpu,mem,disk=self._usage(db,tenant)
            waiting=db.execute("""SELECT COUNT(*) AS n FROM titan_pg_jobs
                WHERE tenant=%s AND state='ready'""",(tenant,)).fetchone()["n"]
            if n>max_inflight or cpu>max_cpu or mem>max_memory or disk>max_disk or waiting>max_pending:
                raise SharedSchedulerDenied("Cannot shrink below active or pending allocations")
            db.execute("""INSERT INTO titan_pg_budgets
                (tenant,max_inflight,max_cpu,max_memory,max_disk,max_pending)
                VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(tenant) DO UPDATE SET
                max_inflight=excluded.max_inflight,max_cpu=excluded.max_cpu,
                max_memory=excluded.max_memory,max_disk=excluded.max_disk,
                max_pending=excluded.max_pending""",
                (tenant,max_inflight,max_cpu,max_memory,max_disk,max_pending))

    @staticmethod
    def _usage(db,tenant):
        r=db.execute("""SELECT COUNT(*) AS n,COALESCE(SUM(cpu),0) AS cpu,
            COALESCE(SUM(memory),0) AS mem,COALESCE(SUM(disk),0) AS disk
            FROM titan_pg_allocations WHERE tenant=%s""",(tenant,)).fetchone()
        return (r["n"],r["cpu"],r["mem"],r["disk"])

    def admit(self,task:dict,*,authenticated_tenant:str,authenticated_actor:str,
              scopes:set[str],now:int)->str:
        """Caller supplies already authenticated identity; no public API here."""
        self._time(now)
        valid=validate_task(task,tenant_id=authenticated_tenant,actor_id=authenticated_actor,
                             allow_capabilities=set(self.costs),allowed_scopes=scopes,now=now)
        p=valid["task"]
        if now>=p["expires_at"]:
            raise SharedSchedulerDenied("Expired task not admitted")
        with self._tx() as db:
            policy=db.execute("""SELECT * FROM titan_pg_budgets WHERE tenant=%s
                FOR UPDATE""",(authenticated_tenant,)).fetchone()
            if policy is None:
                raise SharedSchedulerDenied("Tenant has no trusted resource admission")
            old=db.execute("""SELECT task_digest FROM titan_pg_jobs
                WHERE tenant=%s AND idem=%s""",
                (authenticated_tenant,p["idempotency_key"])).fetchone()
            if old:
                if old["task_digest"]!=valid["digest"]:
                    raise SharedSchedulerDenied("Idempotency collision")
                return "DUPLICATE_NO_NEW_EFFECT"
            ready=db.execute("""SELECT COUNT(*) AS n FROM titan_pg_jobs
                WHERE tenant=%s AND state='ready'""",
                (authenticated_tenant,)).fetchone()["n"]
            if ready>=policy["max_pending"]:
                raise SharedSchedulerDenied("Tenant queue backpressure exceeded")
            db.execute("""INSERT INTO titan_pg_jobs(tenant,task_id,idem,actor,
                task_digest,task_json,capability,expires_at,ready_at,created_at,state)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'ready')""",
                (authenticated_tenant,p["task_id"],p["idempotency_key"],
                 authenticated_actor,valid["digest"],canonical(p).decode(),
                 p["capability"],p["expires_at"],max(now,p["issued_at"]),now))
            return "ADMITTED_POSTGRES_LOCAL_ONLY"

    def _recover(self,db,now:int)->dict:
        ended=db.execute("""UPDATE titan_pg_jobs SET state='dead',
            lease_owner=NULL,lease_until=NULL WHERE state IN ('ready','leased')
            AND expires_at<=%s""",(now,)).rowcount
        maxed=db.execute("""UPDATE titan_pg_jobs SET state='dead',
            lease_owner=NULL,lease_until=NULL WHERE state='leased'
            AND lease_until<=%s AND attempts>=%s""",
            (now,self.max_attempts)).rowcount
        requeued=db.execute("""UPDATE titan_pg_jobs SET state='ready',ready_at=%s,
            lease_owner=NULL,lease_until=NULL WHERE state='leased'
            AND lease_until<=%s AND attempts<%s AND expires_at>%s""",
            (now,now,self.max_attempts,now)).rowcount
        db.execute("""DELETE FROM titan_pg_allocations a WHERE NOT EXISTS(
            SELECT 1 FROM titan_pg_jobs j WHERE j.tenant=a.tenant
            AND j.task_id=a.task_id AND j.state='leased'
            AND j.fence=a.fence AND j.lease_owner=a.worker
            AND j.lease_until=a.deadline AND j.lease_until>%s)""",(now,))
        return {"dead":ended+maxed,"requeued":requeued}

    def recover(self,*,now:int)->dict:
        self._time(now)
        with self._tx() as db:
            db.execute("SELECT last_tenant FROM titan_pg_cursor WHERE id=1 FOR UPDATE")
            return self._recover(db,now)

    def reserve(self,*,worker_id:str,now:int,lease_seconds:int=30)->SharedLease|None:
        self._time(now)
        if (type(worker_id) is not str or not _WORKER.fullmatch(worker_id) or
            type(lease_seconds) is not int or not 1<=lease_seconds<=300):
            raise SharedSchedulerDenied("Worker and lease budget required")
        with self._tx() as db:
            cursor=db.execute("""SELECT last_tenant FROM titan_pg_cursor
                WHERE id=1 FOR UPDATE""").fetchone()
            self._recover(db,now)
            used_worker=db.execute("""SELECT COUNT(*) AS n FROM titan_pg_allocations
                WHERE worker=%s""",(worker_id,)).fetchone()["n"]
            if used_worker>=self.worker_max_inflight:return None
            tenants=[r["tenant"] for r in db.execute("""SELECT DISTINCT tenant
                FROM titan_pg_jobs WHERE state='ready' AND ready_at<=%s
                AND expires_at>%s ORDER BY tenant""",(now,now)).fetchall()]
            last=cursor["last_tenant"]
            for tenant in [t for t in tenants if t>last]+[t for t in tenants if t<=last]:
                budget=db.execute("""SELECT * FROM titan_pg_budgets
                    WHERE tenant=%s FOR UPDATE""",(tenant,)).fetchone()
                if not budget:continue
                n,cpu,mem,disk=self._usage(db,tenant)
                if n>=budget["max_inflight"]:continue
                rows=db.execute("""SELECT * FROM titan_pg_jobs
                    WHERE tenant=%s AND state='ready' AND ready_at<=%s
                    AND expires_at>%s ORDER BY created_at,task_id
                    FOR UPDATE SKIP LOCKED LIMIT 100""",
                    (tenant,now,now)).fetchall()
                for row in rows:
                    cost=self.costs.get(row["capability"])
                    if not cost:continue
                    if (cpu+cost.cpu_units>budget["max_cpu"] or
                        mem+cost.memory_mb>budget["max_memory"] or
                        disk+cost.disk_mb>budget["max_disk"]):continue
                    task=json.loads(row["task_json"])
                    if digest(task)!=row["task_digest"]:
                        raise SharedSchedulerDenied("Stored task digest was modified")
                    deadline=min(now+lease_seconds,row["expires_at"])
                    fence=row["fence"]+1
                    changed=db.execute("""UPDATE titan_pg_jobs SET
                        state='leased',attempts=attempts+1,fence=%s,
                        lease_owner=%s,lease_until=%s
                        WHERE tenant=%s AND task_id=%s AND state='ready'""",
                        (fence,worker_id,deadline,tenant,row["task_id"])).rowcount
                    if changed!=1:raise SharedSchedulerDenied("Lease race lost")
                    db.execute("""INSERT INTO titan_pg_allocations
                        (tenant,task_id,worker,fence,cpu,memory,disk,deadline)
                        VALUES(%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (tenant,row["task_id"],worker_id,fence,cost.cpu_units,
                         cost.memory_mb,cost.disk_mb,deadline))
                    db.execute("""UPDATE titan_pg_cursor SET last_tenant=%s
                        WHERE id=1""",(tenant,))
                    return SharedLease(tenant,row["task_id"],row["task_digest"],
                        worker_id,fence,deadline,row["attempts"]+1,task)
            return None

    def _locked(self,db,lease:SharedLease,now:int):
        if type(lease) is not SharedLease:
            raise SharedSchedulerDenied("Immutable shared lease required")
        row=db.execute("""SELECT * FROM titan_pg_jobs WHERE tenant=%s
            AND task_id=%s FOR UPDATE""",(lease.tenant_id,lease.task_id)).fetchone()
        if (not row or row["task_digest"]!=lease.task_digest or
            row["state"]!='leased' or row["fence"]!=lease.fence or
            row["lease_owner"]!=lease.worker_id or row["lease_until"]!=lease.deadline
            or row["lease_until"]<=now or row["expires_at"]<=now):
            raise SharedSchedulerDenied("Stale, lost or expired shared lease")
        alloc=db.execute("""SELECT * FROM titan_pg_allocations
            WHERE tenant=%s AND task_id=%s FOR UPDATE""",
            (lease.tenant_id,lease.task_id)).fetchone()
        if (not alloc or alloc["worker"]!=lease.worker_id or
            alloc["fence"]!=lease.fence or alloc["deadline"]!=lease.deadline):
            raise SharedSchedulerDenied("Missing or modified shared capacity reservation")
        return row

    def renew(self,lease:SharedLease,*,now:int,lease_seconds:int=30)->SharedLease:
        self._time(now)
        if type(lease_seconds) is not int or not 1<=lease_seconds<=300:
            raise SharedSchedulerDenied("Invalid heartbeat")
        with self._tx() as db:
            row=self._locked(db,lease,now)
            deadline=min(row["expires_at"],now+lease_seconds)
            if deadline<=row["lease_until"]:
                raise SharedSchedulerDenied("Heartbeat must extend deadline")
            db.execute("""UPDATE titan_pg_jobs SET lease_until=%s WHERE tenant=%s
                AND task_id=%s""",(deadline,lease.tenant_id,lease.task_id))
            db.execute("""UPDATE titan_pg_allocations SET deadline=%s WHERE tenant=%s
                AND task_id=%s""",(deadline,lease.tenant_id,lease.task_id))
            return SharedLease(lease.tenant_id,lease.task_id,lease.task_digest,
                               lease.worker_id,lease.fence,deadline,
                               lease.attempt,lease.task)

    def finish(self,lease:SharedLease,result:dict,*,now:int)->str:
        self._time(now)
        if type(result) is not dict or type(result.get("result")) is not dict:
            raise SharedSchedulerDenied("Validated result required")
        with self._tx() as db:
            row=db.execute("""SELECT * FROM titan_pg_jobs WHERE tenant=%s
                AND task_id=%s FOR UPDATE""",(lease.tenant_id,lease.task_id)).fetchone()
            if row and row["state"]=="done" and row["fence"]==lease.fence:
                if row["result_digest"]!=result.get("digest"):
                    raise SharedSchedulerDenied("Final result is immutable")
                return "ALREADY_FINISHED_NO_NEW_EFFECT"
            row=self._locked(db,lease,now)
            task=json.loads(row["task_json"])
            if digest(task)!=lease.task_digest or task!=lease.task:
                raise SharedSchedulerDenied("Leased task binding changed")
            proof=validate_result(result["result"],task={"task":task,
                      "digest":lease.task_digest},now=now)
            if proof["digest"]!=result.get("digest"):
                raise SharedSchedulerDenied("Result digest mismatch")
            db.execute("""UPDATE titan_pg_jobs SET state='done',result_digest=%s,
                lease_owner=NULL,lease_until=NULL WHERE tenant=%s AND task_id=%s""",
                (proof["digest"],lease.tenant_id,lease.task_id))
            db.execute("""INSERT INTO titan_pg_effects
                (tenant,task_id,idem,task_digest,result_digest,fence)
                VALUES(%s,%s,%s,%s,%s,%s)""",
                (lease.tenant_id,lease.task_id,row["idem"],
                 lease.task_digest,proof["digest"],lease.fence))
            db.execute("""DELETE FROM titan_pg_allocations WHERE tenant=%s
                AND task_id=%s""",(lease.tenant_id,lease.task_id))
            return "FINISHED_ONCE_POSTGRES_LOCAL_ONLY"

    def retry(self,lease:SharedLease,*,now:int,delay_seconds:int=0)->str:
        self._time(now)
        if type(delay_seconds) is not int or not 0<=delay_seconds<=3600:
            raise SharedSchedulerDenied("Invalid retry delay")
        with self._tx() as db:
            row=self._locked(db,lease,now)
            dead=(row["attempts"]>=self.max_attempts or
                  now+delay_seconds>=row["expires_at"])
            db.execute("""UPDATE titan_pg_jobs SET state=%s,ready_at=%s,
                lease_owner=NULL,lease_until=NULL WHERE tenant=%s AND task_id=%s""",
                ("dead" if dead else "ready",now+delay_seconds,
                 lease.tenant_id,lease.task_id))
            db.execute("""DELETE FROM titan_pg_allocations WHERE tenant=%s
                AND task_id=%s""",(lease.tenant_id,lease.task_id))
            return "DEAD_POSTGRES" if dead else "RETRY_POSTGRES"

    def cancel(self,*,tenant:str,actor:str,task_id:str)->str:
        if type(tenant) is not str or not TENANT_RE.fullmatch(tenant):
            raise SharedSchedulerDenied("Authenticated tenant required")
        with self._tx() as db:
            row=db.execute("""SELECT * FROM titan_pg_jobs WHERE tenant=%s
                AND task_id=%s FOR UPDATE""",(tenant,task_id)).fetchone()
            if not row or row["actor"]!=actor:raise SharedSchedulerDenied("Unauthorized cancellation")
            if row["state"]=="done":raise SharedSchedulerDenied("Cannot cancel committed result")
            if row["state"]=="dead":return "ALREADY_DEAD"
            db.execute("""UPDATE titan_pg_jobs SET state='dead',
                lease_owner=NULL,lease_until=NULL WHERE tenant=%s AND task_id=%s""",
                (tenant,task_id))
            db.execute("""DELETE FROM titan_pg_allocations WHERE tenant=%s
                AND task_id=%s""",(tenant,task_id))
            return "CANCELLED_POSTGRES"

    def inspect(self,*,tenant:str,now:int)->dict:
        self._time(now)
        if type(tenant) is not str or not TENANT_RE.fullmatch(tenant):
            raise SharedSchedulerDenied("Explicit tenant required")
        with self._tx() as db:
            budget=db.execute("SELECT * FROM titan_pg_budgets WHERE tenant=%s",
                              (tenant,)).fetchone()
            n,cpu,mem,disk=self._usage(db,tenant)
            effects=db.execute("""SELECT COUNT(*) AS n FROM titan_pg_effects
                WHERE tenant=%s""",(tenant,)).fetchone()["n"]
            return {"tenant":tenant,"budget_configured":budget is not None,
                "inflight":n,"cpu_reserved":cpu,"memory_mb_reserved":mem,
                "disk_mb_reserved":disk,"local_recorded_effects":effects,
                "multi_host_transactions":True,
                "external_effects_authorized":False,
                "independently_accepted":False}
