"""TITAN-X07/X08/X11/X12/X13: single-transaction local admission gateway.

The older Queue.enqueue() accepts descriptive local policy evidence and is NOT
an authorization boundary. Call this gateway from verified *server-side* code
instead; it reads AccessDirectory tables atomically with each queue transition.
No IdP, real worker, network or production permission is provided.
"""
from __future__ import annotations

import json
from pathlib import Path
import sqlite3
from typing import Any, Iterable, Mapping

from .access import AccessDirectory
from .contracts import ACTOR_RE, TENANT_RE, ContractError, digest, canonical, validate_task, validate_result
from .queue import DurableLocalQueue, LocalLease, QueueDenied, _WORKER


class AdmissionDenied(QueueDenied):
    pass


class TransactionalLocalGateway:
    """Both stores MUST share the same SQLite file to avoid TOCTOU races.

    Public methods take verified server principal IDs as arguments, never
    infer identity from the client task body. This still requires an external
    authentication adapter before production use.
    """

    def __init__(self, path: str | Path, role_capabilities: Mapping[str, Iterable[str]],
                 *, max_attempts: int = 3):
        self.access = AccessDirectory(path, role_capabilities)
        self.jobs = DurableLocalQueue(path,max_attempts=max_attempts)
        with self.jobs._connection() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS local_job_admissions (
                tenant TEXT NOT NULL, task_id TEXT NOT NULL,
                member_revision INTEGER NOT NULL, task_digest TEXT NOT NULL,
                PRIMARY KEY(tenant,task_id))""")

    def _allow(self, db: sqlite3.Connection, raw: Any, *,
               tenant: str, actor: str, now: int, revision: int | None = None) -> dict:
        if (type(tenant) is not str or not TENANT_RE.fullmatch(tenant)
                or type(actor) is not str or not ACTOR_RE.fullmatch(actor)):
            raise AdmissionDenied("Untrusted server principal binding")
        self.jobs._time(now)
        member = db.execute(
            "SELECT role,active,revision FROM members WHERE tenant=? AND actor=?",
            (tenant,actor)).fetchone()
        if not member or member["active"] != 1:
            raise AdmissionDenied("No active tenant membership")
        if revision is not None and member["revision"] != revision:
            raise AdmissionDenied("Authorization revision changed since admission")
        caps = self.access.policy.get(member["role"])
        if not caps:
            raise AdmissionDenied("Role is unknown in current policy")
        if type(raw) is not dict:
            raise AdmissionDenied("Expected raw task envelope")
        cap = raw.get("capability")
        grants = db.execute(
            """SELECT scope FROM scope_grants
               WHERE tenant=? AND actor=? AND capability=? AND expires_at>?""",
            (tenant,actor,cap,now)).fetchall()
        authorized = validate_task(raw,tenant_id=tenant,actor_id=actor,
                                   allow_capabilities=set(caps),
                                   allowed_scopes={r["scope"] for r in grants},now=now)
        authorized["member_revision"] = member["revision"]
        authorized["external_execution_permitted"] = False
        return authorized

    def admit(self, envelope: dict, *, authenticated_tenant: str,
              authenticated_actor: str, now: int) -> str:
        """Secure local admission checks and job insertion share BEGIN IMMEDIATE."""
        with self.jobs._tx() as db:
            checked = self._allow(db,envelope,tenant=authenticated_tenant,
                                  actor=authenticated_actor,now=now)
            task=checked["task"]
            if now >= task["expires_at"]:
                raise AdmissionDenied("Expired task cannot be admitted")
            tenant, key, task_id=task["tenant_id"],task["idempotency_key"],task["task_id"]
            old=db.execute("SELECT task_digest,task_id FROM local_jobs WHERE tenant=? AND idem=?",
                           (tenant,key)).fetchone()
            if old:
                snapshot=db.execute(
                    "SELECT member_revision FROM local_job_admissions WHERE tenant=? AND task_id=?",
                    (tenant,old["task_id"])).fetchone()
                if (old["task_digest"]!=checked["digest"] or not snapshot or
                        snapshot["member_revision"]!=checked["member_revision"]):
                    raise AdmissionDenied("Idempotency collision or stale authorization")
                return "DUPLICATE_GUARDED_LOCAL_ONLY"
            try:
                db.execute("""INSERT INTO local_jobs
                    (tenant,idem,task_id,actor,task_digest,task_json,
                     expires_at,created_at,ready_at,state)
                    VALUES(?,?,?,?,?,?,?,?,?,'ready')""",
                    (tenant,key,task_id,task["actor_id"],checked["digest"],
                     canonical(task).decode("utf-8"),task["expires_at"],
                     now,max(now,task["issued_at"])))
            except sqlite3.IntegrityError as exc:
                raise AdmissionDenied("Duplicate task UUID under another idempotency key") from exc
            db.execute("""INSERT INTO local_job_admissions
                (tenant,task_id,member_revision,task_digest) VALUES(?,?,?,?)""",
                (tenant,task_id,checked["member_revision"],checked["digest"]))
            return "ADMITTED_GUARDED_LOCAL_ONLY"

    def _check_row(self, db: sqlite3.Connection, row: sqlite3.Row, *, now: int) -> dict:
        snapshot=db.execute(
            "SELECT member_revision,task_digest FROM local_job_admissions WHERE tenant=? AND task_id=?",
            (row["tenant"],row["task_id"])).fetchone()
        if not snapshot or snapshot["task_digest"]!=row["task_digest"]:
            raise AdmissionDenied("Missing or inconsistent admission snapshot")
        try:
            task=json.loads(row["task_json"])
        except (ValueError,TypeError) as exc:
            raise AdmissionDenied("Corrupt persisted task") from exc
        if type(task) is not dict or digest(task)!=row["task_digest"]:
            raise AdmissionDenied("Persisted task digest mismatch")
        checked=self._allow(db,task,tenant=row["tenant"],actor=row["actor"],
                            now=now,revision=snapshot["member_revision"])
        if checked["digest"]!=row["task_digest"]:
            raise AdmissionDenied("Persisted task admission mismatch")
        return checked

    def reserve(self, *, worker_id: str, now: int, lease_seconds: int = 30) -> LocalLease | None:
        self.jobs._time(now)
        if type(worker_id) is not str or not _WORKER.fullmatch(worker_id):
            raise AdmissionDenied("Invalid local worker ID")
        if type(lease_seconds) is not int or not 1 <= lease_seconds <= 300:
            raise AdmissionDenied("Invalid local lease duration")
        with self.jobs._tx() as db:
            self.jobs._recover(db,now)
            rows=db.execute("""SELECT * FROM local_jobs WHERE state='ready'
                AND ready_at<=? AND expires_at>? ORDER BY created_at,id LIMIT 100""",
                (now,now)).fetchall()
            for row in rows:
                try:
                    checked=self._check_row(db,row,now=now)
                except (AdmissionDenied,ContractError):
                    db.execute("""UPDATE local_jobs SET state='dead',
                        lease_owner=NULL,lease_until=NULL WHERE id=? AND state='ready'""",
                        (row["id"],))
                    continue
                deadline=min(row["expires_at"],now+lease_seconds)
                if deadline<=now:
                    continue
                fence=row["fence"]+1
                updated=db.execute("""UPDATE local_jobs SET state='leased',
                    attempts=attempts+1,fence=?,lease_owner=?,lease_until=?
                    WHERE id=? AND state='ready'""",
                    (fence,worker_id,deadline,row["id"])).rowcount
                if updated != 1:
                    raise AdmissionDenied("Competing local lease transition")
                return LocalLease(row["tenant"],row["task_id"],row["task_digest"],
                                  worker_id,fence,deadline,row["attempts"]+1,
                                  checked["task"])
        return None

    def renew(self, lease: LocalLease, *, now: int,
              lease_seconds: int=30) -> LocalLease:
        """Revalidate live member role/scopes before worker heartbeat."""
        self.jobs._time(now)
        with self.jobs._tx() as db:
            row=self.jobs._lease_row(db,lease)
            self.jobs._active(row,lease,now)
            authorized=self._check_row(db,row,now=now)
            if authorized['task']!=lease.task:
                raise AdmissionDenied('Lease payload not bound to current access')
            return self.jobs._renew_tx(db,lease,now=now,
                                       lease_seconds=lease_seconds)

    def finish(self, lease: LocalLease, validated_result: Mapping[str,Any], *,
               now: int) -> str:
        self.jobs._time(now)
        if not isinstance(validated_result,Mapping):
            raise AdmissionDenied("Expected validated result")
        result=validated_result.get("result")
        if type(result) is not dict or validated_result.get("digest")!=digest(result):
            raise AdmissionDenied("Result digest mismatch")
        with self.jobs._tx() as db:
            row=self.jobs._lease_row(db,lease)
            if row["state"]=="done":
                if row["result_digest"]!=validated_result["digest"]:
                    raise AdmissionDenied("Cannot rewrite completed local result")
                return "ALREADY_FINISHED_GUARDED_LOCAL_ONLY"
            self.jobs._active(row,lease,now)
            checked=self._check_row(db,row,now=now)
            if checked["task"]!=lease.task:
                raise AdmissionDenied("Lease task differs from authorization snapshot")
            accepted=validate_result(result,task=checked,now=now)
            if accepted["digest"]!=validated_result["digest"]:
                raise AdmissionDenied("Result has invalid task binding")
            updated=db.execute("""UPDATE local_jobs
                SET state='done',result_digest=?,lease_owner=NULL,lease_until=NULL
                WHERE id=? AND state='leased' AND fence=? AND lease_owner=?""",
                (accepted["digest"],row["id"],lease.fence,lease.worker_id)).rowcount
            if updated!=1:
                raise AdmissionDenied("Stale worker unable to finalize")
            return "FINISHED_GUARDED_LOCAL_ONLY"

    def recover_expired(self, *, now: int) -> dict:
        return self.jobs.recover_expired(now=now)

    def counts(self, tenant: str) -> dict:
        return self.jobs.counts(tenant)
