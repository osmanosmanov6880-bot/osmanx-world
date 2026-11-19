import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {makeR21Bundle,verifyR21Bundle,BUNDLE_SCHEMA}
  from '../scripts/r21-evidence-bundle.mjs';
import {assembleR21} from '../scripts/r21-assemble.mjs';

function setup(){
  const tenantId=randomUUID(),pilotId=randomUUID();
  const releaseCommit='a'.repeat(40),scopeDigest='b'.repeat(64);
  const now=new Date('2026-11-19T14:00:00.000Z');
  const reports={
    chain:{schema:'osmanx.guest.r21.seven-stage-release.v1',
      stagedCodeVerified:true,allDependenciesMerged:false,
      blockers:['r20_not_merged']},
    host:{schema:'osmanx.guest.r21.host-posture.v1',
      safeIsolatedRehearsal:false,liveHostInspected:false,
      blockers:['host_operatorWitnessPresent'],serverPassword:'TOP_SECRET_DO_NOT_EXPORT'},
    database:{schema:'osmanx.guest.r21.database-posture.v1',
      technicalPostureReady:true,blockers:[],usageRows:1,
      auditEventCount:2,rawGuestEmail:'guest@example.test'},
    restore:{schema:'osmanx.guest.r20.restore-crosscheck.v1',
      technicalRestoreReady:false,blockers:['no_verified_offsite_copy'],
      privateKey:'-----BEGIN PRIVATE KEY-----'},
    ticket:{schema:'osmanx.guest.r20.change-ticket-check.v1',
      valid:false,blockers:['unsigned_human_change'],ticketDigest:null}
  };
  const args={tenantId,pilotId,releaseCommit,scopeDigest,reports,now};
  return {args,now,reports};
}
test('R21 evidence bundle is deterministic, secret-free, tamper-evident and always NO-GO',()=>{
  const {args,now}=setup();
  const a=makeR21Bundle(args),b=makeR21Bundle(args);
  assert.equal(a.schema,BUNDLE_SCHEMA);
  assert.deepEqual(a,b);
  assert.match(a.manifestDigest,/^[0-9a-f]{64}$/);
  const asText=JSON.stringify(a);
  for(const secret of ['TOP_SECRET_DO_NOT_EXPORT','guest@example.test',
    'BEGIN PRIVATE KEY','serverPassword','rawGuestEmail','privateKey'])
    assert.equal(asText.includes(secret),false,secret);
  assert.equal(a.customerGo,false);
  assert.equal(a.productionActivationAllowed,false);
  assert.equal(a.offsiteWormVerified,false);
  assert.ok(a.blockers.includes('release_chain_unmerged_or_changed'));
  const verified=verifyR21Bundle(a,{now,releaseCommit:args.releaseCommit,
    tenantId:args.tenantId,pilotId:args.pilotId,
    scopeDigest:args.scopeDigest});
  assert.equal(verified.valid,true,JSON.stringify(verified.errors));
  assert.equal(verified.customerGo,false);
});
test('R21 altered report, foreign pilot, timestamp or production flag invalidate entire package',()=>{
  const {args,now}=setup();
  const a=makeR21Bundle(args);
  const check=(p,opts={})=>verifyR21Bundle(p,{now,...opts});
  assert.equal(check({...a,tenantId:randomUUID()}).valid,false);
  assert.equal(check({...a,reports:{...a.reports,
    host:{...a.reports.host,safeIsolatedRehearsal:true}}}).valid,false);
  assert.equal(check({...a,manifestDigest:'0'.repeat(64)}).valid,false);
  assert.equal(check({...a,customerGo:true}).valid,false);
  assert.equal(check({...a,blockers:[]}).valid,false);
  assert.equal(check(a,{pilotId:randomUUID()}).valid,false);
  assert.equal(check(a,{now:new Date(now.getTime()+3600001)}).valid,false);
});
test('R21 private assembly never writes a raw source report into export',async()=>{
  const {args,now,reports}=setup(),reads=[],writes=[];
  const pathMap={
    chain:'/private/chain.json',host:'/private/host.json',
    database:'/private/db.json',restore:'/private/dr.json',
    ticket:'/private/ticket.json'};
  const result=await assembleR21({...args,inputPaths:pathMap,
    output:'/private/r21-evidence.json',now,
    reader:async p=>{
      reads.push(p);
      return reports[Object.keys(pathMap).find(k=>pathMap[k]===p)];
    },
    writer:async(path,bundle)=>{
      writes.push({path,bundle});
      return {written:true};
    }
  });
  assert.equal(reads.length,5);
  assert.equal(writes.length,1);
  assert.equal(result.proofIntegrityVerified,true);
  assert.equal(result.customerGo,false);
  assert.equal(result.offsiteUploadPerformed,false);
  assert.equal(writes[0].bundle.reports.database.rawGuestEmail,undefined);
  await assert.rejects(assembleR21({...args,inputPaths:{
    ...pathMap,unexpected:'/private/extra'},output:'/private/e.json',
    reader:async()=>({}),writer:async()=>({written:true})}));
});
