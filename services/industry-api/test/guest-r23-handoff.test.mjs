import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {makeR23Handoff,verifyR23Handoff,HANDOFF_SCHEMA}
  from '../scripts/r23-operator-handoff.mjs';
function fixture(){
  const now=new Date('2026-11-19T16:00:00.000Z');
  const tenantId=randomUUID(),pilotId=randomUUID();
  const releaseCommit='a'.repeat(40),scopeDigest='b'.repeat(64);
  const reports={
    merge:{schema:'osmanx.guest.r23.manual-merge-plan.v1',
      stagedCodeVerified:true,allMerged:false,mainProtected:true,
      mainTipStable:true,sourceHeadSha:releaseCommit,
      blockers:['r22_not_merged'],personalEmail:'operator@private.example'},
    canary:{schema:'osmanx.guest.r23.https-canary-parity.v1',
      technicalCanaryReady:false,blockers:['r23_canary_publicHealthy'],
      authorization:'Bearer SECRET_NOT_TO_EXPORT'},
    tenants:{schema:'osmanx.guest.r23.read-only-rls-rehearsal.v1',
      technicalIsolationPass:true,transactionRolledBack:true,blockers:[]},
    dr:{schema:'osmanx.guest.r22.two-copy-dr-quorum.v1',
      technicalQuorumReady:false,contentsIdentical:false,
      blockers:['second_restore_rejected'],privateKey:'-----BEGIN PRIVATE KEY-----'},
    prior:{schema:'osmanx.guest.r22.independent-preflight.v1',
      tenantId,pilotId,releaseCommit,derivedTechnicalChecksPassed:false,
      blockers:['external_independent_physical_vps_review']}
  };
  return {now,tenantId,pilotId,releaseCommit,scopeDigest,reports};
}
test('R23 packet binds five reports without leaking private text or granting production',()=>{
  const f=fixture(),a=makeR23Handoff(f),b=makeR23Handoff(f);
  assert.deepEqual(a,b);
  assert.equal(a.schema,HANDOFF_SCHEMA);
  assert.match(a.payloadSha,/^[a-f0-9]{64}$/);
  for(const term of ['operator@private.example','SECRET_NOT_TO_EXPORT',
    'BEGIN PRIVATE KEY','personalEmail','authorization','privateKey'])
    assert.equal(JSON.stringify(a).includes(term),false,term);
  assert.equal(a.automaticMergeAllowed,false);
  assert.equal(a.productionAuthorized,false);
  assert.equal(a.customerGo,false);
  assert.ok(a.blockers.includes('handoff_stackMerged'));
  const verification=verifyR23Handoff(a,f);
  assert.equal(verification.valid,true,JSON.stringify(verification.blockers));
});
test('R23 refuses wrong tenant, wrong release, expiry, forged hash or an invented approval',()=>{
  const f=fixture(),base=makeR23Handoff(f);
  for(const altered of [
    {...base,tenantId:randomUUID()},
    {...base,scopeDigest:'c'.repeat(64)},
    {...base,customerGo:true},
    {...base,productionAuthorized:true},
    {...base,payloadSha:'0'.repeat(64)},
    {...base,blockers:[]},
    {...base,reports:{...base.reports,dr:{...base.reports.dr,
      technicalQuorumReady:true}}}
  ])assert.equal(verifyR23Handoff(altered,f).valid,false);
  assert.equal(verifyR23Handoff(base,{
    ...f,now:new Date(f.now.getTime()+31*60000)
  }).valid,false);
  assert.throws(()=>makeR23Handoff({...f,
    reports:{...f.reports,prior:{...f.reports.prior,pilotId:randomUUID()}}}));
});
test('R23 rejects reporter-controlled blocker strings containing secrets or paths',()=>{
  const f=fixture();
  for(const evil of ['Bearer token@example.com','/root/private/id.pem',
    'sudo rm -rf /','_starts_with_underscore','a'.repeat(81)]){
    f.reports.canary.blockers=[evil];
    assert.throws(()=>makeR23Handoff(f),/Unsafe report blockers/);
  }
});
