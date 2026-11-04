"""M190: local, append-only, crash-consistent observation ledger for M189.

Records do not grant acceptance, change GitHub state or enable production.
A SHA-256 chain detects changes relative to an externally retained head hash;
without an external head it is NOT resistant to a privileged full rewrite.
"""
from __future__ import annotations

from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any
from urllib.parse import quote
import json
import os
import re
import sqlite3
import tempfile

MASTER_SHA = '71fdda8231e1cb627a36fa683eaab1c28e4bdff2da9c95e0e6f6df83624a4b6c'
TEAMS = ('TITAN', 'NEXUS', 'COMMERCE', 'EXPERIENCE', 'GENESIS', 'ORBITAL')
TASK_IDS = frozenset(f'{team}-X{n:02}' for team in TEAMS for n in range(1, 31))
STATUS = frozenset({'BLOCKED_UPSTREAM', 'AWAITING_EVIDENCE', 'EVIDENCE_REJECTED',
                    'BLOCKED_DEPENDENCY', 'READY_FOR_EXTERNAL_REVIEW'})
GENESIS = '0' * 64
FORMAT = 'osgard.m190.local-observation-ledger/1'
EVENT_FORMAT = 'osgard.m190.ledger-event/1'
HEX_SHA = re.compile(r'[0-9a-f]{64}\Z')
ACTOR = re.compile(r'[a-zA-Z0-9_.-]{3,48}\Z')


class LedgerError(ValueError):
    """Invalid history, input or concurrency precondition."""


def require(ok: bool, explanation: str) -> None:
    if not ok:
        raise LedgerError(explanation)


def canonical(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
                      allow_nan=False).encode('utf-8')


def digest(obj: Any) -> str:
    return sha256(canonical(obj)).hexdigest()


def check_sha(value: Any, label: str = 'SHA-256') -> None:
    require(isinstance(value, str) and bool(HEX_SHA.fullmatch(value)),
            f'{label} must be lowercase hexadecimal SHA-256')


def check_actor(actor: Any) -> None:
    require(isinstance(actor, str) and bool(ACTOR.fullmatch(actor)),
            'actor must be 3-48 ASCII characters: letters, digits, dot, dash, underscore')


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def read_plan(path: Path) -> tuple[dict, str]:
    raw = path.read_bytes()
    data = json.loads(raw)
    require(isinstance(data, dict) and data.get('schema') == 'osgard.original-180-oct17.recovered/1',
            'invalid original plan schema')
    require(data.get('original_master_sha256') == MASTER_SHA,
            'original master provenance mismatch')
    require(data.get('original_task_acceptance') == 0 and data.get('production') == 'NO_GO',
            'plan claims unverified original acceptance or production')
    tasks = data.get('tasks')
    require(isinstance(tasks, list) and len(tasks) == 180, 'plan needs exactly 180 tasks')
    by_id: dict[str, dict] = {}
    for t in tasks:
        require(isinstance(t, dict), 'invalid plan task')
        tid = t.get('id')
        require(isinstance(tid, str) and tid in TASK_IDS and tid not in by_id,
                'unknown or duplicated task ID in original plan')
        require(t.get('team') == tid.split('-')[0], 'plan task team mismatch')
        require(t.get('priority') in ('P0', 'P1', 'P2'), 'plan priority invalid')
        deps = t.get('explicit_deps')
        require(isinstance(deps, list) and len(deps) == len(set(deps)) and
                all(isinstance(d, str) and d in TASK_IDS and d != tid for d in deps),
                'invalid plan dependency')
        by_id[tid] = t
    require(set(by_id) == TASK_IDS, 'plan is missing task identifiers')
    return by_id, sha256(raw).hexdigest()


def sanitized_report(report: Any, by_id: dict[str, dict]) -> dict:
    require(isinstance(report, dict) and report.get('schema') == 'osgard.m189.admission-report/1',
            'expected a real M189 admission report')
    require(report.get('original_task_acceptance') == 0 and
            report.get('verified_production_upstreams') == 0 and
            report.get('release_gate') == 'NO_GO' and
            report.get('production_authorized') is False,
            'M189 report claims original acceptance or production permission')
    rows = report.get('tasks')
    require(isinstance(rows, list) and len(rows) == 180, 'M189 report must contain 180 tasks')
    states: dict[str, str] = {}
    for row in rows:
        require(isinstance(row, dict), 'M189 task row invalid')
        tid = row.get('id')
        require(isinstance(tid, str) and tid in by_id and tid not in states,
                'M189 report has unknown or duplicate task')
        reference = by_id[tid]
        require(row.get('team') == reference['team'] and
                row.get('priority') == reference['priority'] and
                row.get('depends_on') == reference['explicit_deps'],
                'M189 task metadata/dependency mismatch: ' + tid)
        status = row.get('status')
        require(isinstance(status, str) and status in STATUS,
                'unrecognized M189 status or fabricated VERIFIED')
        states[tid] = status
    require(set(states) == TASK_IDS, 'M189 report incomplete')
    counts = dict(sorted(Counter(states.values()).items()))
    require(report.get('statuses') == counts, 'M189 status tally does not match tasks')
    require(type(report.get('signed_local_evidence_ready')) is int and
            report['signed_local_evidence_ready'] == counts.get('READY_FOR_EXTERNAL_REVIEW', 0),
            'M189 ready-for-review count mismatch')
    # Do not trust metadata status as an indication of independent acceptance.
    return {'statuses': dict(sorted(states.items())), 'counts': counts,
            'task_count': 180, 'source_schema': 'osgard.m189.admission-report/1'}


def _connect(db: Path, *, readonly: bool) -> sqlite3.Connection:
    db = Path(db)
    require(db.is_file() and not db.is_symlink(), 'database not found or is a symlink; call init')
    uri = 'file:' + quote(str(db.absolute()), safe='/') + ('?mode=ro' if readonly else '?mode=rw')
    connection = sqlite3.connect(uri, uri=True, isolation_level=None, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA busy_timeout=5000')
    if not readonly:
        connection.execute('PRAGMA synchronous=FULL')
    return connection


def create(db: Path, plan: Path) -> dict:
    _, plan_sha = read_plan(Path(plan))
    db = Path(db)
    db.parent.mkdir(parents=True, exist_ok=True)
    require(not db.exists() and not db.is_symlink(), 'database already exists: refusing overwrite')
    connection = sqlite3.connect(str(db), isolation_level=None, timeout=5)
    try:
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('PRAGMA synchronous=FULL')
        connection.execute('BEGIN IMMEDIATE')
        connection.executescript('''
          CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE events (
            seq INTEGER PRIMARY KEY CHECK (seq >= 1),
            prev_hash TEXT NOT NULL,
            event_hash TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            actor TEXT NOT NULL,
            timestamp_utc TEXT NOT NULL,
            payload_json TEXT NOT NULL
          );
          CREATE TRIGGER immutable_events_update BEFORE UPDATE ON events
            BEGIN SELECT RAISE(ABORT, 'event history is immutable'); END;
          CREATE TRIGGER immutable_events_delete BEFORE DELETE ON events
            BEGIN SELECT RAISE(ABORT, 'event history is immutable'); END;
          CREATE TRIGGER immutable_metadata_update BEFORE UPDATE ON metadata
            BEGIN SELECT RAISE(ABORT, 'metadata is immutable'); END;
          CREATE TRIGGER immutable_metadata_delete BEFORE DELETE ON metadata
            BEGIN SELECT RAISE(ABORT, 'metadata is immutable'); END;
        ''')
        # executescript commits its own transactions; initialization must still be verified.
        connection.execute('BEGIN IMMEDIATE')
        connection.executemany('INSERT INTO metadata(key,value) VALUES (?,?)', [
            ('schema', FORMAT), ('master_sha256', MASTER_SHA), ('plan_sha256', plan_sha),
            ('created_utc', utcnow()),
        ])
        connection.execute('COMMIT')
        return verify(db)
    except BaseException:
        connection.close()
        if db.exists():
            db.unlink()
        raise
    finally:
        try:
            connection.close()
        except Exception:
            pass


def event_hash(event: dict) -> str:
    return digest(event)


def _event(seq: int, prev: str, kind: str, actor: str, timestamp: str, payload: dict) -> dict:
    return {'schema': EVENT_FORMAT, 'seq': seq, 'previous_hash': prev, 'kind': kind,
            'actor': actor, 'timestamp_utc': timestamp, 'payload': payload}


def _read(conn: sqlite3.Connection, expected_head: str | None = None) -> dict:
    if expected_head is not None:
        check_sha(expected_head, 'expected head')
    check = conn.execute('PRAGMA quick_check').fetchone()
    require(check and check[0] == 'ok', 'SQLite quick_check failed')
    meta = {row['key']: row['value'] for row in conn.execute('SELECT key,value FROM metadata')}
    require(set(meta) == {'schema', 'master_sha256', 'plan_sha256', 'created_utc'} and
            meta['schema'] == FORMAT and meta['master_sha256'] == MASTER_SHA,
            'database metadata malformed or provenance changed')
    check_sha(meta['plan_sha256'], 'stored plan SHA')
    triggers = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
    require({'immutable_events_update','immutable_events_delete',
             'immutable_metadata_update','immutable_metadata_delete'}.issubset(triggers),
            'append-only protection triggers missing')
    current = GENESIS
    last_states: dict[str, str] = {}
    notes = 0
    report_digests: set[str] = set()
    rows = conn.execute('SELECT * FROM events ORDER BY seq').fetchall()
    for n, row in enumerate(rows, start=1):
        require(row['seq'] == n and row['prev_hash'] == current,
                'sequence gap, truncation or previous hash mismatch at event ' + str(n))
        check_sha(row['event_hash'], 'event hash')
        require(row['kind'] in ('REPORT_OBSERVED', 'NOTE_ADDED'), 'unknown event kind')
        check_actor(row['actor'])
        timestamp = datetime.fromisoformat(row['timestamp_utc'])
        require(timestamp.tzinfo is not None and timestamp.utcoffset().total_seconds() == 0,
                'event timestamp must be in UTC')
        payload = json.loads(row['payload_json'])
        require(isinstance(payload, dict) and row['payload_json'] == canonical(payload).decode('utf-8'),
                'event payload is not canonical JSON')
        obj = _event(n, current, row['kind'], row['actor'], row['timestamp_utc'], payload)
        require(event_hash(obj) == row['event_hash'], 'event hash mismatch at ' + str(n))
        if row['kind'] == 'REPORT_OBSERVED':
            require(set(payload) == {'report_sha256', 'plan_sha256', 'statuses',
                                    'counts', 'task_count', 'source_schema'}, 'report payload malformed')
            check_sha(payload['report_sha256'], 'report digest')
            require(payload['plan_sha256'] == meta['plan_sha256'], 'report plan digest mismatch')
            require(payload['task_count'] == 180 and
                    payload['source_schema'] == 'osgard.m189.admission-report/1',
                    'report schema/count mismatch')
            statuses = payload['statuses']
            require(isinstance(statuses, dict) and set(statuses) == TASK_IDS and
                    all(s in STATUS for s in statuses.values()), 'invalid report task statuses')
            require(payload['counts'] == dict(sorted(Counter(statuses.values()).items())),
                    'report status counters mismatch')
            require(payload['report_sha256'] not in report_digests, 'duplicate report record')
            report_digests.add(payload['report_sha256'])
            last_states = statuses
        else:
            require(set(payload) == {'task_id', 'message', 'reference_sha256'}, 'note payload malformed')
            require(payload['task_id'] in TASK_IDS, 'invalid note task')
            message = payload['message']
            require(isinstance(message, str) and 1 <= len(message) <= 1200 and
                    all(ord(char) >= 32 or char == '\n' for char in message),
                    'invalid note content')
            ref = payload['reference_sha256']
            if ref is not None:
                check_sha(ref, 'note reference')
            notes += 1
        current = row['event_hash']
    if expected_head is not None:
        require(current == expected_head, 'EXTERNAL_HEAD_MISMATCH: history changed since anchor')
    return {'schema': FORMAT, 'events': len(rows), 'head': current,
            'plan_sha256': meta['plan_sha256'], 'last_report_statuses': last_states,
            'status_counts': dict(sorted(Counter(last_states.values()).items())),
            'unique_reports': len(report_digests), 'notes': notes,
            'original_task_acceptance': 0, 'production_authorized': False,
            'release_gate': 'NO_GO',
            'external_anchor_checked': expected_head is not None,
            'warning': 'SHA-256 chain requires an independently stored head to detect privileged whole-file rollback.'}


def verify(db: Path, *, expected_head: str | None = None) -> dict:
    with closing(_connect(db, readonly=True)) as conn:
        return _read(conn, expected_head)


def _append(db: Path, kind: str, actor: str, payload: dict, expected_head: str) -> dict:
    check_actor(actor)
    check_sha(expected_head, 'write precondition head')
    conn = _connect(db, readonly=False)
    try:
        conn.execute('BEGIN IMMEDIATE')
        previous = _read(conn)
        require(previous['head'] == expected_head,
                'STALE_HEAD: another event or rewrite changed the chain')
        if kind == 'REPORT_OBSERVED' and conn.execute(
            "SELECT 1 FROM events WHERE kind='REPORT_OBSERVED' AND json_extract(payload_json, '$.report_sha256')=?",
            (payload['report_sha256'],)
        ).fetchone():
            conn.execute('COMMIT')
            return {**previous, 'appended': False}
        seq = previous['events'] + 1
        timestamp = utcnow()
        event = _event(seq, previous['head'], kind, actor, timestamp, payload)
        head = event_hash(event)
        conn.execute('''INSERT INTO events(seq,prev_hash,event_hash,kind,actor,timestamp_utc,payload_json)
                        VALUES (?,?,?,?,?,?,?)''',
                     (seq, previous['head'], head, kind, actor, timestamp,
                      canonical(payload).decode('utf-8')))
        conn.execute('COMMIT')
    except BaseException:
        if conn.in_transaction:
            conn.execute('ROLLBACK')
        raise
    finally:
        conn.close()
    return {**verify(db, expected_head=head), 'appended': True}


def ingest(db: Path, *, plan_path: Path, report_path: Path,
           actor: str, expected_head: str) -> dict:
    by_id, plan_sha = read_plan(Path(plan_path))
    raw = Path(report_path).read_bytes()
    report = json.loads(raw)
    safe = sanitized_report(report, by_id)
    current = verify(db)
    require(plan_sha == current['plan_sha256'], 'plan bytes drifted after ledger initialization')
    payload = {**safe, 'report_sha256': sha256(raw).hexdigest(),
               'plan_sha256': plan_sha}
    return _append(db, 'REPORT_OBSERVED', actor, payload, expected_head)


def add_note(db: Path, *, task_id: str, message: str, actor: str,
             expected_head: str, reference_sha256: str | None = None) -> dict:
    require(task_id in TASK_IDS, 'unknown task ID')
    require(isinstance(message, str) and 1 <= len(message) <= 1200 and
            all(ord(char) >= 32 or char == '\n' for char in message),
            'note must contain 1-1200 printable characters; no control characters')
    if reference_sha256 is not None:
        check_sha(reference_sha256, 'note evidence reference')
    return _append(db, 'NOTE_ADDED', actor,
                   {'task_id': task_id, 'message': message,
                    'reference_sha256': reference_sha256}, expected_head)


def export_events(db: Path, *, expected_head: str | None = None) -> dict:
    summary = verify(db, expected_head=expected_head)
    with closing(_connect(db, readonly=True)) as conn:
        rows = conn.execute('SELECT * FROM events ORDER BY seq').fetchall()
        events = []
        for row in rows:
            obj = _event(row['seq'], row['prev_hash'], row['kind'], row['actor'],
                         row['timestamp_utc'], json.loads(row['payload_json']))
            obj['event_hash'] = row['event_hash']
            events.append(obj)
    return {'schema': 'osgard.m190.ledger-export/1', 'summary': summary,
            'events': events, 'no_external_actions': True}


def write_json_atomic(path: Path, data: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    require(not path.is_symlink(), 'refusing output symlink')
    raw = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False).encode('utf-8') + b'\n'
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
        if hasattr(os, 'O_DIRECTORY'):
            parent_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def write_anchor(db: Path, output: Path, *, expected_head: str | None = None) -> dict:
    summary = verify(db, expected_head=expected_head)
    result = {'schema': 'osgard.m190.external-head-anchor/1',
              'head': summary['head'], 'event_count': summary['events'],
              'plan_sha256': summary['plan_sha256'], 'created_utc': utcnow(),
              'release_gate': 'NO_GO', 'production_authorized': False,
              'warning': 'Store this anchor independently of the database; local self-storage is not trusted evidence.'}
    write_json_atomic(output, result)
    return result


def verify_anchor(db: Path, anchor_path: Path) -> dict:
    anchor = json.loads(Path(anchor_path).read_text(encoding='utf-8'))
    require(isinstance(anchor, dict) and anchor.get('schema') == 'osgard.m190.external-head-anchor/1',
            'invalid external anchor format')
    summary = verify(db, expected_head=anchor.get('head'))
    require(summary['events'] == anchor.get('event_count') and
            summary['plan_sha256'] == anchor.get('plan_sha256') and
            anchor.get('production_authorized') is False and
            anchor.get('release_gate') == 'NO_GO', 'external anchor metadata mismatch')
    return summary
