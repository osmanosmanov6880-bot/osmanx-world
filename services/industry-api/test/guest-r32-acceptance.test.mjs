import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {R31_PIN,evaluateR32Source} from '../src/guest-r32-source.mjs';
import {R32_WINDOW_SCHEMA,R32_APPROVERS,r32WindowSigningBytes,
  verifyR32ChangeWindow} from '../src/guest-r32-change-window.mjs';
import {makeR30ProbeSnapshot,R30_ORIGINS,R30_PROBES}
  from '../src/guest-r30-probe.mjs';
import {evaluateR32StagingDrift} from '../src/guest-r32-staging-drift.mjs';
import {makeR31DrRehearsal} from '../src/guest-r31-dr-review.mjs';
import {R32_RECOVERY_SCHEMA,assessR32RecoveryObjectives}
  from '../src/guest-r32-recovery-objectives.mjs';
import {evaluateR32Preflight} from '../src/guest-r32-preflight.mjs';
import {buildR27SyntheticCase,runR27FirstClientRehearsal}
  from '../src/guest-r27-rehearsal.mjs';
import {makeR27Handoff} from '../src/guest-r27-handoff.mjs';
import {evaluateR28ManualGate} from '../src/guest-r28-stage-gate.mjs';
import {makeR28OperatorPacket} from '../src/guest-r28-operator-packet.mjs';
import {makeR29Report} from '../src/guest-r29-report.mjs';
import {makeR30Report} from '../src/guest-r30-report.mjs';
import {makeR31OperatorReport} from '../src/guest-r31-report.mjs';
import {makeR32Readiness,verifyR32Readiness,r32ReadinessCsv}
  from '../src/guest-r32-report.mjs';
const now=new Date('2026-11-19T12:00:00.000Z');
const pilotId=randomUUID(),tenantId=randomUUID();
const sha=x=>createHash('sha256').update(x).digest('hex');
const stamp=s=>new Date(s).toISOString();
function sourceFixture(){
  const prior={schema:'osmanx.guest.r31.seventeen-source-review.v1',
    sourcePrsRequired:17,observedPrs:17,
    mainSha:'a'.repeat(40),allMerged:false,
    humanSequence:[47,48,49,51,52,53,54,55,56,57,58,59,60,61,62,64,65]
      .map((pr,i)=>({pr,order:i+1,
        sourceSha:pr===65?'658bc5ac937e088d7a9d50b7946426d2b82b92f4':
          'a'.repeat(40),reviewedAndMerged:false}))
  };
  const pr={number:66,head:{ref:R31_PIN.head,sha:R31_PIN.sha},
    base:{ref:R31_PIN.base},draft:true,merged:false,state:'open'};
  const checks=R31_PIN.jobs.map(name=>({name,head_sha:R31_PIN.sha,
    status:'completed',conclusion:'success'}));
  return {prior,pr,checks,
    ancestry:{base:R31_PIN.parent,head:R31_PIN.sha,status:'ahead'},
    releaseCommit:{sha:R31_PIN.sha,tree:{sha:'b'.repeat(40)}},
    mainCommit:{sha:'a'.repeat(40),tree:{sha:'c'.repeat(40)}}};
}
function observations(at){
  return R30_ORIGINS.flatMap(origin=>R30_PROBES.map(probe=>({
    origin,probe,method:'GET',
    httpStatus:['live','ready'].includes(probe)?200:401,
    redirected:false,requestHadCredentials:false,
    responseBodyStored:false,observedAt:at
  })));
}
function snapshots(){
  const ta='2026-11-19T11:58:00.000Z',
    tb='2026-11-19T11:59:00.000Z';
  return {
    first:makeR30ProbeSnapshot({pilotId,releaseCommit:R31_PIN.sha,
      observations:observations(ta),source:'operator-claimed',now:new Date(ta)}),
    second:makeR30ProbeSnapshot({pilotId,releaseCommit:R31_PIN.sha,
      observations:observations(tb),source:'operator-claimed',now:new Date(tb)})
  };
}
function drFixture(){
  const at='2026-11-19T11:58:00.000Z';
  const copies=['A','B'].map((copyId,i)=>({
    copyId,archiveSha:sha('archive-'+copyId),
    keyFingerprint:sha('key-'+copyId),
    restoredChecksum:sha('identical recovered rows'),
    restoredRows:12,restoreTarget:'industry_dr_r31_testcopy'+i,
    encrypted:true,localDisposable:true,
    observedAt:'2026-11-19T11:59:00.000Z'
  }));
  return makeR31DrRehearsal({pilotId,copies,
    source:'operator-claimed',now:new Date(at)});
}
function recoveryFixture(dr){
  return {schema:R32_RECOVERY_SCHEMA,pilotId,
    releaseSha:R31_PIN.sha,rehearsalSha:dr.sha256,
    targetRtoMinutes:10,targetRpoMinutes:5,
    samples:dr.copies.map(x=>({
      copyId:x.copyId,archiveSha:x.archiveSha,
      restoreStartedAt:'2026-11-19T11:59:00.000Z',
      restoreFinishedAt:now.toISOString(),
      expectedLastEventAt:'2026-11-19T11:59:00.000Z',
      recoveredLastEventAt:'2026-11-19T11:58:00.000Z',
      confirmedChecksum:x.restoredChecksum,confirmedRows:x.restoredRows
    }))};
}
function planFixture(source,dr){
  return {schema:R32_WINDOW_SCHEMA,changeId:randomUUID(),tenantId,pilotId,
    releaseSha:R31_PIN.sha,treeSha:source.sourceTreeSha,
    environment:'staging',stagingOrigin:'https://staging.osmanx.world',
    startAt:'2026-11-19T11:59:00.000Z',
    endAt:'2026-11-19T12:05:00.000Z',
    createdAt:'2026-11-19T11:57:00.000Z',
    rollbackRunbookSha:sha('locked runbook'),recoveryEvidenceSha:dr.sha256,
    maxDowntimeMinutes:10};
}
function signedWindow(plan){
  const keys=Object.fromEntries(R32_APPROVERS.map((role,i)=>{
    const {publicKey,privateKey}=generateKeyPairSync('ed25519');
    return [role,{keyId:'pinnedrole'+i,publicKey,privateKey}];
  }));
  const signatures=R32_APPROVERS.map((role,i)=>{
    const record={role,keyId:keys[role].keyId,
      decision:'approved',observedAt:'2026-11-19T11:59:00.000Z',
      nonce:(i+1).toString(16).padStart(32,'0')};
    return {...record,signature:sign(null,r32WindowSigningBytes(plan,record),
      keys[role].privateKey).toString('base64')};
  });
  const publicKeys=Object.fromEntries(R32_APPROVERS.map(role=>[role,{
    keyId:keys[role].keyId,publicKey:keys[role].publicKey
  }]));
  return {signatures,publicKeys};
}
function r31Packet(){
  const {r24,r25,r26,decision}=buildR27SyntheticCase('normal');
  const handoff=makeR27Handoff({r24,r25,r26,audit:decision,
    rehearsal:runR27FirstClientRehearsal(),now});
  const r28=makeR28OperatorPacket({
    handoff,gate:evaluateR28ManualGate({handoff,now}),now});
  const r29=makeR29Report({r28,now});
  const r30=makeR30Report({r29,now});
  return makeR31OperatorReport({r30,now});
}
test('R32 source: 18 exact PR genealogy, five CI names and no fake post-main success',()=>{
  const fixtures=sourceFixture(),out=evaluateR32Source(fixtures);
  assert.equal(out.observedPrs,18);
  assert.equal(out.firstPendingPr,47);
  assert.equal(out.humanSequence.at(-1).pr,66);
  assert.equal(out.sourceCiPassed,true);
  assert.equal(out.ancestryVerified,true);
  assert.equal(out.postMergeMainCiPassed,false);
  assert.equal(out.deployAllowed,false);
  assert.equal(out.productionAuthorized,false);
  assert.ok(out.blockers.includes('R31_NOT_HUMAN_MERGED'));
  assert.ok(evaluateR32Source({...fixtures,checks:fixtures.checks.slice(1)})
    .blockers.includes('R31_NAMED_CI_INCOMPLETE'));
  assert.ok(evaluateR32Source({...fixtures,pr:{...fixtures.pr,
    head:{...fixtures.pr.head,sha:'f'.repeat(40)}}})
    .blockers.includes('R31_PR_HEAD_CHANGED'));
});
test('R32 two-person Ed25519 staging-only change window prevents replay, shared keys and scope changes',()=>{
  const source=evaluateR32Source(sourceFixture()),dr=drFixture();
  const plan=planFixture(source,dr),{signatures,publicKeys}=signedWindow(plan);
  const good=verifyR32ChangeWindow({plan,signatures,publicKeys,now});
  assert.equal(good.metadataAndSignaturesValid,true,JSON.stringify(good.blockers));
  assert.equal(good.approvedStagingWindowOnly,true);
  assert.equal(good.productionAuthorized,false);
  assert.equal(verifyR32ChangeWindow({plan:{...plan,
    environment:'production'},signatures,publicKeys,now})
    .metadataAndSignaturesValid,false);
  assert.equal(verifyR32ChangeWindow({plan:{...plan,
    pilotId:randomUUID()},signatures,publicKeys,now})
    .metadataAndSignaturesValid,false);
  assert.equal(verifyR32ChangeWindow({plan,signatures,
    publicKeys:{...publicKeys,recovery_lead:publicKeys.release_manager},now})
    .metadataAndSignaturesValid,false);
  assert.equal(verifyR32ChangeWindow({plan,signatures,
    publicKeys,now:new Date(plan.endAt).valueOf()+1}).metadataAndSignaturesValid,false);
  assert.equal(verifyR32ChangeWindow({plan,
    signatures:[signatures[0],signatures[0]],publicKeys,now})
    .metadataAndSignaturesValid,false);
});
test('R32 staging detects replay, privacy regression, source drift, synthetic traces',()=>{
  const samples=snapshots();
  const good=evaluateR32StagingDrift({...samples,pilotId,now});
  assert.equal(good.technicalParityStable,true,JSON.stringify(good.blockers));
  assert.equal(good.realStagingIndependentlyVerified,false);
  assert.equal(evaluateR32StagingDrift({
    first:samples.first,second:samples.first,pilotId,now})
    .technicalParityStable,false);
  assert.equal(evaluateR32StagingDrift({...samples,pilotId:randomUUID(),now})
    .technicalParityStable,false);
  const altered={...samples.second,source:'synthetic'};
  assert.equal(evaluateR32StagingDrift({
    first:samples.first,second:altered,pilotId,now})
    .technicalParityStable,false);
  const changed={...samples.second,observations:
    samples.second.observations.map((x,i)=>i===2?
      {...x,httpStatus:200}:x)};
  assert.equal(evaluateR32StagingDrift({
    first:samples.first,second:changed,pilotId,now})
    .technicalParityStable,false);
});
test('R32 RTO/RPO: two distinct disposable archives, matching rows and bounded actual intervals',()=>{
  const dr=drFixture(),record=recoveryFixture(dr);
  const good=assessR32RecoveryObjectives({dr,record,now});
  assert.equal(good.metadataMetricsPass,true,JSON.stringify(good.blockers));
  assert.equal(good.measurements.length,2);
  assert.equal(good.measurements[0].rtoMinutes,1);
  assert.equal(good.measurements[0].rpoMinutes,1);
  assert.equal(good.actualOffsiteRestoreVerified,false);
  assert.equal(assessR32RecoveryObjectives({dr,record:{
    ...record,targetRtoMinutes:0},now}).metadataMetricsPass,false);
  assert.equal(assessR32RecoveryObjectives({dr,record:{
    ...record,targetRpoMinutes:0},now}).metadataMetricsPass,false);
  assert.equal(assessR32RecoveryObjectives({dr,record:{
    ...record,samples:record.samples.map((x,i)=>i?
      {...x,confirmedRows:99}:x)},now}).metadataMetricsPass,false);
  assert.equal(assessR32RecoveryObjectives({dr,record:{
    ...record,pilotId:randomUUID()},now}).metadataMetricsPass,false);
});
test('R32 combined metadata can be review-eligible but is always NO-GO',()=>{
  const source=evaluateR32Source(sourceFixture()),dr=drFixture(),
    {first,second}=snapshots(),recovery=recoveryFixture(dr),
    plan=planFixture(source,dr),{signatures,publicKeys}=signedWindow(plan);
  const x={source,dr,first,second,recovery,plan,signatures,publicKeys,now};
  const result=evaluateR32Preflight(x);
  assert.equal(result.eligibleForHumanAudit,true,JSON.stringify(result.blockers));
  assert.equal(result.productionAuthorized,false);
  assert.equal(result.customerGo,false);
  assert.equal(result.independentVpsWitnessVerified,false);
  assert.equal(evaluateR32Preflight({...x,plan:{...plan,
    recoveryEvidenceSha:sha('other')}}).eligibleForHumanAudit,false);
  assert.equal(evaluateR32Preflight({...x,publicKeys:{}})
    .eligibleForHumanAudit,false);
});
test('R32 tenant handoff SHA + expiry remains hard NO-GO with formula-safe CSV',()=>{
  const r31=r31Packet(),packet=makeR32Readiness({r31,now});
  assert.equal(packet.sourcePrsRequired,18);
  assert.equal(packet.productionAuthorized,false);
  assert.equal(packet.changeWindow.verifiedInApi,0);
  assert.equal(verifyR32Readiness(packet,{now,pilotId:r31.pilotId}).valid,true);
  assert.equal(verifyR32Readiness({...packet,stopLifted:true},{now}).valid,false);
  assert.equal(verifyR32Readiness({...packet,blockers:[]},{now}).valid,false);
  assert.equal(verifyR32Readiness({...packet,pii:'real@example.com'},{now}).valid,false);
  assert.equal(verifyR32Readiness(packet,{
    now:new Date(packet.expiresAt)}).valid,false);
  const csv=r32ReadinessCsv(packet,{now});
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('NO-GO'));
  assert.equal(csv.includes('real@example.com'),false);
});
