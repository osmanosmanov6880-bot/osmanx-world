"""Atomic local authorization gateway and anti-bypass staged workflow."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from campaign180.contracts import SCHEMA_TASK,SCHEMA_RESULT,validate_result,digest
from campaign180.gateway import TransactionalLocalGateway,AdmissionDenied
from campaign180.workflow import LocalProjectFlow,WorkflowDenied

NOW=1799971200
TENANT='tenant_alpha'
ACTOR='owner-abc'
POLICY={'reader':{'task.read'},'worker':{'task.preview','task.read'}}


def make_task(*,tenant=TENANT,actor=ACTOR,scope='project:alpha'):
    return {"schema":SCHEMA_TASK,"task_id":str(uuid.uuid4()),
            "tenant_id":tenant,"actor_id":actor,"capability":"task.preview",
            "issued_at":NOW-1,"expires_at":NOW+350,
            "idempotency_key":"gateway-"+uuid.uuid4().hex,
            "resource_scopes":[scope],"body":{"operation":"local-check"}}


def result_for(envelope,when=NOW+1):
    raw={"schema":SCHEMA_RESULT,"result_id":str(uuid.uuid4()),
         "task_id":envelope["task_id"],"task_digest":digest(envelope),
         "tenant_id":envelope["tenant_id"],"status":"ok","completed_at":when,
         "body":{"side_effects":False},"error_code":None}
    return validate_result(raw,task={"task":envelope,"digest":digest(envelope)},now=when)


class GatewayTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.root=Path(temp.name)
        self.gateway=TransactionalLocalGateway(self.root/'combined.sqlite',POLICY)
        self.gateway.access.provision(TENANT,ACTOR,'worker',now=NOW)
        self.gateway.access.grant_scope(TENANT,ACTOR,'task.preview','project:alpha',
                                        now=NOW,expires_at=NOW+220)

    def admit(self,task=None):
        return self.gateway.admit(task or make_task(),
                                  authenticated_tenant=TENANT,
                                  authenticated_actor=ACTOR,now=NOW)

    def test_atomic_admit_reserve_finish_and_duplicate_result(self):
        task=make_task()
        self.assertEqual(self.admit(task),'ADMITTED_GUARDED_LOCAL_ONLY')
        self.assertEqual(self.admit(task),'DUPLICATE_GUARDED_LOCAL_ONLY')
        lease=self.gateway.reserve(worker_id='local-worker',now=NOW)
        self.assertEqual(lease.task,task)
        result=result_for(task)
        self.assertEqual(self.gateway.finish(lease,result,now=NOW+1),
                         'FINISHED_GUARDED_LOCAL_ONLY')
        self.assertEqual(self.gateway.finish(lease,result,now=NOW+1),
                         'ALREADY_FINISHED_GUARDED_LOCAL_ONLY')
        self.assertEqual(self.gateway.counts(TENANT)['done'],1)

    def test_untrusted_envelope_cannot_spoof_server_identity(self):
        with self.assertRaises(ValueError):
            self.admit(make_task(tenant='tenant_other'))
        with self.assertRaises(ValueError):
            self.admit(make_task(actor='attacker'))
        with self.assertRaises(ValueError):
            self.admit({'authorization':'LOCAL_DIRECTORY_POLICY_ONLY'})

    def test_ungranted_capability_or_scope_never_enqueued(self):
        with self.assertRaises(ValueError):
            self.admit(make_task(scope='project:foreign'))
        self.assertEqual(self.gateway.counts(TENANT)['ready'],0)

    def test_revocation_before_reserve_deadletters_instead_of_running(self):
        self.admit()
        self.gateway.access.revoke_scope(TENANT,ACTOR,'task.preview','project:alpha',now=NOW+1)
        self.assertIsNone(self.gateway.reserve(worker_id='local-worker',now=NOW+2))
        self.assertEqual(self.gateway.counts(TENANT)['dead'],1)

    def test_revocation_during_lease_blocks_result(self):
        self.admit()
        lease=self.gateway.reserve(worker_id='local-worker',now=NOW)
        self.gateway.access.revoke_member(TENANT,ACTOR,now=NOW+1)
        with self.assertRaises(AdmissionDenied):
            self.gateway.finish(lease,result_for(lease.task),now=NOW+2)

    def test_expiring_grant_fails_reserve(self):
        self.admit()
        self.assertIsNone(self.gateway.reserve(worker_id='local-worker',now=NOW+221))
        self.assertEqual(self.gateway.counts(TENANT)['dead'],1)

    def test_reprovision_does_not_resurrect_old_authorization(self):
        self.admit()
        self.gateway.access.provision(TENANT,ACTOR,'worker',now=NOW+1)
        self.gateway.access.grant_scope(TENANT,ACTOR,'task.preview','project:alpha',
                                        now=NOW+1,expires_at=NOW+200)
        self.assertIsNone(self.gateway.reserve(worker_id='local-worker',now=NOW+2))
        self.assertEqual(self.gateway.counts(TENANT)['dead'],1)

    def test_stale_lease_fence_rejected_after_crash(self):
        self.admit()
        old=self.gateway.reserve(worker_id='worker-old',now=NOW,lease_seconds=5)
        self.gateway.recover_expired(now=NOW+5)
        new=self.gateway.reserve(worker_id='worker-new',now=NOW+6)
        self.assertEqual(new.fence,old.fence+1)
        with self.assertRaises(ValueError):
            self.gateway.finish(old,result_for(old.task),now=NOW+6)

    def test_concurrent_lease_only_one_winner(self):
        self.admit()
        with ThreadPoolExecutor(max_workers=10) as pool:
            outcomes=list(pool.map(lambda _:self.gateway.reserve(worker_id='worker-xyz',now=NOW),
                                   range(10)))
        self.assertEqual(sum(v is not None for v in outcomes),1)

    def test_tenant_isolation_same_actor_does_not_inherit_scope(self):
        self.gateway.access.provision('tenant_other',ACTOR,'worker',now=NOW)
        with self.assertRaises(ValueError):
            self.gateway.admit(make_task(tenant='tenant_other'),
                authenticated_tenant='tenant_other',authenticated_actor=ACTOR,now=NOW)
        self.assertEqual(self.gateway.counts('tenant_other')['ready'],0)

    def test_unverified_authorization_mapping_does_not_match_gateway_input(self):
        fake={'task':make_task(),'digest':'a'*64,'authorization':'LOCAL_DIRECTORY_POLICY_ONLY'}
        with self.assertRaises(ValueError):
            self.admit(fake)

    def test_modified_persisted_task_is_denied_without_execution(self):
        self.admit()
        with sqlite3.connect(self.root/'combined.sqlite') as db:
            db.execute("UPDATE local_jobs SET task_json='{}' WHERE tenant=?",(TENANT,))
        self.assertIsNone(self.gateway.reserve(worker_id='worker-xyz',now=NOW))
        self.assertEqual(self.gateway.counts(TENANT)['dead'],1)


class FlowTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.db=Path(temp.name)/'flows.sqlite'
        self.flow=LocalProjectFlow(self.db)
        self.pid=str(uuid.uuid4())
        self.flow.create(tenant=TENANT,project_id=self.pid,owner=ACTOR,
                         brief={'objective':'prototype'},now=NOW)

    def transit(self,operation,version,evidence,actor=ACTOR):
        return self.flow.transition(tenant=TENANT,project_id=self.pid,
                                    actor=actor,expected_version=version,
                                    operation=operation,evidence=evidence,now=NOW+version)

    def test_full_provenance_chain_produces_candidate_not_deploy(self):
        self.transit('spec',1,{'requirements':['testable']})
        code={'commit':'a'*40}
        self.transit('code',2,code)
        result=self.transit('approve',3,{'reviewed_content_digest':digest(code),
                                       'finding':'pass'},actor='reviewer-xyz')
        self.assertEqual(result['stage'],'reviewed')
        candidate=self.transit('candidate',4,{'summary':'ready for separate review'})
        self.assertEqual(candidate['stage'],'release_candidate')
        self.assertFalse(candidate['production_release'])
        checked=self.flow.inspect(tenant=TENANT,project_id=self.pid)
        self.assertTrue(checked['chain_verified'])
        self.assertFalse(checked['independent_acceptance'])
        self.assertEqual(checked['version'],5)

    def test_skipping_spec_or_review_fails_closed(self):
        with self.assertRaises(WorkflowDenied):
            self.transit('code',1,{'code':'skip'})
        with self.assertRaises(WorkflowDenied):
            self.transit('candidate',1,{'release':True})

    def test_review_own_work_and_inaccurate_digest_denied(self):
        self.transit('spec',1,{'req':'a'})
        self.transit('code',2,{'commit':'a'*40})
        with self.assertRaises(WorkflowDenied):
            self.transit('approve',3,{'reviewed_content_digest':digest({'commit':'a'*40})})
        with self.assertRaises(WorkflowDenied):
            self.transit('approve',3,{'reviewed_content_digest':'f'*64},actor='reviewer-xyz')
        self.assertEqual(self.flow.inspect(tenant=TENANT,project_id=self.pid)['version'],3)

    def test_old_revision_cannot_overwrite(self):
        self.transit('spec',1,{'spec':'first'})
        with self.assertRaises(WorkflowDenied):
            self.transit('spec',1,{'spec':'second'})

    def test_cross_tenant_project_invisible(self):
        with self.assertRaises(WorkflowDenied):
            self.flow.inspect(tenant='tenant_other',project_id=self.pid)
        with self.assertRaises(WorkflowDenied):
            self.flow.transition(tenant='tenant_other',project_id=self.pid,
                                 actor=ACTOR,expected_version=1,
                                 operation='spec',evidence={},now=NOW)

    def test_history_tampering_detected(self):
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE local_project_events SET content_digest=? WHERE tenant=?",
                       ('0'*64,TENANT))
        with self.assertRaises(WorkflowDenied):
            self.flow.inspect(tenant=TENANT,project_id=self.pid)

    def test_rejected_review_can_be_revised(self):
        self.transit('spec',1,{'req':'spec'})
        code={'patch':'first'}
        self.transit('code',2,code)
        self.transit('reject',3,{'reviewed_content_digest':digest(code),
                                 'reason':'tests missing'},actor='reviewer-xyz')
        revised=self.transit('revise',4,{'patch':'fixed'})
        self.assertEqual(revised['stage'],'code')
        self.assertEqual(self.flow.inspect(tenant=TENANT,project_id=self.pid)['version'],5)

    def test_content_rejects_secrets_and_unknown_actor(self):
        with self.assertRaises(WorkflowDenied):
            self.transit('spec',1,{'api_key':'secret'})
        with self.assertRaises(WorkflowDenied):
            self.transit('spec',1,{'good':'value'},actor='reviewer-xyz')

    def test_same_project_id_cannot_be_recreated(self):
        with self.assertRaises(WorkflowDenied):
            self.flow.create(tenant=TENANT,project_id=self.pid,owner=ACTOR,
                             brief={'objective':'duplicate'},now=NOW)


if __name__=="__main__":
    unittest.main()
