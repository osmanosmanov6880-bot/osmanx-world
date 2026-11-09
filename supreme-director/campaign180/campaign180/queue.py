"""TITAN-X11/X12/X13: durable local job queue, fencing and crash recovery.

This is a persistence-only integration harness. No worker adapter, network
transport, external effects, or exactly-once execution claim exists here.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import json
from pathlib import Path
import re
import sqlite3
from typing import Any, Mapping

from .contracts import ContractError, TENANT_RE, canonical, digest, validate_result

_WORKER = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$')


class QueueDenied(ContractError):
    pass


@dataclass(frozen=True)
class LocalLease:
    tenant_id: str
    task_id: str
    task_digest: str
    worker_id: str
    fence: int
    deadline: int
    attempt: int
    task: dict


class DurableLocalQueue:
    """SQLite transactional inbox. Results are recorded but not executed."""

    def __init__(self, path: str | Path, *, max_attempts: int = 3):
        if type(max_attempts) is not int or not 1 <= max_attempts <= 20:
            raise QueueDenied('Invalid retry limit')
        self.path = str(path)
        self.max_attempts = max_attempts
        with self._connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS local_jobs (
                    id INTEGER PRIMARY KEY,
                    tenant TEXT NOT NULL,
                    idem TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    task_digest TEXT NOT NULL,
                    task_json TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    ready_at INTEGER NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('ready','leased','done','dead')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    fence INTEGER NOT NULL DEFAULT 0,
                    lease_owner TEXT,
                    lease_until INTEGER,
                    result_digest TEXT,
                    UNIQUE(tenant,idem),
                    UNIQUE(tenant,task_id));
                CREATE INDEX IF NOT EXISTS local_jobs_ready
                    ON local_jobs(state,ready_at,created_at,id);
                CREATE INDEX IF NOT EXISTS local_jobs_tenant_state
                    ON local_jobs(tenant,state,ready_at);
                CREATE TABLE IF NOT EXISTS local_job_transitions(
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    tenant TEXT NOT NULL,task_id TEXT NOT NULL,
                    state TEXT NOT NULL,fence INTEGER NOT NULL,
                    lease_owner TEXT,lease_until INTEGER,result_digest TEXT,
                    source TEXT NOT NULL DEFAULT 'sqlite-trigger',
                    observed_epoch INTEGER NOT NULL DEFAULT (unixepoch()));
                CREATE INDEX IF NOT EXISTS local_job_transitions_task
                    ON local_job_transitions(tenant,task_id,seq);
                CREATE TRIGGER IF NOT EXISTS local_job_transition_create
                    AFTER INSERT ON local_jobs BEGIN
                    INSERT INTO local_job_transitions
                        (tenant,task_id,state,fence,lease_owner,lease_until,result_digest)
                    VALUES(NEW.tenant,NEW.task_id,NEW.state,NEW.fence,
                           NEW.lease_owner,NEW.lease_until,NEW.result_digest);
                END;
                CREATE TRIGGER IF NOT EXISTS local_job_transition_change
                    AFTER UPDATE OF state,fence,lease_owner,lease_until,result_digest
                    ON local_jobs
                    WHEN OLD.state!=NEW.state OR OLD.fence!=NEW.fence OR
                         OLD.lease_owner IS NOT NEW.lease_owner OR
                         OLD.lease_until IS NOT NEW.lease_until OR
                         OLD.result_digest IS NOT NEW.result_digest
                    BEGIN
                    INSERT INTO local_job_transitions
                        (tenant,task_id,state,fence,lease_owner,lease_until,result_digest)
                    VALUES(NEW.tenant,NEW.task_id,NEW.state,NEW.fence,
                           NEW.lease_owner,NEW.lease_until,NEW.result_digest);
                END;
                CREATE TABLE IF NOT EXISTS local_job_effects (
                    tenant TEXT NOT NULL,task_id TEXT NOT NULL,idem TEXT NOT NULL,
                    task_digest TEXT NOT NULL,result_digest TEXT NOT NULL,
                    fence INTEGER NOT NULL,finalized_epoch INTEGER NOT NULL
                        DEFAULT (unixepoch()),
                    PRIMARY KEY(tenant,task_id),UNIQUE(tenant,idem));
                CREATE TRIGGER IF NOT EXISTS local_effect_commit_once
                    AFTER UPDATE OF state,result_digest ON local_jobs
                    WHEN OLD.state!='done' AND NEW.state='done'
                    BEGIN
                    SELECT CASE WHEN NEW.result_digest IS NULL
                        THEN RAISE(ABORT,'finalization without validated result') END;
                    INSERT INTO local_job_effects
                        (tenant,task_id,idem,task_digest,result_digest,fence)
                    VALUES(NEW.tenant,NEW.task_id,NEW.idem,
                           NEW.task_digest,NEW.result_digest,NEW.fence);
                END;
                CREATE TRIGGER IF NOT EXISTS local_effect_immutable_update
                    BEFORE UPDATE ON local_job_effects BEGIN
                    SELECT RAISE(ABORT,'committed effect immutable');END;
                CREATE TRIGGER IF NOT EXISTS local_effect_immutable_delete
                    BEFORE DELETE ON local_job_effects BEGIN
                    SELECT RAISE(ABORT,'committed effect immutable');END;
                -- Pre-existing completed receipts are imported only from
                -- jobs whose validated result digest was already persisted.
                INSERT OR IGNORE INTO local_job_effects
                    (tenant,task_id,idem,task_digest,result_digest,fence)
                SELECT tenant,task_id,idem,task_digest,result_digest,fence
                FROM local_jobs WHERE state='done' AND result_digest IS NOT NULL;
                CREATE TRIGGER IF NOT EXISTS local_job_transition_immutable_update
                    BEFORE UPDATE ON local_job_transitions BEGIN
                    SELECT RAISE(ABORT,'local job history is append-only');END;
                CREATE TRIGGER IF NOT EXISTS local_job_transition_immutable_delete
                    BEFORE DELETE ON local_job_transitions BEGIN
                    SELECT RAISE(ABORT,'local job history is append-only');END;
                INSERT INTO local_job_transitions
                    (tenant,task_id,state,fence,lease_owner,lease_until,result_digest,source)
                SELECT j.tenant,j.task_id,j.state,j.fence,j.lease_owner,j.lease_until,
                       j.result_digest,'migration-snapshot'
                FROM local_jobs j
                WHERE NOT EXISTS(SELECT 1 FROM local_job_transitions e
                                 WHERE e.tenant=j.tenant AND e.task_id=j.task_id);
            """)

    def _connection(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path,timeout=15,isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA busy_timeout=15000')
        return db

    @contextmanager
    def _tx(self):
        db = self._connection()
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _time(now: int) -> None:
        if type(now) is not int or now < 0:
            raise QueueDenied('Expected integer epoch seconds')

    @staticmethod
    def _proof(checked: Mapping[str, Any]) -> tuple[dict, str]:
        if (not isinstance(checked, Mapping)
                or checked.get('authorization') != 'LOCAL_DIRECTORY_POLICY_ONLY'
                or checked.get('external_execution_permitted') is not False):
            raise QueueDenied('Local directory authorization evidence required')
        task = checked.get('task')
        if type(task) is not dict or checked.get('digest') != digest(task):
            raise QueueDenied('Task mutated since local authorization')
        if type(task.get('expires_at')) is not int:
            raise QueueDenied('Task expiry missing')
        return task,checked['digest']

    def enqueue(self, authorized: Mapping[str,Any], *, now: int) -> str:
        self._time(now)
        task, task_digest = self._proof(authorized)
        if now >= task['expires_at']:
            raise QueueDenied('Cannot queue expired local task')
        tenant, idem = task['tenant_id'], task['idempotency_key']
        with self._tx() as db:
            current = db.execute('SELECT task_digest FROM local_jobs WHERE tenant=? AND idem=?',
                                 (tenant,idem)).fetchone()
            if current:
                if current['task_digest'] != task_digest:
                    raise QueueDenied('Idempotency key reused with different task')
                return 'DUPLICATE_LOCAL_ONLY'
            try:
                db.execute("""INSERT INTO local_jobs
                    (tenant,idem,task_id,actor,task_digest,task_json,
                     expires_at,created_at,ready_at,state)
                    VALUES(?,?,?,?,?,?,?,?,?,'ready')""",
                    (tenant,idem,task['task_id'],task['actor_id'],task_digest,
                     canonical(task).decode('utf-8'),task['expires_at'],
                     now,max(now,task['issued_at'])))
            except sqlite3.IntegrityError as exc:
                raise QueueDenied('Task identity already associated with another local job') from exc
        return 'QUEUED_LOCAL_ONLY'

    def _recover(self, db: sqlite3.Connection, now: int) -> dict:
        expired = db.execute("""UPDATE local_jobs
            SET state='dead',lease_owner=NULL,lease_until=NULL
            WHERE state IN ('ready','leased') AND expires_at<=?""",(now,)).rowcount
        exhausted = db.execute("""UPDATE local_jobs
            SET state='dead',lease_owner=NULL,lease_until=NULL
            WHERE state='leased' AND lease_until<=? AND attempts>=?""",
            (now,self.max_attempts)).rowcount
        retried = db.execute("""UPDATE local_jobs
            SET state='ready',ready_at=?,lease_owner=NULL,lease_until=NULL
            WHERE state='leased' AND lease_until<=? AND attempts<? AND expires_at>?""",
            (now,now,self.max_attempts,now)).rowcount
        return {'requeued':retried,'dead':expired+exhausted}

    def recover_expired(self, *, now: int) -> dict:
        """Only expired leases are touched; active workers remain unaffected."""
        self._time(now)
        with self._tx() as db:
            return self._recover(db,now)

    def reserve(self, *, worker_id: str, now: int, lease_seconds: int = 30) -> LocalLease | None:
        self._time(now)
        if type(worker_id) is not str or not _WORKER.fullmatch(worker_id):
            raise QueueDenied('Invalid worker id')
        if type(lease_seconds) is not int or not 1 <= lease_seconds <= 300:
            raise QueueDenied('Invalid lease duration')
        with self._tx() as db:
            self._recover(db,now)
            row = db.execute("""SELECT * FROM local_jobs
                WHERE state='ready' AND ready_at<=? AND expires_at>?
                ORDER BY created_at,id LIMIT 1""",(now,now)).fetchone()
            if row is None:
                return None
            body = json.loads(row['task_json'])
            if digest(body) != row['task_digest']:
                raise QueueDenied('Persisted payload integrity violation')
            deadline = min(now+lease_seconds,row['expires_at'])
            if deadline <= now:
                return None
            fence = row['fence']+1
            updated = db.execute("""UPDATE local_jobs
                SET state='leased',attempts=attempts+1,
                    fence=?,lease_owner=?,lease_until=?
                WHERE id=? AND state='ready'""",
                (fence,worker_id,deadline,row['id'])).rowcount
            if updated != 1:
                raise QueueDenied('Concurrent lease transition rejected')
            return LocalLease(row['tenant'],row['task_id'],row['task_digest'],
                              worker_id,fence,deadline,row['attempts']+1,body)

    @staticmethod
    def _lease_row(db: sqlite3.Connection, lease: LocalLease) -> sqlite3.Row:
        if type(lease) is not LocalLease:
            raise QueueDenied('Expected immutable lease receipt')
        row = db.execute('SELECT * FROM local_jobs WHERE tenant=? AND task_id=?',
                         (lease.tenant_id,lease.task_id)).fetchone()
        if row is None or row['fence'] != lease.fence or row['task_digest'] != lease.task_digest:
            raise QueueDenied('Stale or unknown lease fence')
        return row

    @staticmethod
    def _active(row: sqlite3.Row, lease: LocalLease, now: int) -> None:
        if (row['state']!='leased' or row['lease_owner']!=lease.worker_id
                or row['lease_until']!=lease.deadline or row['lease_until']<=now
                or row['expires_at']<=now):
            raise QueueDenied('Expired, stolen or inactive lease')

    def _renew_tx(self, db: sqlite3.Connection, lease: LocalLease, *,
                  now: int, lease_seconds: int) -> LocalLease:
        """CAS rotation of deadline: superseded lease receipts become invalid."""
        self._time(now)
        if type(lease_seconds) is not int or not 1<=lease_seconds<=300:
            raise QueueDenied('Bounded heartbeat extension required')
        row=self._lease_row(db,lease)
        self._active(row,lease,now)
        proposed=min(row['expires_at'],now+lease_seconds)
        if proposed<=row['lease_until']:
            raise QueueDenied('Lease heartbeat must advance deadline')
        updated=db.execute("""UPDATE local_jobs SET lease_until=?
            WHERE tenant=? AND task_id=? AND state='leased'
            AND fence=? AND lease_owner=? AND lease_until=?""",
            (proposed,lease.tenant_id,lease.task_id,lease.fence,
             lease.worker_id,lease.deadline)).rowcount
        if updated!=1:
            raise QueueDenied('Heartbeat lost a competing lease transition')
        return LocalLease(lease.tenant_id,lease.task_id,lease.task_digest,
                          lease.worker_id,lease.fence,proposed,
                          lease.attempt,lease.task)

    def renew(self, lease: LocalLease, *, now: int,
              lease_seconds: int=30) -> LocalLease:
        """Crash-safe heartbeat for existing LOCAL leases only."""
        with self._tx() as db:
            return self._renew_tx(db,lease,now=now,lease_seconds=lease_seconds)

    def record_result(self, lease: LocalLease, validated_result: Mapping[str,Any],
                      *, now: int) -> str:
        """CAS finalization; no worker code or external side effect is invoked."""
        self._time(now)
        if not isinstance(validated_result,Mapping):
            raise QueueDenied('Validated result object required')
        raw = validated_result.get('result')
        if type(raw) is not dict or validated_result.get('digest')!=digest(raw):
            raise QueueDenied('Tampered result evidence')
        with self._tx() as db:
            row = self._lease_row(db,lease)
            if row['state']=='done':
                if row['result_digest'] != validated_result['digest']:
                    raise QueueDenied('Cannot replace finalized result')
                return 'ALREADY_RECORDED_LOCAL_ONLY'
            self._active(row,lease,now)
            task = json.loads(row['task_json'])
            if digest(task) != row['task_digest'] or task != lease.task:
                raise QueueDenied('Stored task differs from leased task')
            checked = validate_result(raw,task={'task':task,'digest':row['task_digest']},now=now)
            if checked['digest'] != validated_result['digest']:
                raise QueueDenied('Unbound or altered local result')
            count = db.execute("""UPDATE local_jobs
                SET state='done',result_digest=?,lease_owner=NULL,lease_until=NULL
                WHERE id=? AND state='leased' AND fence=? AND lease_owner=?""",
                (checked['digest'],row['id'],lease.fence,lease.worker_id)).rowcount
            if count != 1:
                raise QueueDenied('Lost fence while finalizing')
            return 'RESULT_RECORDED_LOCAL_ONLY'

    def retry(self, lease: LocalLease, *, now: int, delay_seconds: int) -> str:
        """Bounded retry; does not notify any external worker or transport."""
        self._time(now)
        if type(delay_seconds) is not int or not 0 <= delay_seconds <= 3600:
            raise QueueDenied('Invalid retry delay')
        with self._tx() as db:
            row = self._lease_row(db,lease)
            self._active(row,lease,now)
            dead = row['attempts']>=self.max_attempts or now+delay_seconds>=row['expires_at']
            db.execute("""UPDATE local_jobs
                SET state=?,ready_at=?,lease_owner=NULL,lease_until=NULL
                WHERE id=? AND state='leased' AND fence=?""",
                ('dead' if dead else 'ready',now+delay_seconds,row['id'],lease.fence))
            return 'DEAD_LOCAL_ONLY' if dead else 'RETRY_SCHEDULED_LOCAL_ONLY'

    def verify_durability(self, *, tenant_id: str) -> dict:
        """X11: check persisted job/lease/transition consistency atomically.

        Read-only SQLite transaction: detects a missing/corrupt final transition,
        leases without owners, a job/receipt mismatch and duplicate transitions.
        This is a LOCAL SQLite durability proof, not multi-server consensus.
        """
        if type(tenant_id) is not str or not TENANT_RE.fullmatch(tenant_id):
            raise QueueDenied("Exact tenant required")
        with self._tx() as db:
            if db.execute("PRAGMA quick_check").fetchone()[0]!="ok":
                raise QueueDenied("SQLite integrity check failed")
            rows=db.execute("""SELECT * FROM local_jobs WHERE tenant=?
                ORDER BY id""",(tenant_id,)).fetchall()
            if len(rows)>20000:
                raise QueueDenied("Durability audit exceeds bounded job count")
            completed=0
            for row in rows:
                try:
                    task=json.loads(row["task_json"])
                except (TypeError,ValueError) as exc:
                    raise QueueDenied("Persisted task JSON malformed") from exc
                if (type(task) is not dict or digest(task)!=row["task_digest"]
                    or task.get("task_id")!=row["task_id"]
                    or task.get("tenant_id")!=tenant_id
                    or task.get("idempotency_key")!=row["idem"]):
                    raise QueueDenied("Persisted task identity or digest changed")
                event=db.execute("""SELECT state,fence,lease_owner,lease_until,
                    result_digest FROM local_job_transitions
                    WHERE tenant=? AND task_id=? ORDER BY seq DESC LIMIT 1""",
                    (tenant_id,row["task_id"])).fetchone()
                if event is None or any(event[k]!=row[k] for k in (
                    "state","fence","lease_owner","lease_until","result_digest")):
                    raise QueueDenied("Durable state is missing final transition")
                if row["state"]=="leased":
                    if (not row["lease_owner"] or row["lease_until"] is None
                        or row["attempts"]<=0 or row["fence"]<=0):
                        raise QueueDenied("Leased job is missing fencing metadata")
                elif row["lease_owner"] is not None or row["lease_until"] is not None:
                    raise QueueDenied("Non-leased job carries stale worker ownership")
                receipt=db.execute("""SELECT * FROM local_job_effects
                    WHERE tenant=? AND task_id=?""",
                    (tenant_id,row["task_id"])).fetchone()
                if row["state"]=="done":
                    completed+=1
                    if (receipt is None or receipt["idem"]!=row["idem"] or
                        receipt["task_digest"]!=row["task_digest"] or
                        receipt["result_digest"]!=row["result_digest"] or
                        receipt["fence"]!=row["fence"]):
                        raise QueueDenied("Committed effect receipt missing or inconsistent")
                elif receipt is not None:
                    raise QueueDenied("Unexpected receipt on unfinished job")
            extra=db.execute("""SELECT COUNT(*) FROM local_job_effects e
                LEFT JOIN local_jobs j ON j.tenant=e.tenant AND j.task_id=e.task_id
                WHERE e.tenant=? AND j.task_id IS NULL""",(tenant_id,)).fetchone()[0]
            if extra:
                raise QueueDenied("Orphaned durable effect receipt")
            return {"schema":"osgard.titan-x11.durable-queue-audit/1",
                "tenant_id":tenant_id,"jobs_verified":len(rows),
                "receipts_verified":completed,"sqlite_quick_check":"ok",
                "transition_consistent":True,"external_workers_verified":False,
                "independently_accepted":False}

    def counts(self, tenant_id: str) -> dict:
        if type(tenant_id) is not str or not TENANT_RE.fullmatch(tenant_id):
            raise QueueDenied('Explicit tenant required for diagnostics')
        db = self._connection()
        try:
            rows = db.execute('SELECT state,COUNT(*) AS n FROM local_jobs WHERE tenant=? GROUP BY state',
                              (tenant_id,)).fetchall()
            result={'ready':0,'leased':0,'done':0,'dead':0}
            result.update({r['state']:r['n'] for r in rows})
            return result
        finally:
            db.close()


    def cancel(self, *, tenant_id: str, task_id: str, actor_id: str,
               now: int) -> str:
        """Tenant+originator scoped durable cancellation, never deletion."""
        self._time(now)
        if (type(tenant_id) is not str or not TENANT_RE.fullmatch(tenant_id)
            or type(task_id) is not str or type(actor_id) is not str):
            raise QueueDenied('Explicit authenticated cancel identifiers required')
        with self._tx() as db:
            row=db.execute("""SELECT actor,state FROM local_jobs
                WHERE tenant=? AND task_id=?""",(tenant_id,task_id)).fetchone()
            if row is None or row['actor']!=actor_id:
                raise QueueDenied('Cancellation not authorized')
            if row['state']=='done':
                raise QueueDenied('Finalized task cannot be cancelled')
            if row['state']=='dead':
                return 'ALREADY_CANCELLED_OR_DEAD_LOCAL_ONLY'
            n=db.execute("""UPDATE local_jobs SET state='dead',
                lease_owner=NULL,lease_until=NULL WHERE tenant=?
                AND task_id=? AND state IN ('ready','leased')""",
                (tenant_id,task_id)).rowcount
            if n!=1:raise QueueDenied('Concurrent cancellation refused')
            return 'CANCELLED_LOCAL_ONLY'

    def dead_letters(self, *, tenant_id: str, limit: int=100) -> list[dict]:
        """No raw task body: only metadata scoped to the given tenant."""
        if type(tenant_id) is not str or not TENANT_RE.fullmatch(tenant_id):
            raise QueueDenied('Explicit valid tenant required')
        if type(limit) is not int or not 1<=limit<=200:
            raise QueueDenied('Bounded dead-letter result required')
        db=self._connection()
        try:
            rows=db.execute("""SELECT task_id,attempts,fence,created_at,expires_at
                FROM local_jobs WHERE tenant=? AND state='dead'
                ORDER BY id DESC LIMIT ?""",(tenant_id,limit)).fetchall()
            return [dict(x) for x in rows]
        finally:
            db.close()

    def transitions(self, *, tenant_id: str, task_id: str,
                    limit: int=100) -> list[dict]:
        """Append-only ledger works across Queue/Gateway/Scheduler paths."""
        if type(tenant_id) is not str or not TENANT_RE.fullmatch(tenant_id):
            raise QueueDenied('Tenant required for history')
        if type(task_id) is not str or not task_id:
            raise QueueDenied('Task required for history')
        if type(limit) is not int or not 1<=limit<=200:
            raise QueueDenied('Bounded history requested')
        db=self._connection()
        try:
            rows=db.execute("""SELECT seq,state,fence,lease_owner,lease_until,
                result_digest,source,observed_epoch FROM local_job_transitions
                WHERE tenant=? AND task_id=? ORDER BY seq LIMIT ?""",
                (tenant_id,task_id,limit)).fetchall()
            return [dict(x) for x in rows]
        finally:
            db.close()


    def effect_receipt(self, *, tenant_id: str, task_id: str) -> dict | None:
        """One immutable LOCAL recorded effect, not external exactly-once work."""
        if type(tenant_id) is not str or not TENANT_RE.fullmatch(tenant_id):
            raise QueueDenied('Tenant required for effect receipt')
        if type(task_id) is not str or not task_id:
            raise QueueDenied('Task required for effect receipt')
        db=self._connection()
        try:
            row=db.execute("""SELECT e.task_digest,e.result_digest,e.fence,
                e.finalized_epoch FROM local_job_effects e
                JOIN local_jobs j ON j.tenant=e.tenant AND j.task_id=e.task_id
                WHERE e.tenant=? AND e.task_id=? AND j.state='done'
                AND j.result_digest=e.result_digest AND j.task_digest=e.task_digest""",
                (tenant_id,task_id)).fetchone()
            return None if row is None else {
                **dict(row),"task_id":task_id,
                "recorded_once_in_sqlite":True,
                "external_effect_executed":False}
        finally:
            db.close()

    def verify_effect_ledger(self, *, tenant_id: str) -> dict:
        """Detect missing, extra or inconsistent receipts with one DB snapshot."""
        if type(tenant_id) is not str or not TENANT_RE.fullmatch(tenant_id):
            raise QueueDenied('Tenant required for effect verification')
        with self._tx() as db:
            unmatched=db.execute("""SELECT COUNT(*) FROM local_jobs j
                LEFT JOIN local_job_effects e ON e.tenant=j.tenant
                    AND e.task_id=j.task_id WHERE j.tenant=? AND j.state='done'
                AND (e.task_id IS NULL OR e.idem!=j.idem OR
                     e.task_digest!=j.task_digest OR
                     e.result_digest!=j.result_digest OR e.fence!=j.fence)""",
                (tenant_id,)).fetchone()[0]
            phantom=db.execute("""SELECT COUNT(*) FROM local_job_effects e
                LEFT JOIN local_jobs j ON j.tenant=e.tenant AND j.task_id=e.task_id
                WHERE e.tenant=? AND (j.task_id IS NULL OR j.state!='done')""",
                (tenant_id,)).fetchone()[0]
            if unmatched or phantom:
                raise QueueDenied('Exactly-once local receipt ledger corrupted')
            total=db.execute("""SELECT COUNT(*) FROM local_job_effects
                WHERE tenant=?""",(tenant_id,)).fetchone()[0]
            return {"tenant_id":tenant_id,"recorded_local_effects":total,
                    "no_missing_or_phantom_receipts":True,
                    "external_exactly_once_proven":False,
                    "independent_acceptance":False}
