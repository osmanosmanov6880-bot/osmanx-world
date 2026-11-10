"""Real M184 storage and loopback HTTP tests; no product approval claims."""
import concurrent.futures
from contextlib import closing
import hashlib
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

from osgard_m184.api import LocalServer, serve
from osgard_m184.storage import (
    CONFLICT_ALLOWED, DirectorDB, GENESIS, audit_digest, read_pinned_json,
    validate_conflicts, validate_contracts,
)

ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT / 'docs/M182_WORKPLAN_180_PROPOSED.json'
CONFLICTS = ROOT / 'templates/CONFLICTS_PROVISIONAL.json'
CONTRACTS = ROOT / 'templates/CONTRACTS_PROVISIONAL.json'
OBS = ROOT / 'docs/m183/CURRENT_GITHUB_DEFAULT_BRANCH_OBSERVATIONS_2026-10-27.json'
ASSETS = ROOT / 'dashboard/m184'
TOKEN = 'this-is-a-long-temp-test-token-0123456789'


class TestM184Storage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = DirectorDB(self.root / 'local.sqlite3')
        self.db.bootstrap(PLAN, CONFLICTS, CONTRACTS, OBS)

    def test_bootstrap_counts(self):
        s = self.db.summary()
        self.assertEqual(s['counts']['tasks'], 180)
        self.assertEqual(s['counts']['conflicts'], 28)
        self.assertEqual(s['counts']['contracts'], 9)
        self.assertEqual(s['counts']['observations'], 6)
        self.assertEqual(s['release'], 'PRODUCTION_NO_GO')
        self.assertEqual(s['independent_acceptance'], 0)

    def test_real_git_observations_not_team_mapping(self):
        self.assertTrue(all(x['team'] is None and x['verification'] == 'UNVERIFIED' for x in self.db.observations()))

    def test_init_proposed_not_original(self):
        self.assertFalse(self.db.summary()['original_m181_available'])

    def test_idempotent_bootstrap(self):
        x = self.db.bootstrap(PLAN, CONFLICTS, CONTRACTS, OBS)
        self.assertEqual(x['status'], 'IDEMPOTENT_NO_CHANGES')
        self.assertEqual(self.db.summary()['counts']['audit'], 1)

    def test_changed_template_rejected_no_mutation(self):
        data = json.loads(CONFLICTS.read_text())
        data['conflicts'][0]['path'] = 'unknown.py'
        p = self.root / 'tampered.json'; p.write_text(json.dumps(data))
        with self.assertRaises(ValueError): self.db.bootstrap(PLAN, p, CONTRACTS, OBS)
        self.assertEqual(self.db.summary()['counts']['audit'], 1)

    def test_bad_contract_count(self):
        item = json.loads(CONTRACTS.read_text())
        item['contracts'].pop()
        with self.assertRaises(ValueError): validate_contracts(item)

    def test_bad_conflict_severity(self):
        item = json.loads(CONFLICTS.read_text())
        item['conflicts'][0]['severity'] = 'P2'
        with self.assertRaises(ValueError): validate_conflicts(item)

    def test_invalid_db_symlink(self):
        pointer = self.root / 'database-link'; pointer.symlink_to(self.db.path)
        with self.assertRaises(ValueError): DirectorDB(pointer)

    def test_missing_database_not_silently_initialized(self):
        x = DirectorDB(self.root / 'other.db')
        with self.assertRaises(ValueError): x.summary()
        self.assertFalse(x.path.exists())

    def test_doctor_pass(self): self.assertEqual(self.db.doctor()['health'], 'LOCAL_INTEGRITY_PASS')

    def test_summary_phase_counts(self):
        self.assertEqual(self.db.summary()['phase_counts'], {'A': 12, 'B': 48, 'C': 90, 'D': 30})

    def test_task_filters(self):
        self.assertEqual(len(self.db.tasks('TITAN')), 30)
        self.assertEqual(len(self.db.tasks('ORBITAL', q='A01')), 1)
        self.assertEqual(len(self.db.tasks()), 180)

    def test_illegal_task_query(self):
        with self.assertRaises(ValueError): self.db.tasks(team='UNKNOWN')
        with self.assertRaises(ValueError): self.db.tasks(limit=10000)

    def test_note_is_not_acceptance(self):
        task = self.db.tasks('TITAN')[0]['id']
        n = self.db.add_note('task', task, 'reviewer-x', 'Dependency needs source archive')
        self.assertEqual(n['status'], 'RECORDED_NOT_APPROVED')
        self.assertEqual(self.db.summary()['independent_acceptance'], 0)
        self.assertEqual(self.db.summary()['counts']['notes'], 1)
        self.assertEqual(self.db.doctor()['health'], 'LOCAL_INTEGRITY_PASS')

    def test_xss_note_remains_text(self):
        task = self.db.tasks('NEXUS')[0]['id']
        self.db.add_note('task', task, 'operator', '<img src=x onerror=alert(1)>')
        self.assertIn('<img', self.db.notes()[0]['note'])

    def test_note_unknown_target_rejected(self):
        with self.assertRaises(ValueError): self.db.add_note('task', 'FAKE', 'a', 'b')
        self.assertEqual(self.db.summary()['counts']['notes'], 0)

    def test_note_empty_actor_and_nul(self):
        with self.assertRaises(ValueError): self.db.add_note('contract', 'CONTRACT-01', '', 'note')
        with self.assertRaises(ValueError): self.db.add_note('contract', 'CONTRACT-01', 'a', 'bad\x00text')

    def test_conflict_triage_progresses_without_resolving(self):
        c = 'M181-CONFLICT-01'
        self.db.triage_conflict(c, 'TRIAGED', 'qa', 'Awaiting exact source proof')
        self.db.triage_conflict(c, 'REVIEW_PENDING', 'qa', 'Waiting independent human')
        self.assertEqual(self.db.conflicts()[0]['status'], 'REVIEW_PENDING')
        self.assertEqual(self.db.conflicts()[0]['note_count'], 2)
        self.assertEqual(self.db.doctor()['health'], 'LOCAL_INTEGRITY_PASS')

    def test_conflict_cannot_approve(self):
        with self.assertRaises(ValueError): self.db.triage_conflict('M181-CONFLICT-01', 'RESOLVED', 'qa', 'claim')

    def test_conflict_skip_transition_denied(self):
        with self.assertRaises(ValueError): self.db.triage_conflict('M181-CONFLICT-01', 'REVIEW_PENDING', 'qa', 'skip')

    def test_quarantine_is_absorbing(self):
        c = 'M181-CONFLICT-02'
        self.db.triage_conflict(c, 'QUARANTINED', 'security', 'Source requires verification')
        with self.assertRaises(ValueError): self.db.triage_conflict(c, 'TRIAGED', 'ops', 'no release')

    def test_audit_chain_preserved(self):
        self.db.add_note('contract', 'CONTRACT-01', 'qa', 'waiting consumer tests')
        a = self.db.audit()
        self.assertEqual(a[0]['previous_sha'], a[1]['event_sha'])
        self.assertEqual(a[-1]['previous_sha'], GENESIS)
        self.assertEqual(self.db.doctor()['health'], 'LOCAL_INTEGRITY_PASS')

    def test_audit_direct_update_blocked_by_trigger(self):
        with closing(sqlite3.connect(self.db.path)) as con, con:
            with self.assertRaises(sqlite3.IntegrityError):
                con.execute("UPDATE audit SET action='APPROVED' WHERE sequence=1")

    def test_audit_tamper_detected_even_after_trigger_disabled(self):
        with closing(sqlite3.connect(self.db.path)) as con, con:
            con.execute('DROP TRIGGER audit_no_update')
            con.execute("UPDATE audit SET action='APPROVED' WHERE sequence=1")
        self.assertIn('AUDIT_CHAIN_INVALID', self.db.doctor()['findings'])

    def test_false_production_flag_detected(self):
        with closing(sqlite3.connect(self.db.path)) as con, con:
            con.execute("UPDATE meta SET value='true' WHERE key='production_authorized'")
        self.assertIn('FALSE_PRODUCTION_AUTHORIZATION', self.db.doctor()['findings'])

    def test_fake_task_status_rejected_by_sqlite(self):
        with closing(sqlite3.connect(self.db.path)) as con, con:
            with self.assertRaises(sqlite3.IntegrityError):
                con.execute("UPDATE tasks SET status='ACCEPTED' WHERE rowid=1")

    def test_fake_source_mapping_caught(self):
        with closing(sqlite3.connect(self.db.path)) as con, con:
            con.execute("UPDATE observations SET team='TITAN' WHERE id=1")
        self.assertIn('FALSE_CANONICAL_MAPPING', self.db.doctor()['findings'])

    def test_sql_injection_search_escaped_by_bindings(self):
        self.assertEqual(self.db.tasks(q="'; DROP TABLE tasks;--"), [])
        self.assertEqual(len(self.db.tasks()), 180)

    def test_source_observation_unverified(self):
        out = self.db.observe_source('alpha/tool', 'refs-main', 'f' * 40, 'qa')
        self.assertEqual(out['verification'], 'UNVERIFIED')
        self.assertIsNone(out['team_assignment'])
        self.assertEqual(self.db.doctor()['health'], 'LOCAL_INTEGRITY_PASS')

    def test_source_observation_invalid_branch_and_sha(self):
        with self.assertRaises(ValueError): self.db.observe_source('good/repo', '../main', 'f'*40, 'qa')
        with self.assertRaises(ValueError): self.db.observe_source('good/repo', 'main', 'wrong', 'qa')

    def test_source_observation_rejected_fake_owner(self):
        with self.assertRaises(ValueError): self.db.observe_source('owner/repo;touch /tmp/oops', 'main', 'f'*40, 'qa')

    def test_evidence_registration(self):
        root = self.root / 'evidence'; root.mkdir()
        data = root / 'receipt.log'; data.write_bytes(b'local synthetic receipt only')
        checksum = hashlib.sha256(data.read_bytes()).hexdigest()
        result = self.db.register_local_evidence('platform', data.name, checksum, 'qa', root)
        self.assertEqual(result['status'], 'LOCAL_SHA_ONLY')
        self.assertEqual(self.db.doctor()['health'], 'LOCAL_INTEGRITY_PASS')

    def test_evidence_rejects_invalid_sha(self):
        root = self.root / 'evidence';root.mkdir()
        (root / 'file.txt').write_text('x')
        with self.assertRaises(ValueError): self.db.register_local_evidence('platform','file.txt','0'*64,'qa',root)

    def test_evidence_rejects_path_traversal(self):
        root = self.root / 'evidence';root.mkdir()
        with self.assertRaises(ValueError): self.db.register_local_evidence('platform','../outside','f'*64,'qa',root)

    def test_evidence_rejects_symlink(self):
        root = self.root / 'evidence';root.mkdir()
        (self.root / 'outside').write_text('x')
        (root / 'link').symlink_to(self.root / 'outside')
        checksum = hashlib.sha256(b'x').hexdigest()
        with self.assertRaises(ValueError): self.db.register_local_evidence('platform','link',checksum,'qa',root)

    def test_evidence_rejects_unknown_target(self):
        root = self.root / 'evidence';root.mkdir()
        (root / 'valid').write_text('x')
        with self.assertRaises(ValueError): self.db.register_local_evidence('UNSEEN','valid',hashlib.sha256(b'x').hexdigest(),'qa',root)

    def test_notes_concurrent_writes_have_valid_chain(self):
        def writer(i): self.db.add_note('contract', 'CONTRACT-02', 'writer' + str(i), 'work item ' + str(i))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(writer, range(25)))
        self.assertEqual(self.db.summary()['counts']['audit'], 26)
        self.assertEqual(self.db.summary()['counts']['notes'], 25)
        self.assertEqual(self.db.doctor()['health'], 'LOCAL_INTEGRITY_PASS')

    def test_audit_deletion_blocked(self):
        with closing(sqlite3.connect(self.db.path)) as con, con:
            with self.assertRaises(sqlite3.IntegrityError):
                con.execute('DELETE FROM audit')

    def test_invalid_input_type(self):
        with self.assertRaises(ValueError): self.db.observe_source(None, 'main', '0'*40, 'qa')

    def test_no_substitute_product_acceptance(self):
        self.assertTrue(all(x['status'] == 'NOT_ACCEPTED' for x in self.db.tasks()))
        self.assertTrue(all(x['status'] == 'UNVERIFIED' for x in self.db.contracts()))

    def test_conflict_counts_include_severity(self):
        values = self.db.conflicts()
        self.assertEqual(sum(x['severity'] == 'P0' for x in values), 17)
        self.assertEqual(sum(x['severity'] == 'P1' for x in values), 11)

    def test_empty_evidence_not_called_product_e2e(self):
        self.assertEqual(self.db.summary()['real_product_integrations'], 0)


class TestM184HTTP(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = DirectorDB(self.root / 'db.sqlite3')
        self.db.bootstrap(PLAN, CONFLICTS, CONTRACTS, OBS)
        self.server, _ = serve(self.db.path, ASSETS, port=0, token=TOKEN)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=3)

    def request(self, method, path, data=None, auth=True, headers=None):
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        h = dict(headers or {})
        if auth: h['Authorization'] = 'Bearer ' + TOKEN
        if data is not None and not isinstance(data, bytes):
            data = json.dumps(data).encode('utf8')
            h.setdefault('Content-Type','application/json')
        c.request(method, path, data, headers=h)
        resp = c.getresponse(); raw = resp.read(); code=resp.status; resp_headers=dict(resp.getheaders());c.close()
        if 'application/json' in resp_headers.get('Content-Type',''):
            return code, json.loads(raw), resp_headers
        return code, raw, resp_headers

    def test_health_no_token(self):
        code, obj, _ = self.request('GET', '/api/v1/health', auth=False)
        self.assertEqual(code, 200); self.assertEqual(obj['release'], 'PRODUCTION_NO_GO')

    def test_summary_requires_token(self):
        self.assertEqual(self.request('GET','/api/v1/summary',auth=False)[0],401)

    def test_valid_summary(self):
        code, obj, headers = self.request('GET','/api/v1/summary')
        self.assertEqual(code, 200); self.assertEqual(obj['data']['counts']['tasks'], 180)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertNotIn('Access-Control-Allow-Origin',headers)

    def test_no_unsafe_cross_origin(self):
        self.assertEqual(self.request('GET','/api/v1/summary',headers={'Origin':'https://evil.example'})[0],403)

    def test_no_fake_host(self):
        self.assertEqual(self.request('GET','/api/v1/summary',headers={'Host':'evil.example'})[0],403)

    def test_no_fake_fetch_site(self):
        self.assertEqual(self.request('GET','/api/v1/summary',headers={'Sec-Fetch-Site':'cross-site'})[0],403)

    def test_post_with_wrong_token_no_mutation(self):
        code,_,_ = self.request('POST','/api/v1/notes', {'kind':'task','target':'M182-TITAN-A01','actor':'qa','note':'test'}, auth=False)
        self.assertEqual(code,401); self.assertEqual(self.db.summary()['counts']['notes'],0)

    def test_valid_note_post_and_get(self):
        data = {'kind':'task','target':'M182-TITAN-A01','actor':'qa','note':'waiting upstream'}
        self.assertEqual(self.request('POST','/api/v1/notes',data)[0],201)
        code,obj,_=self.request('GET','/api/v1/notes?kind=task&target=M182-TITAN-A01')
        self.assertEqual(code,200);self.assertEqual(obj['data'][0]['note'],'waiting upstream')
        self.assertEqual(self.db.doctor()['health'],'LOCAL_INTEGRITY_PASS')

    def test_invalid_content_type(self):
        code,_,_=self.request('POST','/api/v1/notes',b'<script>',headers={'Content-Type':'text/html'})
        self.assertEqual(code,415)

    def test_oversized_payload_rejected(self):
        code,_,_=self.request('POST','/api/v1/notes',b'A'*17000,headers={'Content-Type':'application/json'})
        self.assertEqual(code,413)

    def test_invalid_json(self):
        code,_,_=self.request('POST','/api/v1/notes',b'{invalid',headers={'Content-Type':'application/json'})
        self.assertEqual(code,400)

    def test_unknown_mutation_route_rejected(self):
        self.assertEqual(self.request('POST','/api/v1/approve',{'approved':True})[0],404)

    def test_no_cors_preflight(self):
        self.assertEqual(self.request('OPTIONS','/api/v1/notes',auth=False)[0],405)

    def test_no_http_prod_go(self):
        code,obj,_=self.request('GET','/api/v1/doctor')
        self.assertEqual(code,200); self.assertEqual(obj['data']['release'],'PRODUCTION_NO_GO')

    def test_real_conflict_triage(self):
        payload={'status':'TRIAGED','actor':'reviewer','note':'await source file'}
        self.assertEqual(self.request('POST','/api/v1/conflicts/M181-CONFLICT-01/triage',payload)[0],201)
        code,obj,_=self.request('GET','/api/v1/conflicts')
        self.assertEqual(obj['data'][0]['status'],'TRIAGED')

    def test_no_conflict_resolution_by_api(self):
        payload={'status':'RESOLVED','actor':'reviewer','note':'fake approval'}
        self.assertEqual(self.request('POST','/api/v1/conflicts/M181-CONFLICT-01/triage',payload)[0],400)

    def test_observation_via_http(self):
        payload={'repo':'qa/example','branch':'main','sha':'b'*40,'actor':'qa'}
        self.assertEqual(self.request('POST','/api/v1/sources',payload)[0],201)
        self.assertIsNone(self.db.observations()[0]['team'])

    def test_static_content_with_csp(self):
        code,content,headers=self.request('GET','/',auth=False)
        self.assertEqual(code,200);self.assertIn(b'DIRECTOR STUDIO',content)
        self.assertIn("default-src 'none'", headers['Content-Security-Policy'])
        code,js,_=self.request('GET','/assets/studio.js',auth=False)
        self.assertEqual(code,200); self.assertIn(b'textContent',js)

    def test_no_static_directory_traversal(self):
        self.assertEqual(self.request('GET','/assets/../../osgard_m184/storage.py',auth=False)[0],404)

    def test_loopback_only_constructor(self):
        with self.assertRaises(ValueError):
            LocalServer(('0.0.0.0',0),self.db,TOKEN,ASSETS)

    def test_empty_token_rejected(self):
        with self.assertRaises(ValueError):
            LocalServer(('127.0.0.1',0),self.db,'short',ASSETS)

    def test_doctor_refuses_corrupt_database(self):
        with closing(sqlite3.connect(self.db.path)) as con, con:
            con.execute("UPDATE meta SET value='true' WHERE key='production_authorized'")
        with self.assertRaises(ValueError): serve(self.db.path, ASSETS, 0, TOKEN)


if __name__ == '__main__':
    unittest.main()
