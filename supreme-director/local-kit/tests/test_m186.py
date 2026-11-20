"""M186 reference contracts: deterministic outcomes, strict scope, audit and HTTP."""
import hashlib
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from osgard_m184.storage import DirectorDB
from osgard_m185.review import ReviewDB
from osgard_m186.contracts import (SCENARIOS, CONTRACTS, SCHEMA, ENVELOPE_SCHEMA,
    canonical, catalog_template, validate_catalog, validate_envelope, validate_request, execute_reference,
    hexdigest)
from osgard_m186.storage import LabDB, GENESIS, event_digest
from osgard_m186.api import serve

BASE=Path(__file__).resolve().parents[1]
CATALOG=BASE/'templates/REFERENCE_CONTRACTS_M186.json'
TOKEN='local-reference-tests-private-token-123456789abcdef'


def req(**patch):
    obj={'scenario':'LEARNING_PLATFORM','operator':'synthetic-author',
        'budget_points':1200,'risk_profile':'PUBLIC_DEMO_ONLY','inject_fault_at':None}
    obj.update(patch)
    return obj


class ContractReferenceTests(unittest.TestCase):
    def test_all_scenarios_pass_in_reference_only(self):
        for scenario in sorted(SCENARIOS):
            with self.subTest(scenario=scenario):
                out=execute_reference(req(scenario=scenario))
                self.assertEqual(out['outcome'],'REFERENCE_FLOW_COMPLETE')
                self.assertEqual(len(out['steps']),9)
                self.assertEqual(out['real_product_integrations'],0)
                self.assertEqual(out['original_task_acceptance'],0)
                self.assertIs(out['production_authorized'],False)
                self.assertTrue(all(s['status']=='PASS_REFERENCE' for s in out['steps']))
    def test_determinism(self):
        self.assertEqual(canonical(execute_reference(req())),canonical(execute_reference(req())))
        self.assertEqual(hexdigest(execute_reference(req())),hexdigest(execute_reference(req())))
    def test_all_nine_faults_fail_closed(self):
        for i in range(1,10):
            fault=f'CONTRACT-{i:02d}'
            with self.subTest(fault=fault):
                out=execute_reference(req(inject_fault_at=fault))
                self.assertEqual(out['outcome'],'BLOCKED_REFERENCE_CONTRACT')
                self.assertEqual(len(out['steps']),i)
                self.assertEqual(out['steps'][-1]['status'],'BLOCKED_SCHEMA')
                self.assertFalse(out['production_authorized'])
    def test_strict_input_shape(self):
        for invalid in (None,[],{}, {'scenario':'LEARNING_PLATFORM'},req(production=True),
                        req(operator='user@example.com'),req(operator='Ab'),req(operator='a'*42),
                        req(risk_profile='PRIVATE'),req(scenario='SOMETHING'),
                        req(budget_points=True),req(budget_points=99),req(budget_points=1_000_001),
                        req(inject_fault_at='../../etc/passwd')):
            with self.subTest(invalid=invalid),self.assertRaises(ValueError):validate_request(invalid)
    def test_catalog_exact_shape(self):
        self.assertTrue(validate_catalog(catalog_template()))
        self.assertEqual(len(CONTRACTS),9)
        cat=catalog_template()
        for change in ('real_upstreams','production_authorized','authority'):
            clone=json.loads(canonical(cat));clone[change]=True
            with self.subTest(change=change),self.assertRaises(ValueError):validate_catalog(clone)
        clone=json.loads(canonical(cat));clone['contracts'][3]['verification']='PRODUCTION_PASS'
        with self.assertRaises(ValueError):validate_catalog(clone)
    def test_envelope_exact_types(self):
        envelope=execute_reference(req())['steps'][0]['envelope']
        self.assertTrue(validate_envelope(envelope,CONTRACTS[0]))
        for key,value in [('context','PRODUCTION'),('contract_id','CONTRACT-09'),('producer','ORBITAL')]:
            clone=json.loads(canonical(envelope));clone[key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):validate_envelope(clone,CONTRACTS[0])
        clone=json.loads(canonical(envelope));clone['payload']['identity_proven']=True
        with self.assertRaises(ValueError):validate_envelope(clone,CONTRACTS[0])
    def test_reference_release_cannot_be_promoted(self):
        env=execute_reference(req())['steps'][-1]['envelope']
        for field,value in [('production_authorized',True),('real_integrations',1),('flow','PRODUCTION_READY')]:
            other=json.loads(canonical(env));other['payload'][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):validate_envelope(other,CONTRACTS[-1])
    def test_billing_nonpayable(self):
        e=execute_reference(req())['steps'][2]['envelope']
        self.assertIs(e['payload']['payment_enabled'],False)
        x=json.loads(canonical(e));x['payload']['payment_enabled']=True
        with self.assertRaises(ValueError):validate_envelope(x,CONTRACTS[2])
    def test_step_input_linkage(self):
        result=execute_reference(req())
        for i,event in enumerate(result['steps'],1):
            deps=CONTRACTS[i-1][3]
            outputs={j:result['steps'][j-1]['envelope']['payload'] for j in deps}
            actual=hexdigest({'request':req(),'dependencies':{f'CONTRACT-{j:02d}':outputs[j] for j in deps}})
            self.assertEqual(event['input_sha256'],actual)
    def test_event_hash_sensitive_to_chain(self):
        self.assertNotEqual(event_digest('LAB-'+'A'*24,1,{'demo':1},GENESIS),
                            event_digest('LAB-'+'A'*24,1,{'demo':2},GENESIS))
        self.assertNotEqual(event_digest('LAB-'+'A'*24,1,{'demo':1},GENESIS),
                            event_digest('LAB-'+'A'*24,1,{'demo':1},'a'*64))


class LocalReferenceDBTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.evidence=self.root/'evidence';self.evidence.mkdir()
        self.file=self.root/'studio.sqlite3';self.catalog=self.root/'contracts.json'
        self.catalog.write_bytes(CATALOG.read_bytes())
        DirectorDB(self.file).bootstrap(BASE/'docs/M182_WORKPLAN_180_PROPOSED.json',
            BASE/'templates/CONFLICTS_PROVISIONAL.json',BASE/'templates/CONTRACTS_PROVISIONAL.json')
        ReviewDB(self.file,self.evidence).review_bootstrap(BASE/'templates/TRUSTED_REVIEWERS_EMPTY.json')
        self.db=LabDB(self.file,self.evidence,self.catalog);self.db.lab_bootstrap()
    def test_bootstrap_idempotent(self):
        self.assertEqual(self.db.lab_bootstrap()['status'],'IDEMPOTENT_REFERENCE_LAB')
        self.assertEqual(self.db.doctor()['health'],'LOCAL_INTEGRITY_PASS')
    def test_persistent_nine_step_run(self):
        out=self.db.run_reference(req())
        self.assertEqual(len(out['result']['steps']),9)
        detail=self.db.run_detail(out['run_id'])
        self.assertEqual(len(detail['events']),9)
        self.assertEqual(detail['run']['report_sha'],out['report_sha256'])
        self.assertEqual(detail['events'][0]['previous_sha256'],GENESIS)
        self.assertEqual(detail['events'][-1]['event_sha256'],detail['events'][-1]['event_sha256'])
        self.assertEqual(self.db.doctor()['health'],'LOCAL_INTEGRITY_PASS')
        summary=self.db.summary()
        self.assertEqual(summary['reference_complete'],1)
        self.assertEqual(summary['independent_acceptance'],0)
        self.assertEqual(summary['real_integrations'],0)
        self.assertEqual(summary['verified_external_contracts'],0)
    def test_blocked_fault_run_recorded(self):
        out=self.db.run_reference(req(inject_fault_at='CONTRACT-04'))
        self.assertEqual(out['result']['outcome'],'BLOCKED_REFERENCE_CONTRACT')
        self.assertEqual(len(self.db.run_detail(out['run_id'])['events']),4)
        self.assertEqual(self.db.summary()['reference_blocked'],1)
        self.assertEqual(self.db.doctor()['health'],'LOCAL_INTEGRITY_PASS')
    def test_catalog_changed_refuses_writes(self):
        data=json.loads(self.catalog.read_text());data['contracts'][0]['verification']='REAL'
        self.catalog.write_text(json.dumps(data))
        with self.assertRaises(ValueError):self.db.run_reference(req())
        self.assertEqual(self.db.doctor()['health'],'LOCAL_INTEGRITY_FAIL')
    def test_catalog_whitespace_changed_refuses_writes(self):
        self.catalog.write_bytes(self.catalog.read_bytes()+b'\n')
        with self.assertRaises(ValueError):self.db.run_reference(req())
    def test_immutable_tables_block_sql_mutation(self):
        self.db.run_reference(req())
        con=sqlite3.connect(self.file)
        try:
            with self.assertRaises(sqlite3.IntegrityError):con.execute('DELETE FROM m186_runs')
            with self.assertRaises(sqlite3.IntegrityError):con.execute('UPDATE m186_events SET event_sha=?',('a'*64,))
        finally:con.close()
    def test_tamper_chain_detected_by_doctor(self):
        r=self.db.run_reference(req())
        with sqlite3.connect(self.file) as con:
            con.execute('DROP TRIGGER m186_events_no_update')
            con.execute('UPDATE m186_events SET event_sha=? WHERE run_id=? AND step=1',('0'*64,r['run_id']))
        self.assertIn('LAB_EVENT_HASH_CHAIN_MODIFIED',self.db.doctor()['findings'])
    def test_tamper_request_detected(self):
        r=self.db.run_reference(req())
        with sqlite3.connect(self.file) as con:
            con.execute('DROP TRIGGER m186_runs_no_update')
            con.execute('UPDATE m186_runs SET request_sha=? WHERE run_id=?',('f'*64,r['run_id']))
        self.assertIn('LAB_RUN_REQUEST_OR_REPORT_MODIFIED',self.db.doctor()['findings'])
    def test_no_fabricated_product_acceptance(self):
        r=self.db.run_reference(req())
        self.assertEqual(self.db.summary()['independent_acceptance'],0)
        with self.db.connect() as con:
            self.assertEqual(con.execute("SELECT COUNT(*) FROM tasks WHERE status!='NOT_ACCEPTED'").fetchone()[0],0)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM contracts WHERE status!='UNVERIFIED'").fetchone()[0],0)
    def test_concurrent_runs_unique_ids_and_audit(self):
        with ThreadPoolExecutor(max_workers=4) as ex:
            runs=list(ex.map(lambda i:self.db.run_reference(req(operator='synthetic-%02d'%i)),range(8)))
        self.assertEqual(len({x['run_id'] for x in runs}),8)
        self.assertEqual(self.db.summary()['reference_runs'],8)
        self.assertEqual(self.db.doctor()['health'],'LOCAL_INTEGRITY_PASS')
    def test_invalid_input_does_not_change_ledger(self):
        before=len(self.db.runs())
        with self.assertRaises(ValueError):self.db.run_reference(req(operator='-bad-operator'))
        self.assertEqual(len(self.db.runs()),before)
    def test_invalid_detail_id(self):
        for id in ('../../', 'LAB-test', 'LAB-'+'A'*25, 'LAB-'+'A'*24+'%00'):
            with self.subTest(id=id),self.assertRaises(ValueError):self.db.run_detail(id)
        with self.assertRaises(LookupError):self.db.run_detail('LAB-'+'A'*24)
    def test_catalog_does_not_modify_original_contract_slots(self):
        self.assertEqual(len(self.db.catalog()['contracts']),9)
        self.assertTrue(all(x['verification']=='REFERENCE_ONLY' for x in self.db.catalog()['contracts']))
        self.assertTrue(all(x['status']=='UNVERIFIED' for x in self.db.contracts()))


class ActualHttpLabTests(LocalReferenceDBTests):
    def setUp(self):
        super().setUp()
        self.server,_=serve(self.file,self.evidence,self.catalog,BASE/'dashboard/m186',port=0,token=TOKEN)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self._stop)
    def _stop(self):
        self.server.shutdown();self.server.server_close();self.thread.join(timeout=3)
    def call(self,method,path,data=None,token=TOKEN,origin=None,host=None):
        headers={'Host':host or '127.0.0.1:%d'%self.server.server_port}
        if token is not None:headers['Authorization']='Bearer '+token
        if origin:headers['Origin']=origin
        if data is not None:headers['Content-Type']='application/json'
        raw=json.dumps(data) if data is not None else None
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        try:
            conn.request(method,path,body=raw,headers=headers)
            response=conn.getresponse();return response.status,json.loads(response.read())
        finally:conn.close()
    def test_http_run_and_get(self):
        st,o=self.call('POST','/api/v1/lab/runs',req())
        self.assertEqual(st,201)
        run=o['data']['run_id']
        st,detail=self.call('GET','/api/v1/lab/runs/'+run)
        self.assertEqual(st,200);self.assertEqual(len(detail['data']['events']),9)
        self.assertEqual(self.db.doctor()['health'],'LOCAL_INTEGRITY_PASS')
    def test_http_no_token(self):
        self.assertEqual(self.call('GET','/api/v1/lab/runs',token=None)[0],401)
        self.assertEqual(self.call('POST','/api/v1/lab/runs',req(),token='wrong')[0],401)
    def test_http_host_and_origin_restricted(self):
        self.assertEqual(self.call('GET','/api/v1/lab/catalog',host='evil.test')[0],403)
        self.assertEqual(self.call('GET','/api/v1/lab/catalog',origin='https://evil.test')[0],403)
    def test_http_invalid_contract_refused(self):
        self.assertEqual(self.call('POST','/api/v1/lab/runs',req(production=True))[0],400)
        self.assertEqual(self.db.summary()['reference_runs'],0)
    def test_http_failing_contract_is_recorded_not_green(self):
        st,r=self.call('POST','/api/v1/lab/runs',req(inject_fault_at='CONTRACT-07'))
        self.assertEqual(st,201);self.assertEqual(r['data']['result']['outcome'],'BLOCKED_REFERENCE_CONTRACT')
        self.assertEqual(len(r['data']['result']['steps']),7)
    def test_http_rejects_production_transition(self):
        self.assertEqual(self.call('POST','/api/v1/release/approve',{'production':True})[0],404)
    def test_http_refusal_of_dangerous_id(self):
        self.assertEqual(self.call('GET','/api/v1/lab/runs/../../etc/passwd')[0],404)
    def test_http_health_scope(self):
        self.assertEqual(self.call('GET','/api/v1/health',token=None)[1]['release'],'PRODUCTION_NO_GO')
    def test_http_static_ui_served(self):
        conn=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        conn.request('GET','/',headers={'Host':'127.0.0.1:%d'%self.server.server_port})
        res=conn.getresponse();body=res.read().decode('utf8');conn.close()
        self.assertEqual(res.status,200);self.assertIn('Integration Lab',body)

if __name__=='__main__':unittest.main()
