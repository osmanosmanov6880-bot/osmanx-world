import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {R35_PIN,evaluateR36Source,reviewR36FirstPending}
  from '../src/guest-r36-source.mjs';
import {inspectR36FirstPrFiles} from '../src/guest-r36-patch-audit.mjs';
import {R36_STAGE_SCHEMA,validateR36SafeResponse,runR36SemanticStaging}
  from '../src/guest-r36-staging-content.mjs';
import {PROBES,SCHEMA} from '../scripts/r14-monitor.mjs';
import {R36_RESTORE_SCHEMA,inspectR36DisposableTarget,
  runR36DisposableRestore} from '../src/guest-r36-disposable-restore.mjs';
import {buildR27SyntheticCase,runR27FirstClientRehearsal}
  from '../src/guest-r27-rehearsal.mjs';
import {makeR27Handoff} from '../src/guest-r27-handoff.mjs';
import {evaluateR28ManualGate} from '../src/guest-r28-stage-gate.mjs';
import {makeR28OperatorPacket} from '../src/guest-r28-operator-packet.mjs';
import {makeR29Report} from '../src/guest-r29-report.mjs';
import {makeR30Report} from '../src/guest-r30-report.mjs';
import {makeR31OperatorReport} from '../src/guest-r31-report.mjs';
import {makeR32Readiness} from '../src/guest-r32-report.mjs';
import {makeR33Readiness} from '../src/guest-r33-report.mjs';
import {makeR34Readiness} from '../src/guest-r34-report.mjs';
import {makeR35Readiness} from '../src/guest-r35-report.mjs';
import {makeR36Readiness,verifyR36Readiness,r36ReadinessCsv}
  from '../src/guest-r36-report.mjs';
const NOW=new Date('2026-11-19T12:00:00.000Z'),
  PILOT=randomUUID(),TREE='b'.repeat(40);
const HEX='a'.repeat(40),SHA='c'.repeat(64);
function sourceFixture(){
  const ids=[47,48,49,51,52,53,54,55,56,57,58,59,60,61,62,
    64,65,66,67,68,69];
  const prior={schema:'osmanx.guest.r35.twenty-one-pr-review.v1',
    sourcePrsRequired:21,observedPrs:21,
    mainSha:HEX,allHumanMerged:false,
    humanSequence:ids.map((pr,i)=>({
      order:i+1,pr,
      sourceSha:pr===69?'d1c072296f48047a494de3629fcb6758b8e7216b':HEX,
      reviewedAndMerged:false
    }))};
  const pr={number:70,state:'open',draft:true,merged:false,
    head:{ref:R35_PIN.head,sha:R35_PIN.sha},
    base:{ref:R35_PIN.base}};
  return {prior,pr,
    checks:R35_PIN.jobs.map(name=>({name,head_sha:R35_PIN.sha,
      status:'completed',conclusion:'success'})),
    compare:{base:R35_PIN.parent,head:R35_PIN.sha,status:'ahead'},
    commit:{sha:R35_PIN.sha,tree:{sha:TREE}},
    mainCommit:{sha:HEX,tree:{sha:'c'.repeat(40)}}};
}
function pending(){
  return {number:47,draft:true,merged:false,state:'open',
    head:{sha:HEX},user:{login:'owner'}};
}
function review(state='APPROVED',commit=HEX,time='2026-11-19T11:55:00.000Z'){
  return {state,commit_id:commit,submitted_at:time,id:10,
    user:{login:'other-reviewer'}};
}
function stageApproval(){
  return {schema:R36_STAGE_SCHEMA,pilotId:PILOT,sourceTreeSha:TREE,
    releaseSha:R35_PIN.sha,origin:'https://staging.osmanx.world',
    approvedIpv4:'8.8.8.8',approvedCertSha256:SHA,
    issuedAt:'2026-11-19T11:57:00.000Z',
    expiresAt:'2026-11-19T12:05:00.000Z',
    nonce:'a'.repeat(32),allowedMethods:['GET'],
    guestWritesExpected:false};
}
function safeResponse(spec){
  const obj=spec.id==='live'?{status:'live'}:spec.id==='ready'?{
    status:'ready',database:'ok',schemaVersion:SCHEMA,
    leastPrivilege:true,forcedRls:true,guestWritesEnabled:false
  }:{error:'Требуется авторизация'};
  return {status:spec.status,contentType:'application/json; charset=utf-8',
    body:JSON.stringify(obj)};
}
function restorePlan(){
  return {schema:R36_RESTORE_SCHEMA,pilotId:PILOT,
    releaseSha:R35_PIN.sha,sourceTreeSha:TREE,
    archiveSha256:SHA,archivePath:'/private/copy.age',
    identityFile:'/private/key.txt',
    issuedAt:'2026-11-19T11:59:00.000Z',
    expiresAt:'2026-11-19T12:04:00.000Z',
    nonce:'d'.repeat(32),allowedTargetDb:'industry_dr_r36_trial123'};
}
function r35Fixture(){
  const {r24,r25,r26,decision}=buildR27SyntheticCase('normal');
  const handoff=makeR27Handoff({r24,r25,r26,audit:decision,
    rehearsal:runR27FirstClientRehearsal(),now:NOW});
  const r28=makeR28OperatorPacket({handoff,
    gate:evaluateR28ManualGate({handoff,now:NOW}),now:NOW});
  const r29=makeR29Report({r28,now:NOW}),
    r30=makeR30Report({r29,now:NOW}),
    r31=makeR31OperatorReport({r30,now:NOW}),
    r32=makeR32Readiness({r31,now:NOW}),
    r33=makeR33Readiness({r32,now:NOW}),
    r34=makeR34Readiness({r33,now:NOW});
  return makeR35Readiness({r34,now:NOW});
}
test('R36 exact 22 source PRs, pin SHA, parent and 5 named jobs: no GO',()=>{
  const f=sourceFixture(),out=evaluateR36Source(f);
  assert.equal(out.observedPrs,22);
  assert.equal(out.firstPendingPr,47);
  assert.equal(out.sourceCiVerified,true);
  assert.equal(out.sourceAncestryVerified,true);
  assert.equal(out.automaticMergeAllowed,false);
  assert.equal(out.productionAuthorized,false);
  assert.equal(out.changedMain,false);
  assert.equal(evaluateR36Source({...f,
    checks:f.checks.slice(1)}).sourceCiVerified,false);
  assert.ok(evaluateR36Source({...f,pr:{...f.pr,
    head:{...f.pr.head,sha:'e'.repeat(40)}}})
    .blockers.includes('PR70_HEAD_OR_BASE_DRIFT'));
});
test('R36 review state: latest CHANGES_REQUESTED, stale commit, draft, incomplete CI',()=>{
  const src=evaluateR36Source(sourceFixture()),p=pending();
  const check={name:'industry-api',status:'completed',conclusion:'success',
    head_sha:HEX};
  const draft=reviewR36FirstPending({source:src,pr:p,
    reviews:[],checks:[check],reviewPagesComplete:true,
    checksComplete:true});
  assert.equal(draft.manualNextAction,'READY_FOR_REVIEW_AFTER_CODE_AUDIT');
  assert.equal(draft.firstReviewAcceptedByGitHub,false);
  const approved=reviewR36FirstPending({source:src,
    pr:{...p,draft:false},reviews:[review()],checks:[check],
    reviewPagesComplete:true,checksComplete:true});
  assert.equal(approved.currentIndependentApprovals,1);
  assert.equal(approved.manualNextAction,'HUMAN_MERGE_DECISION_REQUIRED');
  assert.equal(approved.automaticMergeAllowed,false);
  const changed=reviewR36FirstPending({source:src,
    pr:{...p,draft:false},reviews:[
      review(),{...review('CHANGES_REQUESTED',HEX,
        '2026-11-19T11:58:00.000Z'),id:11}
    ],checks:[check],reviewPagesComplete:true,checksComplete:true});
  assert.equal(changed.currentIndependentApprovals,0);
  assert.equal(changed.unresolvedChangeRequests,1);
  const stale=reviewR36FirstPending({source:src,
    pr:{...p,draft:false},reviews:[review('APPROVED','f'.repeat(40))],
    checks:[check],reviewPagesComplete:true,checksComplete:true});
  assert.equal(stale.currentIndependentApprovals,0);
  assert.equal(reviewR36FirstPending({source:src,
    pr:{...p,draft:false},reviews:[review()],checks:[check],
    reviewPagesComplete:false,checksComplete:true
  }).firstReviewAcceptedByGitHub,false);
});
test('R36 actual PR47 patch inventory creates an actionable manual checklist',()=>{
  const f=[
    {filename:'services/industry-api/ops/compose.r14.yml',
      status:'added',additions:95,deletions:0,patch:'@@ first line'},
    {filename:'services/industry-api/scripts/r14-admission.mjs',
      status:'added',additions:124,deletions:0,patch:'@@ protected'},
    {filename:'.github/workflows/guest-r14-operations.yml',
      status:'added',additions:55,deletions:0,patch:'@@ workflow'}
  ];
  const result=inspectR36FirstPrFiles({pr:pending(),files:f,complete:true});
  assert.equal(result.completeInventory,true);
  assert.equal(result.changeCount,3);
  assert.ok(result.checklist.some(x=>x.area==='DEPLOY_AND_RUNTIME'));
  assert.ok(result.checklist.some(x=>x.area==='CRYPTO_AND_GATE'));
  assert.equal(result.humanCodeAuditPerformed,false);
  assert.equal(result.productionAuthorized,false);
  assert.equal(inspectR36FirstPrFiles({pr:pending(),files:[
    {...f[0],filename:'../private.env'}],complete:true
  }).completeInventory,false);
  assert.equal(inspectR36FirstPrFiles({pr:pending(),files:[
    {...f[0],patch:null}],complete:true
  }).completeInventory,false);
});
test('R36 staging validates health body semantics, 401 content and no guest writes',()=>{
  for(const spec of PROBES)
    assert.equal(validateR36SafeResponse(spec,safeResponse(spec)),true);
  const ready=PROBES.find(x=>x.id==='ready'),
    broken=safeResponse(ready);
  broken.body=JSON.stringify({...JSON.parse(broken.body),
    guestWritesEnabled:true});
  assert.equal(validateR36SafeResponse(ready,broken),false);
  assert.equal(validateR36SafeResponse(ready,{
    ...safeResponse(ready),body:'<html>ready</html>'}),false);
  assert.equal(validateR36SafeResponse(ready,{
    ...safeResponse(ready),body:'x'.repeat(4100)}),false);
});
test('R36 approved operator semantic canary: pinned TLS/DNS, 2x5 GET and no body in proof',async()=>{
  let now=NOW,requests=0;
  const o=stageApproval();
  const f=async()=>{
    requests++;
    throw Error('should not contact');
  };
  await assert.rejects(runR36SemanticStaging({
    approval:{...o,approvedIpv4:'127.0.0.1'},approved:true,
    resolveIpv4:f,inspectTls:f,fetchResponse:f,
    clock:()=>now,delay:async()=>{}
  }),/approved exact/);
  assert.equal(requests,0);
  const result=await runR36SemanticStaging({
    approval:o,approved:true,
    resolveIpv4:async()=>['8.8.8.8'],
    inspectTls:async()=>({authorized:true,
      serverName:'staging.osmanx.world',sha256:SHA}),
    fetchResponse:async ({method,path,certSha256,maxBodyBytes})=>{
      assert.equal(method,'GET');
      assert.equal(certSha256,SHA);
      assert.equal(maxBodyBytes,4096);
      requests++;
      return safeResponse(PROBES.find(x=>x.path===path));
    },
    clock:()=>now,
    delay:async(ms)=>{
      assert.equal(ms,30000);now=new Date(now.getTime()+60000);
    }
  });
  assert.equal(result.totalProbes,10);
  assert.equal(requests,10);
  assert.equal(result.responseBodyStored,false);
  assert.equal(result.productionAuthorized,false);
  assert.equal(result.realDeployedCommitVerified,false);
  assert.equal(JSON.stringify(result).includes('Требуется авторизация'),false);
});
test('R36 DR refuses remote/production target before any archive or process access',async()=>{
  assert.equal(inspectR36DisposableTarget(
    'postgresql://user:pwd@127.0.0.1:5432/industry_dr_r36_trial123').safe,true);
  for(const x of [
    'postgresql://user:pwd@db.example.com/industry_dr_r36_trial123',
    'postgresql://user:pwd@127.0.0.1/industry',
    'postgresql://user:pwd@127.0.0.1/industry_dr_prod',
    'postgresql://user:pwd@127.0.0.1/industry_dr_r36_trial123?sslmode=disable'
  ])assert.equal(inspectR36DisposableTarget(x).safe,false,x);
  const plan=restorePlan(),dbUrl=
    'postgresql://test:secret@127.0.0.1:5432/industry_dr_r36_trial123';
  let touched=0;
  const restoreCommand=async()=>{
    touched++;return {exitCode:0,verifiedEmptyTarget:true};
  };
  await assert.rejects(runR36DisposableRestore({
    plan,dbUrl:'postgresql://test:secret@remote.io/industry_dr_r36_trial123',
    approved:true,clock:()=>NOW,
    hashArchive:async()=>{touched++},
    checkIdentity:async()=>{touched++},restoreCommand
  }),/isolated loopback/);
  assert.equal(touched,0);
  const out=await runR36DisposableRestore({plan,dbUrl,approved:true,
    clock:()=>NOW,
    hashArchive:async()=>({sha256:SHA,ageEnvelopeHeaderSeen:true}),
    checkIdentity:async()=>{touched++},restoreCommand});
  assert.equal(out.localDisposableRestoreExecuted,true);
  assert.equal(out.actualRemoteOffsiteCustodyVerified,false);
  assert.equal(out.realProductionRollbackTested,false);
  assert.equal(out.productionAuthorized,false);
  assert.equal(touched,2);
  await assert.rejects(runR36DisposableRestore({
    plan:{...plan,allowedTargetDb:'industry_dr_r36_changed123'},
    dbUrl,approved:true,clock:()=>NOW,
    hashArchive:async()=>{touched++},
    checkIdentity:async()=>{touched++},restoreCommand
  }),/isolated loopback/);
  assert.equal(touched,2);
});
test('R36 10-minute inherited tenant report stays SHA-bound and unconditional NO-GO',()=>{
  const r35=r35Fixture(),packet=makeR36Readiness({r35,now:NOW});
  assert.equal(packet.source.requiredPrs,22);
  assert.equal(packet.source.mergedPrsVerifiedInApi,0);
  assert.equal(packet.staging.networkRequestsFromWebApi,0);
  assert.equal(packet.disasterRecovery.actualLocalRestoresInWebApi,0);
  assert.equal(packet.customerGo,false);
  assert.equal(verifyR36Readiness(packet,{
    pilotId:r35.pilotId,now:NOW}).valid,true);
  assert.equal(verifyR36Readiness({...packet,customerGo:true},{now:NOW}).valid,false);
  assert.equal(verifyR36Readiness({...packet,blockers:[]},{now:NOW}).valid,false);
  assert.equal(verifyR36Readiness({...packet,email:'secret@test.local'},
    {now:NOW}).valid,false);
  assert.equal(verifyR36Readiness(packet,{
    now:new Date(packet.expiresAt)}).valid,false);
  const csv=r36ReadinessCsv(packet,{now:NOW});
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('NO-GO'));
  assert.equal(csv.includes('secret@test.local'),false);
});
