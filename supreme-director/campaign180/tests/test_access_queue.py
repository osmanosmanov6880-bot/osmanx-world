"""TITAN identity/RBAC and local durable queue negative + recovery integration."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
import uuid

from campaign180.access import AccessDenied, AccessDirectory
from campaign180.queue import DurableLocalQueue, QueueDenied
from campaign180.contracts import SCHEMA_TASK,SCHEMA_RESULT,validate_result,digest

NOW = 1799971200
TENANT = 'tenant_alpha'
ACTOR = 'owner-abc'
ROLES = {'reader':{'task.read'},'operator':{'task.read','task.preview'}}


def task(*, tenant=TENANT, actor=ACTOR, scope='project:alpha', idem=None, expires=None):
    return dict(schema=SCHEMA_TASK,task_id=str(uuid.uuid4()),tenant_id=tenant,actor_id=actor,
                capability='task.preview',issued_at=NOW-4,
                expires_at=expires or NOW+240,
                idempotency_key=idem or ('local-queue-'+uuid.uuid4().hex),
                resource_scopes=[scope],body={'intent':'dry-run'})


def result_for(authorized, *, when=NOW+1):
    t=authorized['task']
    raw=dict(schema=SCHEMA_RESULT,result_id=str(uuid.uuid4()),task_id=t['task_id'],
             task_digest=authorized['digest'],tenant_id=t['tenant_id'],
             status='ok',completed_at=when,body={'executed':False},error_code=None)
    return validate_result(raw,task=authorized,now=when)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.directory=AccessDirectory(self.root/'access.db',ROLES)
        self.directory.provision(TENANT,ACTOR,'operator',now=NOW)
        self.directory.grant_scope(TENANT,ACTOR,'task.preview','project:alpha',
                                   now=NOW,expires_at=NOW+200)
        self.queue=DurableLocalQueue(self.root/'jobs.db',max_attempts=3)

    def approve(self, envelope=None, *, tenant=TENANT, actor=ACTOR, now=NOW):
        return self.directory.authorize_local(envelope or task(),authenticated_tenant=tenant,
                                               authenticated_actor=actor,now=now)

    def test_role_and_scope_valid_envelope_but_not_execution_authority(self):
        authorized=self.approve()
        self.assertEqual(authorized['authorization'],'LOCAL_DIRECTORY_POLICY_ONLY')
        self.assertFalse(authorized['external_execution_permitted'])
        self.assertGreaterEqual(authorized['member_revision'],2)

    def test_unknown_member_and_undeclared_role_denied(self):
        with self.assertRaises(AccessDenied):
            self.approve(actor='unknown-actor')
        with self.assertRaises(AccessDenied):
            self.directory.provision(TENANT,ACTOR,'superuser',now=NOW)

    def test_member_role_cannot_grant_unlisted_capability(self):
        self.directory.provision(TENANT,ACTOR,'reader',now=NOW)
        with self.assertRaises(AccessDenied):
            self.directory.grant_scope(TENANT,ACTOR,'task.preview','project:alpha',
                                       now=NOW,expires_at=NOW+100)
        with self.assertRaises(ValueError):
            self.approve()

    def test_missing_and_expired_scopes_denied(self):
        with self.assertRaises(ValueError):
            self.approve(task(scope='project:other'))
        with self.assertRaises(ValueError):
            self.approve(now=NOW+201)

    def test_member_revocation_and_reprovision_clear_grants(self):
        self.directory.revoke_member(TENANT,ACTOR,now=NOW+1)
        with self.assertRaises(AccessDenied):
            self.approve(now=NOW+2)
        self.directory.provision(TENANT,ACTOR,'operator',now=NOW+2)
        with self.assertRaises(ValueError):
            self.approve(now=NOW+3)

    def test_scope_revocation_is_immediate_for_new_admissions(self):
        self.directory.revoke_scope(TENANT,ACTOR,'task.preview','project:alpha',now=NOW+1)
        with self.assertRaises(ValueError):
            self.approve(now=NOW+1)

    def test_server_identity_cannot_be_overridden_by_body(self):
        with self.assertRaises(ValueError):
            self.approve(task(tenant='tenant_other'))
        with self.assertRaises(ValueError):
            self.approve(task(actor='attacker'))

    def test_same_actor_in_different_tenant_has_no_implicit_access(self):
        self.directory.provision('tenant_other',ACTOR,'operator',now=NOW)
        with self.assertRaises(ValueError):
            self.approve(task(tenant='tenant_other'),tenant='tenant_other')

    def test_role_downgrade_invalidates_old_grants(self):
        self.directory.provision(TENANT,ACTOR,'reader',now=NOW+1)
        with self.assertRaises(ValueError):
            self.approve(now=NOW+2)

    def test_malformed_policy_and_grants_fail_closed(self):
        with self.assertRaises(AccessDenied):
            AccessDirectory(self.root/'wrong.db',{'reader':{'*'}})
        with self.assertRaises(AccessDenied):
            self.directory.grant_scope(TENANT,ACTOR,'task.preview','project:alpha',
                                       now=NOW,expires_at=NOW+9999999)

    def test_no_enqueue_without_directory_authorization(self):
        with self.assertRaises(QueueDenied):
            self.queue.enqueue({'task':task(),'digest':'bad'},now=NOW)

    def test_persist_duplicate_and_collision(self):
        a=self.approve()
        self.assertEqual(self.queue.enqueue(a,now=NOW),'QUEUED_LOCAL_ONLY')
        self.assertEqual(self.queue.enqueue(a,now=NOW),'DUPLICATE_LOCAL_ONLY')
        other=deepcopy(a)
        other['task']['body']['intent']='tampered'
        other['digest']=digest(other['task'])
        with self.assertRaises(QueueDenied):
            self.queue.enqueue(other,now=NOW)
        self.assertEqual(DurableLocalQueue(self.root/'jobs.db').counts(TENANT)['ready'],1)

    def test_lease_reservation_is_atomic_and_local_only(self):
        self.queue.enqueue(self.approve(),now=NOW)
        with ThreadPoolExecutor(max_workers=12) as pool:
            leases=list(pool.map(lambda _:self.queue.reserve(worker_id='worker-01',now=NOW),range(12)))
        self.assertEqual(sum(x is not None for x in leases),1)
        self.assertIsNone(self.queue.reserve(worker_id='worker-02',now=NOW))

    def test_crashed_worker_requeued_and_stale_fence_rejected(self):
        authorized=self.approve()
        self.queue.enqueue(authorized,now=NOW)
        first=self.queue.reserve(worker_id='worker-01',now=NOW,lease_seconds=10)
        self.assertEqual(self.queue.recover_expired(now=NOW+5)['requeued'],0)
        self.assertEqual(self.queue.recover_expired(now=NOW+10)['requeued'],1)
        newer=self.queue.reserve(worker_id='worker-02',now=NOW+11)
        self.assertEqual(newer.fence,first.fence+1)
        with self.assertRaises(QueueDenied):
            self.queue.record_result(first,result_for(authorized),now=NOW+11)
        self.assertEqual(self.queue.counts(TENANT)['leased'],1)

    def test_retry_delay_and_attempts_limit(self):
        a=self.approve()
        self.queue.enqueue(a,now=NOW)
        for attempt in range(1,4):
            lease=self.queue.reserve(worker_id='worker-01',now=NOW+attempt)
            self.assertIsNotNone(lease)
            self.assertEqual(lease.attempt,attempt)
            result=self.queue.retry(lease,now=NOW+attempt,delay_seconds=0)
        self.assertEqual(result,'DEAD_LOCAL_ONLY')
        self.assertIsNone(self.queue.reserve(worker_id='worker-02',now=NOW+5))
        self.assertEqual(self.queue.counts(TENANT)['dead'],1)

    def test_expired_tasks_deadletter_without_dispatch(self):
        a=self.approve(task(expires=NOW+5))
        self.queue.enqueue(a,now=NOW)
        self.assertEqual(self.queue.recover_expired(now=NOW+5)['dead'],1)
        self.assertIsNone(self.queue.reserve(worker_id='worker-01',now=NOW+5))

    def test_record_result_idempotently_without_rewriting(self):
        a=self.approve()
        self.queue.enqueue(a,now=NOW)
        lease=self.queue.reserve(worker_id='worker-01',now=NOW)
        verified=result_for(a)
        self.assertEqual(self.queue.record_result(lease,verified,now=NOW+1),
                         'RESULT_RECORDED_LOCAL_ONLY')
        self.assertEqual(self.queue.record_result(lease,verified,now=NOW+1),
                         'ALREADY_RECORDED_LOCAL_ONLY')
        other=result_for(a)
        with self.assertRaises(QueueDenied):
            self.queue.record_result(lease,other,now=NOW+1)
        self.assertEqual(self.queue.counts(TENANT)['done'],1)

    def test_result_mutation_and_expired_lease_denied(self):
        a=self.approve()
        self.queue.enqueue(a,now=NOW)
        lease=self.queue.reserve(worker_id='worker-01',now=NOW,lease_seconds=5)
        bad=result_for(a);bad['result']['body']['executed']=True
        with self.assertRaises(QueueDenied):
            self.queue.record_result(lease,bad,now=NOW+1)
        with self.assertRaises(QueueDenied):
            self.queue.record_result(lease,result_for(a,when=NOW+6),now=NOW+6)

    def test_expired_last_lease_goes_dead_not_stuck(self):
        a=self.approve()
        self.queue.enqueue(a,now=NOW)
        q=DurableLocalQueue(self.root/'jobs.db',max_attempts=1)
        q.reserve(worker_id='worker-01',now=NOW,lease_seconds=5)
        self.assertEqual(q.recover_expired(now=NOW+6)['dead'],1)
        self.assertEqual(q.counts(TENANT)['dead'],1)

    def test_counts_cannot_leak_other_tenant(self):
        self.queue.enqueue(self.approve(),now=NOW)
        self.assertEqual(self.queue.counts(TENANT)['ready'],1)
        self.assertEqual(self.queue.counts('tenant_other')['ready'],0)
        with self.assertRaises(QueueDenied):
            self.queue.counts('')

    def test_lease_cannot_be_completed_by_different_worker(self):
        a=self.approve()
        self.queue.enqueue(a,now=NOW)
        from dataclasses import replace
        lease=self.queue.reserve(worker_id='worker-01',now=NOW)
        with self.assertRaises(QueueDenied):
            self.queue.record_result(replace(lease,worker_id='worker-02'),
                                     result_for(a),now=NOW+1)


if __name__ == '__main__':
    unittest.main()
