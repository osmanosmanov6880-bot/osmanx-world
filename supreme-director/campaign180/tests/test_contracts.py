"""Deny-by-default TaskEnvelope and ResultEnvelope with local replay guard."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import sqlite3
from pathlib import Path
import tempfile
import unittest
import uuid

from campaign180.contracts import (
    ContractError, SCHEMA_TASK, SCHEMA_RESULT,
    validate_task,validate_result,ReplayLedger,digest
)

NOW=1799971200
TENANT='tenant_alpha'
ACTOR='owner-abc'
CAP={'inventory.read','audit.read'}
SCOPES={'project:abc','workspace:demo'}


def task():
    return {'schema':SCHEMA_TASK,'task_id':str(uuid.uuid4()),
            'tenant_id':TENANT,'actor_id':ACTOR,
            'capability':'inventory.read','issued_at':NOW-5,'expires_at':NOW+120,
            'idempotency_key':'test-unique-key-'+uuid.uuid4().hex,
            'resource_scopes':['project:abc'],'body':{'target':'source'}}


def valid(t=None):
    return validate_task(t or task(),tenant_id=TENANT,actor_id=ACTOR,
                         allow_capabilities=CAP,allowed_scopes=SCOPES,now=NOW)


def result(v):
    x=v['task']
    return {'schema':SCHEMA_RESULT,'result_id':str(uuid.uuid4()),
            'task_id':x['task_id'],'task_digest':v['digest'],
            'tenant_id':TENANT,'status':'ok','completed_at':NOW,
            'body':{'records':0},'error_code':None}


class ContractTests(unittest.TestCase):
    def test_valid_bound_task_and_result(self):
        v=valid()
        self.assertEqual(len(v['digest']),64)
        self.assertFalse(v['external_execution_permitted'])
        output=validate_result(result(v),task=v,now=NOW)
        self.assertTrue(output['result_verified_against_task'])
        self.assertFalse(output['worker_execution_independently_verified'])

    def test_tenant_and_actor_impersonation_denied(self):
        for field,value in [('tenant_id','tenant_other'),('actor_id','attacker')]:
            with self.subTest(field=field):
                p=task();p[field]=value
                with self.assertRaises(ContractError):valid(p)

    def test_unknown_capability_and_scope_denied(self):
        p=task();p['capability']='payments.send'
        with self.assertRaises(ContractError):valid(p)
        p=task();p['resource_scopes']=['project:other']
        with self.assertRaises(ContractError):valid(p)
        p=task();p['resource_scopes']=[]
        with self.assertRaises(ContractError):valid(p)

    def test_replay_keys_and_ttl_validation(self):
        p=task();p['idempotency_key']='short'
        with self.assertRaises(ContractError):valid(p)
        p=task();p['expires_at']=NOW-1
        with self.assertRaises(ContractError):valid(p)
        p=task();p['expires_at']=NOW+5000
        with self.assertRaises(ContractError):valid(p)
        p=task();p['issued_at']=NOW+100
        with self.assertRaises(ContractError):valid(p)

    def test_no_float_nan_unsafe_integer_or_secrets_in_body(self):
        for data in ({'value':float('nan')},{'value':1.2},
                     {'api_key':'fake'},{'nested':{'private_key':'fake'}},
                     {'value':2**60}):
            with self.subTest(body=data):
                p=task();p['body']=data
                with self.assertRaises(ContractError):valid(p)

    def test_oversize_and_deep_body_denied(self):
        p=task();p['body']={'value':'a'*40000}
        with self.assertRaises(ContractError):valid(p)
        deep='x'
        for _ in range(15):deep={'nested':deep}
        p=task();p['body']={'v':deep}
        with self.assertRaises(ContractError):valid(p)

    def test_extra_fields_and_noncanonical_task_id(self):
        p=task();p['unknown']=1
        with self.assertRaises(ContractError):valid(p)
        p=task();p['task_id']=p['task_id'].upper()
        with self.assertRaises(ContractError):valid(p)

    def test_result_binds_original_task_and_tenant(self):
        v=valid();r=result(v)
        r['task_digest']='0'*64
        with self.assertRaises(ContractError):validate_result(r,task=v,now=NOW)
        r=result(v);r['tenant_id']='tenant_other'
        with self.assertRaises(ContractError):validate_result(r,task=v,now=NOW)

    def test_result_status_error_code_consistency(self):
        v=valid();r=result(v);r['status']='failed'
        with self.assertRaises(ContractError):validate_result(r,task=v,now=NOW)
        r['error_code']='UPSTREAM_MISSING'
        self.assertEqual(validate_result(r,task=v,now=NOW)['result']['status'],'failed')
        r=result(v);r['error_code']='SOMETHING'
        with self.assertRaises(ContractError):validate_result(r,task=v,now=NOW)

    def test_result_cannot_postdate_task_expiry(self):
        v=valid();r=result(v);r['completed_at']=v['task']['expires_at']+1
        with self.assertRaises(ContractError):validate_result(r,task=v,now=NOW+100)

    def test_task_mutation_invalidates_context_digest(self):
        v=valid();v['task']['body']['target']='altered'
        with self.assertRaises(ContractError):validate_result(result(v),task=v,now=NOW)

    def test_local_durable_claim_duplicate_and_collision(self):
        with tempfile.TemporaryDirectory() as d:
            db=ReplayLedger(str(Path(d)/'claims.sqlite'))
            v=valid()
            self.assertEqual(db.claim(v),'CLAIMED_LOCAL_ONLY')
            self.assertEqual(db.claim(v),'DUPLICATE_NO_EFFECT')
            mutated=deepcopy(v);mutated['task']['body']={'target':'different'}
            mutated['digest']=digest(mutated['task'])
            with self.assertRaises(ContractError):db.claim(mutated)

    def test_claim_requires_validated_digest(self):
        with tempfile.TemporaryDirectory() as d:
            db=ReplayLedger(str(Path(d)/'claims.sqlite'))
            v=valid();v['digest']='wrong'
            with self.assertRaises(ContractError):db.claim(v)

    def test_finish_is_idempotent_and_cannot_rewrite(self):
        with tempfile.TemporaryDirectory() as d:
            db=ReplayLedger(str(Path(d)/'claims.sqlite'))
            v=valid();db.claim(v)
            r=validate_result(result(v),task=v,now=NOW)
            self.assertEqual(db.finish(v,r),'COMPLETED_LOCAL_RECORD_ONLY')
            self.assertEqual(db.finish(v,r),'ALREADY_COMPLETED_LOCAL_ONLY')
            change=deepcopy(r);change['result']['body']['records']=99
            change['digest']=digest(change['result'])
            with self.assertRaises(ContractError):db.finish(v,change)

    def test_finish_requires_prior_claim(self):
        with tempfile.TemporaryDirectory() as d:
            db=ReplayLedger(str(Path(d)/'claims.sqlite'))
            v=valid();r=validate_result(result(v),task=v,now=NOW)
            with self.assertRaises(ContractError):db.finish(v,r)

    def test_concurrent_deduplication_one_claim(self):
        with tempfile.TemporaryDirectory() as d:
            db=ReplayLedger(str(Path(d)/'claims.sqlite'))
            v=valid()
            with ThreadPoolExecutor(max_workers=8) as pool:
                results=list(pool.map(lambda _:db.claim(v),range(10)))
            self.assertEqual(results.count('CLAIMED_LOCAL_ONLY'),1)
            self.assertEqual(results.count('DUPLICATE_NO_EFFECT'),9)


if __name__=='__main__':unittest.main()
