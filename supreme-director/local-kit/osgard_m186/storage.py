"""SQLite evidence ledger for M186 synthetic contract-chain runs.

Append-only triggers and SHA checks detect ordinary corruption; they are not
remote attestation and are not a boundary against a database administrator.
"""
from __future__ import annotations
import json
from pathlib import Path
import re
import sqlite3
import uuid

from osgard_m185.review import ReviewDB
from osgard_m184.storage import read_pinned_json, sha, utcnow
from .contracts import canonical, hexdigest, validate_catalog, validate_request, execute_reference

STATE = 'osgard.m186.reference-run-ledger/1'
GENESIS = '0' * 64
RUN_ID = re.compile(r'LAB-[0-9A-F]{24}\Z')


def event_digest(run_id, index, event, previous):
    return hexdigest([run_id, index, event, previous])


class LabDB(ReviewDB):
    def __init__(self, path, evidence_root, catalog_path):
        super().__init__(path, evidence_root)
        self.catalog_path = Path(catalog_path)

    def lab_bootstrap(self):
        if super().doctor()['health'] != 'LOCAL_INTEGRITY_PASS':
            raise ValueError('signed-review parent doctor must pass before lab initialization')
        catalog, digest = read_pinned_json(self.catalog_path, max_bytes=60_000)
        validate_catalog(catalog)
        with self.connect(write=True) as con:
            con.executescript('''
                CREATE TABLE IF NOT EXISTS m186_runs (
                    run_id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL,
                    request_json TEXT NOT NULL, request_sha TEXT NOT NULL, outcome TEXT NOT NULL,
                    report_sha TEXT NOT NULL, release TEXT NOT NULL CHECK(release='PRODUCTION_NO_GO'));
                CREATE TABLE IF NOT EXISTS m186_events (
                    run_id TEXT NOT NULL REFERENCES m186_runs(run_id), step INTEGER NOT NULL,
                    contract_id TEXT NOT NULL, event_json TEXT NOT NULL,
                    previous_sha TEXT NOT NULL, event_sha TEXT NOT NULL,
                    PRIMARY KEY(run_id,step));
                CREATE TRIGGER IF NOT EXISTS m186_runs_no_update BEFORE UPDATE ON m186_runs BEGIN
                    SELECT RAISE(ABORT, 'reference runs immutable'); END;
                CREATE TRIGGER IF NOT EXISTS m186_runs_no_delete BEFORE DELETE ON m186_runs BEGIN
                    SELECT RAISE(ABORT, 'reference runs immutable'); END;
                CREATE TRIGGER IF NOT EXISTS m186_events_no_update BEFORE UPDATE ON m186_events BEGIN
                    SELECT RAISE(ABORT, 'reference events immutable'); END;
                CREATE TRIGGER IF NOT EXISTS m186_events_no_delete BEFORE DELETE ON m186_events BEGIN
                    SELECT RAISE(ABORT, 'reference events immutable'); END;
            ''')
            # sqlite3.executescript may commit a transaction; restore a write lock.
            con.execute('BEGIN IMMEDIATE')
            row = con.execute("SELECT value FROM meta WHERE key='m186_schema'").fetchone()
            if row:
                self._require_lab(con)
                return {'status': 'IDEMPOTENT_REFERENCE_LAB', 'catalog_sha256': digest,
                        'production_authorized': False}
            con.executemany('INSERT INTO meta VALUES (?,?)', [
                ('m186_schema', STATE), ('m186_catalog_sha', digest),
                ('m186_production_approval', 'false'), ('m186_real_adapter_count','0')])
            self._audit(con,'local-operator','M186_REFERENCE_LAB_INITIALIZED','SYNTHETIC_ONLY',
                        {'catalog_sha256': digest, 'nine_contracts': 9,
                         'real_adapters': 0, 'production_authorized': False})
        return {'status': 'REFERENCE_LAB_INITIALIZED', 'catalog_sha256': digest, 'production_authorized': False}

    def _require_lab(self, con):
        self._require_review(con)
        m = dict(con.execute("SELECT key,value FROM meta WHERE key LIKE 'm186_%'"))
        if (m.get('m186_schema') != STATE or m.get('m186_production_approval') != 'false' or
            m.get('m186_real_adapter_count') != '0'):
            raise ValueError('reference lab not initialized or impossible authority change')
        spec, digest = read_pinned_json(self.catalog_path, max_bytes=60_000)
        validate_catalog(spec)
        if digest != m.get('m186_catalog_sha'):
            raise ValueError('reference adapter catalog changed after bootstrap')

    def catalog(self):
        with self.connect() as con:
            self._require_lab(con)
            obj, _ = read_pinned_json(self.catalog_path, max_bytes=60_000)
            return obj

    def run_reference(self, request):
        validated = validate_request(request)
        report = execute_reference(validated)
        run_id = 'LAB-' + uuid.uuid4().hex[:24].upper()
        with self.connect(write=True) as con:
            self._require_lab(con)
            if con.execute('SELECT count(*) FROM m186_runs').fetchone()[0] >= 5_000:
                raise ValueError('bounded local run ledger reached maximum capacity')
            con.execute('INSERT INTO m186_runs VALUES (?,?,?,?,?,?,?,?)',
                        (run_id,utcnow(),validated['operator'], canonical(validated),hexdigest(validated),
                         report['outcome'],hexdigest(report),'PRODUCTION_NO_GO'))
            previous = GENESIS
            for item in report['steps']:
                index = item['index']
                digest = event_digest(run_id,index,item,previous)
                con.execute('INSERT INTO m186_events VALUES (?,?,?,?,?,?)',
                            (run_id,index,item['contract_id'],canonical(item),previous,digest))
                previous = digest
            self._audit(con, validated['operator'],'M186_REFERENCE_FLOW_RECORDED',run_id,
                        {'outcome':report['outcome'], 'steps':len(report['steps']),
                         'report_sha256':hexdigest(report),'release':'PRODUCTION_NO_GO',
                         'real_integrations':0})
        return {'run_id':run_id,'result':report,'report_sha256':hexdigest(report),
                'release':'PRODUCTION_NO_GO', 'reference_only':True}

    def runs(self):
        with self.connect() as con:
            self._require_lab(con)
            return [dict(r) for r in con.execute('''
                SELECT run_id,at,actor,request_sha,outcome,report_sha,release
                FROM m186_runs ORDER BY at DESC,run_id DESC LIMIT 100''')]

    def run_detail(self, run_id):
        if not isinstance(run_id,str) or not RUN_ID.fullmatch(run_id):
            raise ValueError('invalid run id')
        with self.connect() as con:
            self._require_lab(con)
            row = con.execute('SELECT * FROM m186_runs WHERE run_id=?',(run_id,)).fetchone()
            if row is None: raise LookupError('run not found')
            events = [dict(e) for e in con.execute('SELECT * FROM m186_events WHERE run_id=? ORDER BY step',(run_id,))]
            return {'run':{k:v for k,v in dict(row).items() if k!='request_json'},
                    'events':[{'step':e['step'],'contract_id':e['contract_id'],
                               'event':json.loads(e['event_json']),
                               'previous_sha256':e['previous_sha'], 'event_sha256':e['event_sha']} for e in events],
                    'original_product_acceptance':0,'production_authorized':False}

    def summary(self):
        value=super().summary()
        with self.connect() as con:
            self._require_lab(con)
            values=dict(con.execute('SELECT outcome,count(*) FROM m186_runs GROUP BY outcome'))
        value.update(version='M186',state='LOCAL_REFERENCE_INTEGRATION_LAB',reference_runs=sum(values.values()),
                     reference_complete=values.get('REFERENCE_FLOW_COMPLETE',0),
                     reference_blocked=values.get('BLOCKED_REFERENCE_CONTRACT',0),
                     simulated_contracts=9, real_integrations=0,
                     verified_external_contracts=0, independent_acceptance=0,release='PRODUCTION_NO_GO')
        return value

    def doctor(self):
        result=super().doctor()
        findings=list(result.get('findings',[]))
        try:
            with self.connect() as con:
                self._require_lab(con)
                rows=list(con.execute('SELECT * FROM m186_runs'))
                for row in rows:
                    if row['release'] != 'PRODUCTION_NO_GO':
                        findings.append('LAB_RELEASE_ESCALATION')
                    try:
                        request=json.loads(row['request_json'])
                        validate_request(request)
                        reconstructed=execute_reference(request)
                        if (hexdigest(request)!=row['request_sha'] or reconstructed['outcome']!=row['outcome'] or
                            hexdigest(reconstructed)!=row['report_sha']):
                            findings.append('LAB_RUN_REQUEST_OR_REPORT_MODIFIED')
                        events=list(con.execute('SELECT * FROM m186_events WHERE run_id=? ORDER BY step',(row['run_id'],)))
                        previous=GENESIS
                        if len(events)!=len(reconstructed['steps']):
                            findings.append('LAB_MISSING_OR_EXTRA_EVENT')
                        for i,event in enumerate(events):
                            if event['step']!=i+1 or event['previous_sha']!=previous:
                                findings.append('LAB_EVENT_SEQUENCE_MODIFIED')
                            parsed=json.loads(event['event_json'])
                            if i>=len(reconstructed['steps']) or parsed!=reconstructed['steps'][i] or event['contract_id']!=parsed['contract_id']:
                                findings.append('LAB_EVENT_PAYLOAD_MODIFIED')
                            expected=event_digest(row['run_id'],event['step'],parsed,previous)
                            if expected!=event['event_sha']:
                                findings.append('LAB_EVENT_HASH_CHAIN_MODIFIED')
                            previous=event['event_sha']
                    except (ValueError,TypeError,KeyError,IndexError,json.JSONDecodeError):
                        findings.append('LAB_RUN_DECODING_FAILED')
        except (ValueError,sqlite3.Error,OSError):
            findings.append('LAB_SCHEMA_OR_CATALOG_INTEGRITY')
        findings=sorted(set(findings))
        result.update(findings=findings, health='LOCAL_INTEGRITY_PASS' if not findings else 'LOCAL_INTEGRITY_FAIL',
                      release='PRODUCTION_NO_GO', no_real_adapters=True)
        return result
