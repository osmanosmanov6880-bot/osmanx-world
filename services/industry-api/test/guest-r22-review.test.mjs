import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {evaluateR22Readiness,REVIEW_SCHEMA}
  from '../scripts/r22-preflight-review.mjs';
import {makeR21Bundle} from '../scripts/r21-evidence-bundle.mjs';

test('R22 independent review fails closed with missing signature, DR, GitHub and legal evidence',()=>{
  const tenantId=randomUUID(),pilotId=randomUUID();
  const r=evaluateR22Readiness({
    tenantId,pilotId,releaseCommit:'a'.repeat(40),
    scopeDigest:'b'.repeat(64),anchorDigest:'c'.repeat(64),
    now:new Date('2026-11-19T15:00:00.000Z')
  });
  assert.equal(r.schema,REVIEW_SCHEMA);
  assert.equal(r.customerGo,false);
  assert.equal(r.legalGo,false);
  assert.equal(r.productionAuthorized,false);
  assert.equal(r.offsiteWormVerified,false);
  assert.equal(r.productionChanged,false);
  assert.equal(r.derivedTechnicalChecksPassed,false);
  assert.ok(r.blockers.includes('r22_twoRestoredCopiesReported'));
  assert.ok(r.blockers.includes('r22_twoHumanChangeTicket'));
  assert.ok(r.blockers.includes('external_independent_client_consent_contract_review'));
});
test('R22 refuses a forged technical DR success in absence of independent witness and main checks',()=>{
  const r=evaluateR22Readiness({
    tenantId:randomUUID(),pilotId:randomUUID(),
    releaseCommit:'f'.repeat(40),
    scopeDigest:'e'.repeat(64),anchorDigest:'d'.repeat(64),
    drQuorum:{schema:'osmanx.guest.r22.two-copy-dr-quorum.v1',
      technicalQuorumReady:true,contentsIdentical:true,
      isolatedDatabasesDistinct:true,custodyMetadataDistinct:true},
    databaseAudit:{schema:'osmanx.guest.r21.database-posture.v1',
      technicalPostureReady:true,queriesReadOnly:true}
  });
  assert.equal(r.checks.twoRestoredCopiesReported,true);
  assert.equal(r.checks.databaseReadOnlyReport,true);
  assert.equal(r.derivedTechnicalChecksPassed,false);
  assert.equal(r.customerGo,false);
  assert.equal(r.productionChanged,false);
});
test('R22 refuses email, paths, credentials or large arbitrary strings in evidence blocker codes',()=>{
  const tenantId=randomUUID(),pilotId=randomUUID();
  const args={tenantId,pilotId,releaseCommit:'a'.repeat(40),
    scopeDigest:'b'.repeat(64),
    now:new Date('2026-11-19T15:00:00.000Z'),
    reports:{chain:{blockers:['r21_not_merged',
      'Bearer secret-token@example.com']},
      host:{blockers:[]},database:{blockers:[]},
      restore:{blockers:[]},ticket:{blockers:[]}}};
  assert.throws(()=>makeR21Bundle(args),/blocker/);
  args.reports.chain.blockers=['r21_not_merged','/root/private/key.pem'];
  assert.throws(()=>makeR21Bundle(args),/blocker/);
  args.reports.chain.blockers=['r21_not_merged','ok'];
  const b=makeR21Bundle(args);
  assert.equal(JSON.stringify(b).includes('/root/private'),false);
  assert.equal(JSON.stringify(b).includes('secret-token'),false);
});
test('R22 rejects invalid pilot or release before opening any external connection',()=>{
  assert.throws(()=>evaluateR22Readiness({
    tenantId:'fake',pilotId:randomUUID(),
    releaseCommit:'a'.repeat(40),
    scopeDigest:'b'.repeat(64),anchorDigest:'c'.repeat(64)
  }));
});
