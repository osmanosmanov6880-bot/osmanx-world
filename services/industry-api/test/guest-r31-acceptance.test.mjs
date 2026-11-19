import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {R30_PIN,evaluateR31Chain} from '../src/guest-r31-chain.mjs';
import {runR31ApprovedStaging,R31_STAGING_HOST}
  from '../scripts/r31-approved-staging.mjs';
import {makeR30ProbeSnapshot,R30_ORIGINS,R30_PROBES}
  from '../src/guest-r30-probe.mjs';
import {makeR31DrRehearsal,reviewR31DrRehearsal}
  from '../src/guest-r31-dr-review.mjs';
import {reviewR31EvidenceBundle} from '../src/guest-r31-evidence-bundle.mjs';
import {R30_ROLES,R30_RECEIPT_SCHEMA,r30ReceiptSigningBytes}
  from '../src/guest-r30-evidence.mjs';
import {buildR27SyntheticCase,runR27FirstClientRehearsal}
  from '../src/guest-r27-rehearsal.mjs';
import {makeR27Handoff} from '../src/guest-r27-handoff.mjs';
import {evaluateR28ManualGate} from '../src/guest-r28-stage-gate.mjs';
import {makeR28OperatorPacket} from '../src/guest-r28-operator-packet.mjs';
import {makeR29Report} from '../src/guest-r29-report.mjs';
import {makeR30Report} from '../src/guest-r30-report.mjs';
import {makeR31OperatorReport,verifyR31OperatorReport,r31OperatorCsv}
  from '../src/guest-r31-report.mjs';

const now=new Date('2026-11-19T12:00:00.000Z');
const begin=new Date('2026-11-19T11:59:00.000Z');
const pilotId=randomUUID(),tenantId=randomUUID();
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function fixtures(){
  const previous={schema:'osmanx.guest.r30.sixteen-pr-source-review.v1',
    sourcePrsRequired:16,sourcePrsObserved:16,mainSha:'a'.repeat(40),
    allSourcePrsMerged:false,blockers:['R30_UNMERGED'],
    humanMergeSequence:[47,48,49,51,52,53,54,55,56,57,58,59,60,61,62,64]
      .map((pr,i)=>({pr,order:i+1,
        sourceSha:pr===64?'7b2e9a60765a08b0662b332378958147431783ab':
          'a'.repeat(40),reviewedAndMerged:false}))
  };
  const r30={number:65,head:{ref:R30_PIN.head,sha:R30_PIN.sha},
    base:{ref:R30_PIN.base},draft:true,state:'open',merged:false};
  const checks=R30_PIN.requiredJobs.map(name=>({
    name,head_sha:R30_PIN.sha,status:'completed',conclusion:'success'
  }));
  return {previous,r30,checks,
    compare:{base:R30_PIN.parent,head:R30_PIN.sha,status:'ahead'},
    releaseCommit:{sha:R30_PIN.sha,tree:{sha:'b'.repeat(40)}},
    mainCommit:{sha:'a'.repeat(40),tree:{sha:'c'.repeat(40)}}};
}
function r30Packet(){
  const {r24,r25,r26,decision}=buildR27SyntheticCase('normal');
  const handoff=makeR27Handoff({r24,r25,r26,audit:decision,
    rehearsal:runR27FirstClientRehearsal(),now});
  const r28=makeR28OperatorPacket({
    handoff,gate:evaluateR28ManualGate({handoff,now}),now});
  const r29=makeR29Report({r28,now});
  return makeR30Report({r29,now});
}
function drCopies(){
  return ['A','B'].map((copyId,i)=>({
    copyId,archiveSha:hash('archive'+copyId),
    keyFingerprint:hash('key'+copyId),
    restoredChecksum:hash('schema+data'),
    restoredRows:4,restoreTarget:'industry_dr_r31_'+'x'.repeat(6)+i,
    encrypted:true,localDisposable:true,observedAt:now.toISOString()
  }));
}
function observed(){
  return R30_ORIGINS.flatMap(origin=>R30_PROBES.map(probe=>({
    origin,probe,method:'GET',httpStatus:['live','ready'].includes(probe)?200:401,
    redirected:false,requestHadCredentials:false,responseBodyStored:false,
    observedAt:now.toISOString()
  })));
}
test('R31 graph pins 17 exact PRs, notices drift and forbids source-only production GO',()=>{
  const base=fixtures(),result=evaluateR31Chain(base);
  assert.equal(result.observedPrs,17);
  assert.equal(result.firstHumanReviewPr,47);
  assert.equal(result.humanSequence.at(-1).pr,65);
  assert.equal(result.sourceCiPassed,true);
  assert.equal(result.ancestryVerified,true);
  assert.equal(result.postMergeMainCiVerified,false);
  assert.equal(result.autoMergeAllowed,false);
  assert.equal(result.customerGo,false);
  assert.ok(result.blockers.includes('R30_REQUIRES_HUMAN_MERGE'));
  assert.ok(evaluateR31Chain({...base,checks:base.checks.slice(1)})
    .blockers.includes('R30_NAMED_SOURCE_CI_NOT_GREEN'));
  assert.ok(evaluateR31Chain({...base,r30:{...base.r30,
    head:{...base.r30.head,sha:'f'.repeat(40)}}})
    .blockers.includes('R30_SOURCE_HEAD_DRIFT'));
});
test('R31 operator GET requires approval, contacts only fixed loopback and dedicated staging, never reads response body',async()=>{
  const calls=[];
  const good=async(url,options)=>{
    calls.push({url,options});
    return {status:/\/health\/(live|ready)$/.test(url)?200:401,
      body:{cancel:async()=>{}}};
  };
  await assert.rejects(runR31ApprovedStaging({pilotId,fetcher:good}),
    /approval/i);
  assert.equal(calls.length,0);
  const result=await runR31ApprovedStaging({
    approved:true,pilotId,fetcher:good,clock:()=>new Date(now)
  });
  assert.equal(result.snapshot.source,'operator-claimed');
  assert.equal(result.review.technicalParityPassed,true);
  assert.equal(result.networkRequestsAttempted,10);
  assert.equal(result.realStagingIndependentlyVerified,false);
  assert.equal(result.productionAuthorized,false);
  assert.equal(calls.length,10);
  assert.ok(calls.some(x=>x.url.startsWith(R31_STAGING_HOST+'/')));
  for(const c of calls){
    assert.ok(c.url.startsWith(R31_STAGING_HOST+'/')||
      c.url.startsWith('http://127.0.0.1:3150/'));
    assert.equal(c.options.method,'GET');
    assert.equal(c.options.redirect,'error');
    assert.equal(c.options.credentials,'omit');
    assert.equal(c.options.headers.Authorization,undefined);
    assert.equal(c.options.body,undefined);
  }
  const bad=await runR31ApprovedStaging({approved:true,pilotId,
    fetcher:async(url)=>({status:
      url.includes('/guest/pilots')?200:200,body:{cancel:async()=>{}}}),
    clock:()=>new Date(now)
  });
  assert.equal(bad.review.technicalParityPassed,false);
  const down=await runR31ApprovedStaging({approved:true,pilotId,
    fetcher:async()=>{throw Error('offline');},
    clock:()=>new Date(now)
  });
  assert.equal(down.review.technicalParityPassed,false);
});
test('R31 two independent disposable DR records reject duplicate key, wrong targets, tampering and cross-tenant claim',()=>{
  const good=makeR31DrRehearsal({
    pilotId,copies:drCopies(),source:'operator-claimed',now:begin
  });
  // Observations later than began are tested at current clock.
  assert.equal(reviewR31DrRehearsal(good,{pilotId,now}).metadataConsistent,true);
  const copy=drCopies();
  copy[1].keyFingerprint=copy[0].keyFingerprint;
  assert.equal(reviewR31DrRehearsal(makeR31DrRehearsal({
    pilotId,copies:copy,source:'operator-claimed',now:begin
  }),{pilotId,now}).metadataConsistent,false);
  assert.equal(reviewR31DrRehearsal(good,{pilotId:randomUUID(),now})
    .metadataConsistent,false);
  assert.equal(reviewR31DrRehearsal({...good,sha256:'f'.repeat(64)},
    {pilotId,now}).metadataConsistent,false);
  const corrupted=drCopies();corrupted[0].restoreTarget='industry_ci';
  assert.equal(reviewR31DrRehearsal(makeR31DrRehearsal({
    pilotId,copies:corrupted,source:'operator-claimed',now:begin
  }),{pilotId,now}).metadataConsistent,false);
});
test('R31 offline bundle cryptographically binds 4 independently signed role hashes to source, probe, DR and privacy',()=>{
  const r30=r30Packet(),source=evaluateR31Chain(fixtures());
  const p=r30.pilotId;
  const probe=makeR30ProbeSnapshot({pilotId:p,
    releaseCommit:R30_PIN.sha,observations:observed(),
    source:'operator-claimed',now});
  const dr=makeR31DrRehearsal({pilotId:p,copies:drCopies(),
    source:'operator-claimed',now:begin});
  const privacy={schema:'osmanx.guest.r31.privacy-brief.v1',
    assessmentSha:hash('privacy review'),
    noCustomerDataCopied:true,lawfulBasisConfirmedExternally:false};
  const identity={tenantId,pilotId:p,releaseCommit:R30_PIN.sha,
    r29ReportSha:r30.r29ReportSha,
    issuedAt:begin.toISOString(),expiresAt:'2026-11-19T12:05:00.000Z'};
  const expected={
    source_reviewer:hash(source),staging_witness:probe.sha256,
    recovery_auditor:dr.sha256,privacy_officer:hash(privacy)
  };
  const all=Object.fromEntries(R30_ROLES.map((role,i)=>{
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');
    return [role,{privateKey,publicKey,keyId:'trustedkey'+i}];
  }));
  const receipts={schema:R30_RECEIPT_SCHEMA,receipts:R30_ROLES.map((role,i)=>{
    const e={role,keyId:all[role].keyId,evidenceSha:expected[role],
      decision:'reviewed',observedAt:now.toISOString(),
      nonce:(i+1).toString(16).padStart(32,'0')};
    return {...e,signature:sign(null,r30ReceiptSigningBytes(e,identity),
      all[role].privateKey).toString('base64')};
  })};
  const publicKeys=Object.fromEntries(R30_ROLES.map(role=>
    [role,{keyId:all[role].keyId,publicKey:all[role].publicKey}]));
  const inputs={r30,source,probe,dr,privacy,identity,receipts,publicKeys,now};
  const result=reviewR31EvidenceBundle(inputs);
  assert.equal(result.offlineMetadataBound,true,JSON.stringify(result.blockers));
  assert.equal(result.independentSignatureQuorum,true);
  assert.equal(result.productionAuthorized,false);
  assert.equal(result.offsiteCustodyConfirmed,false);
  assert.equal(reviewR31EvidenceBundle({...inputs,privacy:{
    ...privacy,assessmentSha:hash('tampered')
  }}).offlineMetadataBound,false);
  assert.equal(reviewR31EvidenceBundle({...inputs,identity:{
    ...identity,pilotId:randomUUID()
  }}).offlineMetadataBound,false);
  assert.equal(reviewR31EvidenceBundle({...inputs,publicKeys:{}})
    .offlineMetadataBound,false);
});
test('R31 bounded report binds R30 digest, fails closed on false GO, missing blockers and expiration',()=>{
  const r30=r30Packet(),report=makeR31OperatorReport({r30,now});
  assert.equal(report.sourcePrsRequired,17);
  assert.equal(report.productionGo,false);
  assert.equal(report.staging.realVpsProbedInApi,false);
  assert.equal(verifyR31OperatorReport(report,{pilotId:r30.pilotId,now}).valid,true);
  assert.equal(verifyR31OperatorReport({...report,productionGo:true},{now}).valid,false);
  assert.equal(verifyR31OperatorReport({...report,blockers:[]},{now}).valid,false);
  assert.equal(verifyR31OperatorReport({...report,privateContact:'me@example.test'},
    {now}).valid,false);
  assert.equal(verifyR31OperatorReport(report,{
    now:new Date(report.expiresAt)}).valid,false);
  const csv=r31OperatorCsv(report,{now});
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('NO-GO'));
  assert.equal(csv.includes('me@example.test'),false);
});
