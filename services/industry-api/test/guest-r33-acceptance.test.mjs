import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdtemp,writeFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {R32_PIN,evaluateR33Source} from '../src/guest-r33-source.mjs';
import {r33SignedBytes} from '../src/guest-r33-signatures.mjs';
import {R33_STAGE_SCHEMA,R33_STAGE_DOMAIN,R33_STAGE_ROLES,
  evaluateR33Staging} from '../src/guest-r33-staging-witness.mjs';
import {R33_ROLLBACK_SCHEMA,R33_STEPS,makeR33RollbackLedger,
  verifyR33RollbackLedger} from '../src/guest-r33-rollback-ledger.mjs';
import {R33_PRIVACY_SCHEMA,R33_PRIVACY_DOMAIN,R33_PRIVACY_ROLES,
  evaluateR33Privacy} from '../src/guest-r33-privacy.mjs';
import {evaluateR33ProofBundle} from '../src/guest-r33-proof-bundle.mjs';
import {runR33OfflineReview} from '../scripts/r33-offline-review.mjs';
import {R30_ORIGINS,R30_PROBES,makeR30ProbeSnapshot}
  from '../src/guest-r30-probe.mjs';
import {buildR27SyntheticCase,runR27FirstClientRehearsal}
  from '../src/guest-r27-rehearsal.mjs';
import {makeR27Handoff} from '../src/guest-r27-handoff.mjs';
import {evaluateR28ManualGate} from '../src/guest-r28-stage-gate.mjs';
import {makeR28OperatorPacket} from '../src/guest-r28-operator-packet.mjs';
import {makeR29Report} from '../src/guest-r29-report.mjs';
import {makeR30Report} from '../src/guest-r30-report.mjs';
import {makeR31OperatorReport} from '../src/guest-r31-report.mjs';
import {makeR32Readiness} from '../src/guest-r32-report.mjs';
import {makeR33Readiness,verifyR33Readiness,r33ReadinessCsv}
  from '../src/guest-r33-report.mjs';

const NOW=new Date('2026-11-19T12:00:00.000Z');
const TENANT=randomUUID(),PILOT=randomUUID(),CHANGE=randomUUID();
const sha=s=>createHash('sha256').update(s).digest('hex');
const TREE='b'.repeat(40);
function sourceFixture(){
  const ids=[47,48,49,51,52,53,54,55,56,57,58,59,60,61,62,64,65,66];
  const prior={schema:'osmanx.guest.r32.eighteen-pr-review.v1',
    sourcePrsRequired:18,observedPrs:18,mainSha:'a'.repeat(40),
    allHumanMerged:false,humanSequence:ids.map((pr,i)=>({
      order:i+1,pr,sourceSha:pr===66?
        '0e39e243162dd48c84eb790539d97439e969a65a':
        'a'.repeat(40),reviewedAndMerged:false
    }))};
  const pr={number:67,head:{ref:R32_PIN.head,sha:R32_PIN.sha},
    base:{ref:R32_PIN.base},state:'open',merged:false,draft:true};
  const checks=R32_PIN.jobs.map(name=>({name,head_sha:R32_PIN.sha,
    status:'completed',conclusion:'success'}));
  return {prior,pr,checks,ancestry:{base:R32_PIN.parent,
    head:R32_PIN.sha,status:'ahead'},
    releaseCommit:{sha:R32_PIN.sha,tree:{sha:TREE}},
    mainCommit:{sha:'a'.repeat(40),tree:{sha:'c'.repeat(40)}}};
}
function probes(at){
  return R30_ORIGINS.flatMap(origin=>R30_PROBES.map(probe=>({
    origin,probe,method:'GET',
    httpStatus:['live','ready'].includes(probe)?200:401,
    redirected:false,requestHadCredentials:false,
    responseBodyStored:false,observedAt:at
  })));
}
function snapshot(at){
  return makeR30ProbeSnapshot({pilotId:PILOT,releaseCommit:R32_PIN.sha,
    observations:probes(at),source:'operator-claimed',now:new Date(at)});
}
function stageFixture(){
  return {
    schema:R33_STAGE_SCHEMA,tenantId:TENANT,pilotId:PILOT,
    releaseSha:R32_PIN.sha,sourceTreeSha:TREE,
    origin:'https://staging.osmanx.world',
    tlsCertSha256:sha('claimed staging cert'),
    dnsAnswerSha256:sha('claimed dns rrset'),
    first:snapshot('2026-11-19T11:58:00.000Z'),
    second:snapshot('2026-11-19T11:59:00.000Z'),
    issuedAt:'2026-11-19T11:57:00.000Z',
    expiresAt:'2026-11-19T12:05:00.000Z'
  };
}
function rollbackFixture(){
  const target='industry_dr_r33_trial123';
  const actor={release_manager:'release01',
    recovery_lead:'recovery01',independent_auditor:'auditor01'};
  const roles=['release_manager','recovery_lead','recovery_lead',
    'independent_auditor','release_manager'];
  const events=R33_STEPS.map((step,i)=>({
    seq:i+1,step,actorRole:roles[i],actorId:actor[roles[i]],target,
    at:new Date(Date.parse('2026-11-19T11:58:00.000Z')+
      i*15000).toISOString(),
    status:i===4?'aborted':'pass'
  }));
  return makeR33RollbackLedger({
    tenantId:TENANT,pilotId:PILOT,changeId:CHANGE,
    sourceTreeSha:TREE,target,issuedAt:'2026-11-19T11:57:00.000Z',
    events
  });
}
function privacyFixture(){
  return {schema:R33_PRIVACY_SCHEMA,tenantId:TENANT,pilotId:PILOT,
    changeId:CHANGE,releaseSha:R32_PIN.sha,sourceTreeSha:TREE,
    purpose:'guest_experience_aggregate',retentionDays:14,
    source:'operator-claimed',
    onlyAggregatedMetrics:true,noPersonalIdentifiers:true,
    noThirdPartyExport:true,
    deletionPlanSha:sha('plan'),
    privacyNoticeSha:sha('notice'),
    processorAgreementSha:sha('processor agreement'),
    clientAgreementSha:sha('client agreement'),
    lawfulBasisAssessmentSha:sha('lawful basis review'),
    issuedAt:'2026-11-19T11:57:00.000Z',
    expiresAt:'2026-11-19T12:05:00.000Z'
  };
}
function signSet(packet,roles,domain,keys){
  return roles.map((role,i)=>{
    const rec={role,keyId:keys[role].keyId,decision:'reviewed',
      observedAt:'2026-11-19T11:59:30.000Z',
      nonce:sha(role).slice(0,32)};
    return {...rec,signature:sign(null,r33SignedBytes({
      domain,payload:packet,receipt:rec
    }),keys[role].privateKey).toString('base64')};
  });
}
function signedEvidence(){
  const keys=Object.fromEntries([
    ...R33_STAGE_ROLES,...R33_PRIVACY_ROLES
  ].map((role,i)=>{
    const {publicKey,privateKey}=generateKeyPairSync('ed25519');
    return [role,{publicKey,privateKey,keyId:'signedrole'+i}];
  }));
  const staging=stageFixture(),privacy=privacyFixture();
  const publicKeys=Object.fromEntries(Object.keys(keys).map(role=>
    [role,{keyId:keys[role].keyId,publicKey:keys[role].publicKey}]));
  const evidence={
    source:evaluateR33Source(sourceFixture()),staging,
    stagingReceipts:signSet(staging,R33_STAGE_ROLES,R33_STAGE_DOMAIN,keys),
    rollback:rollbackFixture(),privacy,
    privacyReceipts:signSet(privacy,R33_PRIVACY_ROLES,R33_PRIVACY_DOMAIN,keys)
  };
  return {evidence,publicKeys};
}
function r32Report(){
  const {r24,r25,r26,decision}=buildR27SyntheticCase('normal');
  const handoff=makeR27Handoff({r24,r25,r26,audit:decision,
    rehearsal:runR27FirstClientRehearsal(),now:NOW});
  const r28=makeR28OperatorPacket({
    handoff,gate:evaluateR28ManualGate({handoff,now:NOW}),now:NOW});
  const r29=makeR29Report({r28,now:NOW});
  const r30=makeR30Report({r29,now:NOW});
  const r31=makeR31OperatorReport({r30,now:NOW});
  return makeR32Readiness({r31,now:NOW});
}

test('R33 source pins all 19 PRs, exact R32 head and source jobs; never merges main',()=>{
  const f=sourceFixture(),out=evaluateR33Source(f);
  assert.equal(out.sourcePrsRequired,19);
  assert.equal(out.observedPrs,19);
  assert.equal(out.humanSequence.at(-1).pr,67);
  assert.equal(out.firstUnmergedPr,47);
  assert.equal(out.sourceCiPassed,true);
  assert.equal(out.ancestryVerified,true);
  assert.equal(out.productionAuthorized,false);
  assert.equal(out.deployAllowed,false);
  assert.equal(out.postMergeMainCiPassed,false);
  assert.ok(out.blockers.includes('PR67_REQUIRES_MANUAL_MERGE'));
  assert.ok(evaluateR33Source({...f,checks:f.checks.slice(1)})
    .blockers.includes('R32_NAMED_CHECKS_MISSING'));
  assert.ok(evaluateR33Source({...f,pr:{...f.pr,
    head:{...f.pr.head,sha:'f'.repeat(40)}}})
    .blockers.includes('PR67_SOURCE_DRIFT'));
});

test('R33 signed staging binds two independent role keys, two snapshots, DNS/TLS claim digests',()=>{
  const {evidence:e,publicKeys:k}=signedEvidence();
  const good=evaluateR33Staging({packet:e.staging,
    receipts:e.stagingReceipts,publicKeys:k,now:NOW});
  assert.equal(good.pairedProbesHealthy,true,JSON.stringify(good.blockers));
  assert.equal(good.witnessesSigned,true);
  assert.equal(good.actualTlsHandshakeVerified,false);
  assert.equal(good.realStagingIndependentlyVerified,false);
  assert.equal(good.productionAuthorized,false);
  assert.equal(evaluateR33Staging({packet:{...e.staging,
    pilotId:randomUUID()},receipts:e.stagingReceipts,
    publicKeys:k,now:NOW}).pairedProbesHealthy,false);
  assert.equal(evaluateR33Staging({packet:{...e.staging,
    origin:'https://osmanx.world'},receipts:e.stagingReceipts,
    publicKeys:k,now:NOW}).pairedProbesHealthy,false);
  assert.equal(evaluateR33Staging({packet:{...e.staging,
    tlsCertSha256:sha('different')},receipts:e.stagingReceipts,
    publicKeys:k,now:NOW}).pairedProbesHealthy,false);
  assert.equal(evaluateR33Staging({packet:e.staging,
    receipts:[e.stagingReceipts[0],e.stagingReceipts[0]],
    publicKeys:k,now:NOW}).pairedProbesHealthy,false);
  assert.equal(evaluateR33Staging({packet:e.staging,
    receipts:e.stagingReceipts,publicKeys:{},now:NOW}).pairedProbesHealthy,false);
  const leak={...e.staging.second,observations:
    e.staging.second.observations.map((x,i)=>i===2?
      {...x,httpStatus:200}:x)};
  assert.equal(evaluateR33Staging({packet:{...e.staging,second:leak},
    receipts:e.stagingReceipts,publicKeys:k,now:NOW}).pairedProbesHealthy,false);
});

test('R33 disposable rollback SHA-chain rejects reordered, edited, wrong target and shared actors',()=>{
  const log=rollbackFixture();
  const good=verifyR33RollbackLedger(log,{tenantId:TENANT,pilotId:PILOT,now:NOW});
  assert.equal(good.rehearsalMetadataPass,true,JSON.stringify(good.blockers));
  assert.equal(good.liveRollbackExecuted,false);
  assert.equal(good.productionAuthorized,false);
  assert.equal(verifyR33RollbackLedger({...log,target:'industry_ci'},
    {tenantId:TENANT,pilotId:PILOT,now:NOW}).rehearsalMetadataPass,false);
  assert.equal(verifyR33RollbackLedger({...log,events:
    log.events.map((x,i)=>i===2?{...x,status:'pass!',}:x)},
    {tenantId:TENANT,pilotId:PILOT,now:NOW}).rehearsalMetadataPass,false);
  assert.equal(verifyR33RollbackLedger({...log,finalSha:'f'.repeat(64)},
    {tenantId:TENANT,pilotId:PILOT,now:NOW}).rehearsalMetadataPass,false);
  assert.equal(verifyR33RollbackLedger(log,{
    tenantId:randomUUID(),pilotId:PILOT,now:NOW}).rehearsalMetadataPass,false);
  const shared=makeR33RollbackLedger({...log,events:log.events.map(x=>({
    seq:x.seq,step:x.step,actorRole:x.actorRole,
    actorId:'oneactor',target:x.target,at:x.at,status:x.status
  }))});
  assert.equal(verifyR33RollbackLedger(shared,{tenantId:TENANT,
    pilotId:PILOT,now:NOW}).rehearsalMetadataPass,false);
});

test('R33 privacy policy is aggregate-only and signed by client and independent reviewer',()=>{
  const {evidence:e,publicKeys:k}=signedEvidence();
  const good=evaluateR33Privacy({packet:e.privacy,
    receipts:e.privacyReceipts,publicKeys:k,now:NOW});
  assert.equal(good.metadataAndSignaturesValid,true,JSON.stringify(good.blockers));
  assert.equal(good.lawfulBasisIndependentlyVerified,false);
  assert.equal(good.customerDataCollected,false);
  for(const delta of [{retentionDays:365},{noPersonalIdentifiers:false},
    {noThirdPartyExport:false},{purpose:'advertising'},
    {clientAgreementSha:'f'.repeat(64)}, {pilotId:randomUUID()}]){
    assert.equal(evaluateR33Privacy({packet:{...e.privacy,...delta},
      receipts:e.privacyReceipts,publicKeys:k,now:NOW})
      .metadataAndSignaturesValid,false,JSON.stringify(delta));
  }
  assert.equal(evaluateR33Privacy({packet:e.privacy,
    receipts:e.privacyReceipts,publicKeys:k,
    now:new Date(e.privacy.expiresAt)}).metadataAndSignaturesValid,false);
});

test('R33 four-key bundle binds source, staging, rollback and privacy; always NO-GO',()=>{
  const {evidence,publicKeys}=signedEvidence();
  const good=evaluateR33ProofBundle({evidence,publicKeys,now:NOW});
  assert.equal(good.humanReviewQueueEligible,true,JSON.stringify(good.blockers));
  assert.equal(good.independentMetadataBindingsPass,true);
  assert.equal(good.productionAuthorized,false);
  assert.equal(good.actualExternalVpsVerified,false);
  assert.equal(good.lawfulBasisVerified,false);
  assert.equal(evaluateR33ProofBundle({evidence:{...evidence,
    privacy:{...evidence.privacy,changeId:randomUUID()}},
    publicKeys,now:NOW}).humanReviewQueueEligible,false);
  assert.equal(evaluateR33ProofBundle({evidence,publicKeys:{
    ...publicKeys,privacy_reviewer:publicKeys.staging_operator
  },now:NOW}).humanReviewQueueEligible,false);
  assert.equal(evaluateR33ProofBundle({evidence:{...evidence,
    source:{...evidence.source,sourceTreeSha:'a'.repeat(40)}},
    publicKeys,now:NOW}).humanReviewQueueEligible,false);
  assert.equal(evaluateR33ProofBundle({evidence:{...evidence,
    unexpectedSensitiveField:'someone@email.test'},
    publicKeys,now:NOW}).humanReviewQueueEligible,false);
});

test('R33 offline CLI requires independent pinned file and produces only NO-GO summary',async()=>{
  const {evidence,publicKeys}=signedEvidence();
  const directory=await mkdtemp(join(tmpdir(),'r33-keys-'));
  const trustFile=join(directory,'trusted-public-keys.json');
  try{
    const keys=Object.fromEntries(Object.entries(publicKeys).map(
      ([role,value])=>[role,{keyId:value.keyId,
        publicKey:value.publicKey.export({type:'spki',format:'pem'})}]));
    await writeFile(trustFile,JSON.stringify(keys),{mode:0o600});
    const doc=JSON.stringify(evidence);
    const call=()=>runR33OfflineReview({stream:Readable.from([doc]),
      trustFile,now:NOW});
    const out=await call();
    assert.equal(out.humanReviewQueueEligible,true,JSON.stringify(out.blockers));
    assert.equal(out.productionAuthorized,false);
    assert.equal(out.customerGo,false);
    assert.equal(JSON.stringify(out).includes('PRIVATE KEY'),false);
    await chmod(trustFile,0o666);
    await assert.rejects(call(),/operator-owned/);
    await chmod(trustFile,0o600);
    await assert.rejects(runR33OfflineReview({
      stream:Readable.from(['x'.repeat(256*1024+1)]),
      trustFile,now:NOW
    }),/256 KiB/);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
});

test('R33 tenant packet has 10m inherited expiry, SHA-256 and unconditional NO-GO',()=>{
  const r32=r32Report(),out=makeR33Readiness({r32,now:NOW});
  assert.equal(out.source.prsRequired,19);
  assert.equal(out.productionAuthorized,false);
  assert.equal(out.guestWritesEnabled,false);
  assert.equal(verifyR33Readiness(out,{pilotId:r32.pilotId,now:NOW}).valid,true);
  assert.equal(verifyR33Readiness({...out,customerGo:true},
    {now:NOW}).valid,false);
  assert.equal(verifyR33Readiness({...out,blockers:[]},
    {now:NOW}).valid,false);
  assert.equal(verifyR33Readiness({...out,clientEmail:'real@example.test'},
    {now:NOW}).valid,false);
  assert.equal(verifyR33Readiness(out,{pilotId:randomUUID(),now:NOW}).valid,false);
  assert.equal(verifyR33Readiness(out,{
    now:new Date(out.expiresAt)}).valid,false);
  const csv=r33ReadinessCsv(out,{now:NOW});
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('NO-GO'));
  assert.equal(csv.includes('real@example.test'),false);
});
