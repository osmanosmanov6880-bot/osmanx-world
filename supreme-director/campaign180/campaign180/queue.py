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
