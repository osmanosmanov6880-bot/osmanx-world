import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {R29_PIN,evaluateR30SourceReview}
  from '../src/guest-r30-source-review.mjs';
import {R30_ROLES,R30_RECEIPT_SCHEMA,r30ReceiptSigningBytes,
  verifyR30IndependentReceipts} from '../src/guest-r30-evidence.mjs';
import {R30_PROBES,R30_ORIGINS,makeR30ProbeSnapshot,
  reviewR30ProbeSnapshot,r30Digest} from '../src/guest-r30-probe.mjs';
import {buildR27SyntheticCase,runR27FirstClientRehearsal}
  from '../src/guest-r27-rehearsal.mjs';
import {makeR27Handoff} from '../src/guest-r27-handoff.mjs';
import {evaluateR28ManualGate} from '../src/guest-r28-stage-gate.mjs';
import {makeR28OperatorPacket} from '../src/guest-r28-operator-packet.mjs';
import {makeR29Report} from '../src/guest-r29-report.mjs';
import {makeR30Report,verifyR30Report,r30ReportCsv}
  from '../src/guest-r30-report.mjs';
const now=new Date('2026-11-19T12:00:00.000Z');
const pilotId=randomUUID(),tenantId=randomUUID();
const sha=x=>createHash('sha256').update(x).digest('hex');
const start='2026-11-19T11:59:00.000Z',expiry='2026-11-19T12:05:00.000Z';

test('R30 sixteen PR graph pins R29 exact branch, SHA and named jobs; source green is not main CI',()=>{
  const previous={
    schema:'osmanx.guest.r29.fifteen-source-tree-review.v1',
    sourcePrCount:15,mainSha:'a'.repeat(40),allMerged:false,
    blockers:['PR_CHAIN_UNMERGED'],humanMergeSequence:
      [47,48,49,51,52,53,54,55,56,57,58,59,60,61,62]
        .map((pr,i)=>({pr,order:i+1,sourceSha:'a'.repeat(40),merged:false}))
  };
  const r29={number:64,head:{ref:R29_PIN.head,sha:R29_PIN.sha},
    base:{ref:R29_PIN.base},draft:true,state:'open',merged:false};
  const checks=R29_PIN.requiredJobs.map(name=>({name,head_sha:R29_PIN.sha,
    status:'completed',conclusion:'success'}));
  const baseline={previous,r29,checks,
    ancestry:{base:R29_PIN.parent,head:R29_PIN.sha,status:'ahead'},
    sourceCommit:{sha:R29_PIN.sha,tree:{sha:'b'.repeat(40)}},
    mainCommit:{sha:'a'.repeat(40),tree:{sha:'c'.repeat(40)}}};
  const out=evaluateR30SourceReview(baseline);
  assert.equal(out.sourcePrsObserved,16);
  assert.equal(out.humanMergeSequence.at(-1).pr,64);
  assert.equal(out.sourceNamedCiPassed,true);
  assert.equal(out.freshPostMergeMainCiPassed,false);
  assert.equal(out.customerGo,false);
  assert.equal(out.deployAllowed,false);
  assert.ok(out.blockers.includes('R29_NEEDS_INDEPENDENT_MERGE_REVIEW'));
  assert.ok(evaluateR30SourceReview({...baseline,r29:{...r29,
    head:{...r29.head,sha:'f'.repeat(40)}}}).blockers.includes('R29_HEAD_DRIFT'));
  assert.ok(evaluateR30SourceReview({...baseline,checks:checks.slice(1)})
    .blockers.includes('R29_NAMED_CI_MISSING'));
});

test('R30 four independent Ed25519 receipts reject replay, key reuse, tampering and cross-pilot scope',()=>{
  const identity={tenantId,pilotId,releaseCommit:R29_PIN.sha,
    r29ReportSha:sha('r29'),issuedAt:start,expiresAt:expiry};
  const keys=Object.fromEntries(R30_ROLES.map((role,i)=>{
    const {publicKey,privateKey}=generateKeyPairSync('ed25519');
    return [role,{keyId:'rolekey'+i,publicKey,privateKey}];
  }));
  const receipts=R30_ROLES.map((role,i)=>{
    const item={role,keyId:keys[role].keyId,evidenceSha:sha(role),
      decision:'reviewed',observedAt:start,nonce:(i+1).toString(16).padStart(32,'0')};
    return {...item,signature:sign(null,r30ReceiptSigningBytes(item,identity),
      keys[role].privateKey).toString('base64')};
  });
  const packet={schema:R30_RECEIPT_SCHEMA,receipts};
  const trusted=Object.fromEntries(R30_ROLES.map(role=>[role,{
    keyId:keys[role].keyId,publicKey:keys[role].publicKey
  }]));
  const result=verifyR30IndependentReceipts({identity,packet,publicKeys:trusted,now});
  assert.equal(result.signatureQuorumVerified,true);
  assert.equal(result.realStagingVerified,false);
  assert.equal(result.productionAuthorized,false);
  assert.equal(verifyR30IndependentReceipts({identity:{...identity,
    pilotId:randomUUID()},packet,publicKeys:trusted,now})
    .signatureQuorumVerified,false);
  assert.equal(verifyR30IndependentReceipts({identity,packet:{...packet,
    receipts:receipts.map((x,i)=>i?x:{...x,evidenceSha:sha('tampered')})},
    publicKeys:trusted,now}).signatureQuorumVerified,false);
  assert.equal(verifyR30IndependentReceipts({identity,packet,
    publicKeys:{...trusted,recovery_auditor:trusted.source_reviewer},now})
    .signatureQuorumVerified,false);
  assert.equal(verifyR30IndependentReceipts({identity,packet,publicKeys:trusted,
    now:new Date(expiry)}).signatureQuorumVerified,false);
  const repeated={...packet,receipts:receipts.map((x,i)=>i?x:{...x,
    nonce:receipts[1].nonce})};
  assert.equal(verifyR30IndependentReceipts({identity,packet:repeated,
    publicKeys:trusted,now}).signatureQuorumVerified,false);
});

test('R30 read-only trace requires ten scoped GET statuses, refuses privacy leaks and tamper',()=>{
  const observations=R30_ORIGINS.flatMap(origin=>R30_PROBES.map(probe=>({
    origin,probe,method:'GET',
    httpStatus:['live','ready'].includes(probe)?200:401,
    redirected:false,requestHadCredentials:false,
    responseBodyStored:false,observedAt:start
  })));
  const good=makeR30ProbeSnapshot({pilotId,releaseCommit:R29_PIN.sha,
    observations,now:new Date(start)});
  const review=reviewR30ProbeSnapshot(good,{pilotId,
    releaseCommit:R29_PIN.sha,now});
  assert.equal(review.technicalParityPassed,true);
  assert.equal(review.isSynthetic,true);
  assert.equal(review.realHostVerified,false);
  assert.equal(review.productionAuthorized,false);
  assert.equal(reviewR30ProbeSnapshot({...good,observations:
    observations.map((x,i)=>i===2?{...x,httpStatus:200}:x)},
    {pilotId,releaseCommit:R29_PIN.sha,now}).technicalParityPassed,false);
  assert.equal(reviewR30ProbeSnapshot(good,{pilotId:randomUUID(),now})
    .technicalParityPassed,false);
  assert.equal(reviewR30ProbeSnapshot({...good,sha256:'f'.repeat(64)},
    {pilotId,now}).technicalParityPassed,false);
  const wrong=observations.map((x,i)=>i===4?{...x,
    requestHadCredentials:true}:x);
  const candidate={...good,observations:wrong};
  const {sha256,...body}=candidate;
  assert.equal(reviewR30ProbeSnapshot({...body,sha256:r30Digest(body)},
    {pilotId,now}).technicalParityPassed,false);
});

function priorReport(){
  const {r24,r25,r26,decision}=buildR27SyntheticCase('normal');
  const handoff=makeR27Handoff({
    r24,r25,r26,audit:decision,
    rehearsal:runR27FirstClientRehearsal(),now
  });
  const r28=makeR28OperatorPacket({
    handoff,gate:evaluateR28ManualGate({handoff,now}),now
  });
  return makeR29Report({r28,now});
}
test('R30 10-minute SHA-bound operator handoff keeps all production gates shut',()=>{
  const r29=priorReport();
  const report=makeR30Report({r29,now});
  assert.equal(report.sourcePrsRequired,16);
  assert.equal(report.externalReceipts.requiredDistinctRoles,4);
  assert.equal(report.actualStagingVerified,false);
  assert.equal(report.productionAuthorized,false);
  assert.equal(verifyR30Report(report,{pilotId:r29.pilotId,now}).valid,true);
  assert.equal(verifyR30Report({...report,productionAuthorized:true},
    {now}).valid,false);
  assert.equal(verifyR30Report({...report,blockers:[]},{now}).valid,false);
  assert.equal(verifyR30Report({...report,customerEmail:'secret@example.test'},
    {now}).valid,false);
  assert.equal(verifyR30Report(report,{now:new Date(Date.parse(report.expiresAt))})
    .valid,false);
  const value=r30ReportCsv(report,{now});
  assert.ok(value.startsWith('\uFEFF'));
  assert.equal(value.includes('secret@example.test'),false);
  assert.ok(value.includes('NO-GO'));
});
