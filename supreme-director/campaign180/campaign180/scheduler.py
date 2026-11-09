"""TITAN-X14/X15: SQLite multi-process local scheduling and resource admission.

Reserves CAPACITY, not physical CPU/RAM/disk. No container sandbox, runtime
resource limits, cross-host consensus, worker execution or production authority.
Multiple local processes coordinate through SQLite BEGIN IMMEDIATE leases.
"""
from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import sqlite3
from typing import Mapping, Any

from .contracts import TENANT_RE, ContractError, digest, validate_result
from .gateway import AdmissionDenied, TransactionalLocalGateway
from .queue import LocalLease, _WORKER


@dataclass(frozen=True)
class ResourceCost:
    cpu_units: int
    memory_mb: int
    disk_mb: int

    def __post_init__(self):
        for val, maximum in ((self.cpu_units, 100000), (self.memory_mb, 1048576),
                             (self.disk_mb, 1048576)):
            if type(val) is not int or val <= 0 or val > maximum:
                raise AdmissionDenied("Resource cost must be bounded positive integer")


class CapacityScheduler:
    """Fair round-robin across tenants, bounded transactional reservations.

    Trusted configuration supplies costs by capability; task.body cannot
    self-report cheaper costs. Budget management is a privileged local method,
    never an unprotected HTTP endpoint.
    """

    def __init__(self, gateway: TransactionalLocalGateway,
                 capability_costs: Mapping[str, ResourceCost], *,
                 worker_max_inflight: int=16):
        if type(gateway) is not TransactionalLocalGateway:
            raise AdmissionDenied("A transactional gateway is required")
        if not isinstance(capability_costs, Mapping) or not capability_costs:
            raise AdmissionDenied("Missing trusted capability costs")
        if any(type(k) is not str or not k or type(v) is not ResourceCost
               for k,v in capability_costs.items()):
            raise AdmissionDenied("Invalid resource cost policy")
        if type(worker_max_inflight) is not int or not 1<=worker_max_inflight<=10000:
            raise AdmissionDenied("Trusted per-worker concurrency budget required")
        self.worker_max_inflight=worker_max_inflight
        self.gateway = gateway
        self.jobs = gateway.jobs
        self.costs = dict(capability_costs)
        with self.jobs._connection() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS scheduler_budgets (
                tenant TEXT PRIMARY KEY, max_inflight INTEGER NOT NULL,
                max_cpu INTEGER NOT NULL, max_memory INTEGER NOT NULL,
                max_disk INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS scheduler_allocations (
                tenant TEXT NOT NULL, task_id TEXT NOT NULL,
                worker TEXT NOT NULL, fence INTEGER NOT NULL,
                cpu_units INTEGER NOT NULL, memory_mb INTEGER NOT NULL,
                disk_mb INTEGER NOT NULL, deadline INTEGER NOT NULL,
                PRIMARY KEY(tenant,task_id));
            CREATE TABLE IF NOT EXISTS scheduler_cursor (
                id INTEGER PRIMARY KEY CHECK(id=1), last_tenant TEXT NOT NULL);
            INSERT OR IGNORE INTO scheduler_cursor(id,last_tenant) VALUES(1,'');
            CREATE TABLE IF NOT EXISTS scheduler_backpressure(
                tenant TEXT PRIMARY KEY,max_pending INTEGER NOT NULL
                CHECK(max_pending BETWEEN 1 AND 1000000));
            CREATE TRIGGER IF NOT EXISTS scheduler_backpressure_on_admit
                BEFORE INSERT ON local_jobs
                WHEN (SELECT max_pending FROM scheduler_backpressure
                      WHERE tenant=NEW.tenant) IS NOT NULL
                AND (SELECT COUNT(*) FROM local_jobs WHERE tenant=NEW.tenant
                     AND state='ready') >=
                    (SELECT max_pending FROM scheduler_backpressure
                     WHERE tenant=NEW.tenant)
                BEGIN
                    SELECT RAISE(ABORT,'tenant queue backpressure limit exceeded');
                END;
            """)

    @staticmethod
    def _now(now: int):
        if type(now) is not int or now < 0:
            raise AdmissionDenied("Invalid epoch seconds")

    def set_budget(self, tenant: str, *, max_inflight: int, max_cpu: int,
                   max_memory: int, max_disk: int,
                   max_pending: int=1000) -> None:
        if type(tenant) is not str or not TENANT_RE.fullmatch(tenant):
            raise AdmissionDenied("Invalid tenant")
        for n in (max_inflight,max_cpu,max_memory,max_disk,max_pending):
            if type(n) is not int or not 1 <= n <= 1000000:
                raise AdmissionDenied("Invalid positive resource budget")
        with self.jobs._tx() as db:
            used=self._usage(db,tenant)
            pending=db.execute("""SELECT COUNT(*) FROM local_jobs
                WHERE tenant=? AND state='ready'""",(tenant,)).fetchone()[0]
            if (used[0]>max_inflight or used[1]>max_cpu
                or used[2]>max_memory or used[3]>max_disk
                or pending>max_pending):
                raise AdmissionDenied("Cannot shrink policy below active allocations or ready queue")
            db.execute("""INSERT INTO scheduler_backpressure(tenant,max_pending)
                VALUES(?,?) ON CONFLICT(tenant) DO UPDATE SET
                max_pending=excluded.max_pending""",(tenant,max_pending))
            db.execute("""INSERT INTO scheduler_budgets
                (tenant,max_inflight,max_cpu,max_memory,max_disk) VALUES(?,?,?,?,?)
                ON CONFLICT(tenant) DO UPDATE SET
                max_inflight=excluded.max_inflight,max_cpu=excluded.max_cpu,
                max_memory=excluded.max_memory,max_disk=excluded.max_disk""",
                (tenant,max_inflight,max_cpu,max_memory,max_disk))

    @staticmethod
    def _prune(db: sqlite3.Connection, now: int) -> None:
        db.execute("""DELETE FROM scheduler_allocations WHERE deadline<=?
            OR NOT EXISTS (SELECT 1 FROM local_jobs j
                WHERE j.tenant=scheduler_allocations.tenant
                AND j.task_id=scheduler_allocations.task_id
                AND j.state='leased'
                AND j.fence=scheduler_allocations.fence
                AND j.lease_owner=scheduler_allocations.worker
                AND j.lease_until=scheduler_allocations.deadline
                AND j.lease_until>?)""",(now,now))

    @staticmethod
    def _usage(db: sqlite3.Connection, tenant: str) -> tuple[int,int,int,int]:
        row=db.execute("""SELECT COUNT(*) n,COALESCE(SUM(cpu_units),0) cpu,
            COALESCE(SUM(memory_mb),0) mem,COALESCE(SUM(disk_mb),0) disk
            FROM scheduler_allocations WHERE tenant=?""",(tenant,)).fetchone()
        return row["n"],row["cpu"],row["mem"],row["disk"]

    def reserve(self, *, worker_id: str, now: int, lease_seconds: int=30) -> LocalLease | None:
        self._now(now)
        if type(worker_id) is not str or not _WORKER.fullmatch(worker_id):
            raise AdmissionDenied("Invalid worker ID")
        if type(lease_seconds) is not int or not 1<=lease_seconds<=300:
            raise AdmissionDenied("Invalid lease duration")
        with self.jobs._tx() as db:
            self.jobs._recover(db,now)
            self._prune(db,now)
            concurrent=db.execute("""SELECT COUNT(*) FROM scheduler_allocations
                WHERE worker=?""",(worker_id,)).fetchone()[0]
            if concurrent>=self.worker_max_inflight:
                return None
            tenants=[x[0] for x in db.execute("""SELECT DISTINCT tenant FROM local_jobs
                WHERE state='ready' AND ready_at<=? AND expires_at>?
                ORDER BY tenant""",(now,now)).fetchall()]
            if len(tenants)>1000:
                raise AdmissionDenied("Too many ready tenants for local scheduler")
            if not tenants:
                return None
            last=db.execute("SELECT last_tenant FROM scheduler_cursor WHERE id=1").fetchone()[0]
            ordered=[t for t in tenants if t>last]+[t for t in tenants if t<=last]
            for tenant in ordered:
                budget=db.execute("SELECT * FROM scheduler_budgets WHERE tenant=?",
                                  (tenant,)).fetchone()
                if budget is None:
                    continue
                used=self._usage(db,tenant)
                if used[0]>=budget["max_inflight"]:
                    continue
                # All rows are considered; a rejected row cannot starve a valid one.
                pending=db.execute("""SELECT * FROM local_jobs
                    WHERE tenant=? AND state='ready' AND ready_at<=? AND expires_at>?
                    ORDER BY created_at,id""",(tenant,now,now)).fetchall()
                for row in pending:
                    try:
                        checked=self.gateway._check_row(db,row,now=now)
                    except (AdmissionDenied,ContractError,ValueError,TypeError):
                        db.execute("UPDATE local_jobs SET state='dead' WHERE id=? AND state='ready'",
                                   (row["id"],))
                        continue
                    capability=checked["task"]["capability"]
                    cost=self.costs.get(capability)
                    if cost is None:
                        continue
                    if (used[1]+cost.cpu_units>budget["max_cpu"] or
                        used[2]+cost.memory_mb>budget["max_memory"] or
                        used[3]+cost.disk_mb>budget["max_disk"]):
                        continue
                    deadline=min(row["expires_at"],now+lease_seconds)
                    if deadline<=now:
                        continue
                    fence=row["fence"]+1
                    changed=db.execute("""UPDATE local_jobs SET state='leased',
                        attempts=attempts+1,fence=?,lease_owner=?,lease_until=?
                        WHERE id=? AND state='ready'""",
                        (fence,worker_id,deadline,row["id"])).rowcount
                    if changed!=1:
                        raise AdmissionDenied("Lost local reservation race")
                    db.execute("""INSERT INTO scheduler_allocations
                        (tenant,task_id,worker,fence,cpu_units,memory_mb,disk_mb,deadline)
                        VALUES(?,?,?,?,?,?,?,?)""",
                        (tenant,row["task_id"],worker_id,fence,cost.cpu_units,
                         cost.memory_mb,cost.disk_mb,deadline))
                    db.execute("UPDATE scheduler_cursor SET last_tenant=? WHERE id=1",
                               (tenant,))
                    return LocalLease(tenant,row["task_id"],row["task_digest"],
                                      worker_id,fence,deadline,row["attempts"]+1,
                                      checked["task"])
            return None

    def _check_allocation(self, db, lease: LocalLease, now: int):
        job=self.jobs._lease_row(db,lease)
        self.jobs._active(job,lease,now)
        alloc=db.execute("""SELECT * FROM scheduler_allocations
            WHERE tenant=? AND task_id=? AND worker=? AND fence=?""",
            (lease.tenant_id,lease.task_id,lease.worker_id,lease.fence)).fetchone()
        if not alloc or alloc["deadline"]!=lease.deadline:
            raise AdmissionDenied("No matching active capacity reservation")
        return job

    def renew(self, lease: LocalLease, *, now: int,
              lease_seconds: int=30) -> LocalLease:
        """Atomic job heartbeat + resource allocation lifetime extension.

        A stale lease, changed membership, or withdrawn grant cannot extend
        its allocation. This operation never reserves extra CPU/RAM/disk.
        """
        self._now(now)
        with self.jobs._tx() as db:
            row=self._check_allocation(db,lease,now)
            checked=self.gateway._check_row(db,row,now=now)
            if checked['task']!=lease.task:
                raise AdmissionDenied('Lease role or task changed')
            next_lease=self.jobs._renew_tx(db,lease,now=now,
                                            lease_seconds=lease_seconds)
            updated=db.execute("""UPDATE scheduler_allocations SET deadline=?
                WHERE tenant=? AND task_id=? AND worker=? AND fence=?
                AND deadline=?""",
                (next_lease.deadline,lease.tenant_id,lease.task_id,
                 lease.worker_id,lease.fence,lease.deadline)).rowcount
            if updated!=1:
                raise AdmissionDenied('Lost resource lease while heartbeat renewed')
            return next_lease

    def finish(self, lease: LocalLease, result: Mapping[str,Any], *, now: int) -> str:
        self._now(now)
        if not isinstance(result,Mapping) or type(result.get("result")) is not dict:
            raise AdmissionDenied("Expected validated ResultEnvelope")
        with self.jobs._tx() as db:
            row=self.jobs._lease_row(db,lease)
            if row["state"]=="done":
                if row["result_digest"]!=result.get("digest"):
                    raise AdmissionDenied("Final result digest is immutable")
                return "ALREADY_FINISHED_CAPACITY_LOCAL_ONLY"
            self._check_allocation(db,lease,now)
            checked=self.gateway._check_row(db,row,now=now)
            if checked["task"]!=lease.task:
                raise AdmissionDenied("Leased task differs from authenticated snapshot")
            verified=validate_result(result["result"],task=checked,now=now)
            if verified["digest"]!=result.get("digest"):
                raise AdmissionDenied("Result digest mismatch")
            changed=db.execute("""UPDATE local_jobs
                SET state='done',result_digest=?,lease_owner=NULL,lease_until=NULL
                WHERE id=? AND state='leased' AND fence=? AND lease_owner=?""",
                (verified["digest"],row["id"],lease.fence,lease.worker_id)).rowcount
            if changed!=1:
                raise AdmissionDenied("Stale capacity lease")
            db.execute("""DELETE FROM scheduler_allocations
                WHERE tenant=? AND task_id=? AND fence=?""",
                (lease.tenant_id,lease.task_id,lease.fence))
            return "FINISHED_CAPACITY_LOCAL_ONLY"

    def retry(self, lease: LocalLease, *, now: int, delay_seconds: int=0) -> str:
        self._now(now)
        if type(delay_seconds) is not int or not 0<=delay_seconds<=3600:
            raise AdmissionDenied("Invalid retry delay")
        with self.jobs._tx() as db:
            row=self._check_allocation(db,lease,now)
            dead=(row["attempts"]>=self.jobs.max_attempts
                  or now+delay_seconds>=row["expires_at"])
            changed=db.execute("""UPDATE local_jobs SET state=?,
                ready_at=?,lease_owner=NULL,lease_until=NULL
                WHERE id=? AND state='leased' AND fence=? AND lease_owner=?""",
                ("dead" if dead else "ready",now+delay_seconds,row["id"],
                 lease.fence,lease.worker_id)).rowcount
            if changed!=1:
                raise AdmissionDenied("Stale retry fence")
            db.execute("""DELETE FROM scheduler_allocations
                WHERE tenant=? AND task_id=? AND fence=?""",
                (lease.tenant_id,lease.task_id,lease.fence))
            return "DEAD_CAPACITY_LOCAL_ONLY" if dead else "RETRY_CAPACITY_LOCAL_ONLY"

    def recover(self, *, now: int) -> dict:
        self._now(now)
        with self.jobs._tx() as db:
            changed=self.jobs._recover(db,now)
            self._prune(db,now)
            return changed

    def usage(self, tenant: str, *, now: int) -> dict:
        if type(tenant) is not str or not TENANT_RE.fullmatch(tenant):
            raise AdmissionDenied("Explicit valid tenant is required")
        self._now(now)
        with self.jobs._tx() as db:
            self.jobs._recover(db,now)
            self._prune(db,now)
            n,cpu,mem,disk=self._usage(db,tenant)
            return {"tenant":tenant,"leased":n,"cpu_reserved":cpu,
                    "memory_mb_reserved":mem,"disk_mb_reserved":disk,
                    "limits_are_admission_only":True,
                    "physical_resource_enforcement":False}


    def admission_snapshot(self, tenant: str, *, now: int) -> dict:
        """Tenant-scoped current queue and actual reserved capacity."""
        if type(tenant) is not str or not TENANT_RE.fullmatch(tenant):
            raise AdmissionDenied("Explicit valid tenant required")
        self._now(now)
        with self.jobs._tx() as db:
            self.jobs._recover(db,now)
            self._prune(db,now)
            budget=db.execute("""SELECT * FROM scheduler_budgets
                WHERE tenant=?""",(tenant,)).fetchone()
            cap=db.execute("""SELECT max_pending FROM scheduler_backpressure
                WHERE tenant=?""",(tenant,)).fetchone()
            ready=db.execute("""SELECT COUNT(*) FROM local_jobs
                WHERE tenant=? AND state='ready'""",(tenant,)).fetchone()[0]
            inflight,cpu,mem,disk=self._usage(db,tenant)
            return {"tenant_id":tenant,"ready":ready,"inflight":inflight,
                    "cpu_reserved":cpu,"memory_mb_reserved":mem,"disk_mb_reserved":disk,
                    "max_pending":None if cap is None else cap["max_pending"],
                    "max_inflight":None if budget is None else budget["max_inflight"],
                    "max_cpu":None if budget is None else budget["max_cpu"],
                    "max_memory":None if budget is None else budget["max_memory"],
                    "max_disk":None if budget is None else budget["max_disk"],
                    "backpressure_enforced":cap is not None,
                    "admission_only_not_os_resource_enforcement":True}
