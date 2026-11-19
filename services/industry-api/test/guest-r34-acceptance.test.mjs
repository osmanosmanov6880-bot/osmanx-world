import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {Readable} from 'node:stream';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {R33_PIN,evaluateR34Source} from '../src/guest-r34-source.mjs';
import {observeR34Staging,publicIpv4,reviewR34HostEvidence}
  from '../src/guest-r34-host-evidence.mjs';
import {r34SigningBytes} from '../src/guest-r34-quorum.mjs';
import {R34_CUSTODY_SCHEMA,R34_CUSTODY_ROLES,evaluateR34Custody}
  from '../src/guest-r34-custody.mjs';
import {R34_CLIENT_SCHEMA,R34_CLIENT_ROLES,evaluateR34ClientScope}
  from '../src/guest-r34-client.mjs';
import {evaluateR34Acceptance} from '../src/guest-r34-acceptance.mjs';
import {runR34OfflineReview} from '../scripts/r34-offline-review.mjs';
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
import {makeR34Readiness,verifyR34Readiness,r34ReadinessCsv}
  from '../src/guest-r34-report.mjs';
const NOW=new Date('2026-11-19T12:00:00.000Z');
const TENANT=randomUUID(),PILOT=randomUUID(),CHANGE=randomUUID();
const TREE='b'.repeat(40);
const sha=s=>createHash('sha256').update(s).digest('hex');
function sourceFixture(){
  const ids=[47,48,49,51,52,53,54,55,56,57,58,59,60,61,62,64,65,66,67];
  const prior={schema:'osmanx.guest.r33.nineteen-pr-evidence.v1',
    sourcePrsRequired:19,observedPrs:19,mainSha:'a'.repeat(40),
    allHumanMerged:false,
    humanSequence:ids.map((pr,i)=>({pr,order:i+1,
      sourceSha:pr===67?'1c1c7047cd1d197fea0289857b2bacee141baaea':
        'a'.repeat(40),reviewedAndMerged:false}))
  };
  return {
    prior,pr:{number:68,head:{ref:R33_PIN.head,sha:R33_PIN.sha},
      base:{ref:R33_PIN.base},merged:false,draft:true,state:'open'},
    checks:R33_PIN.jobs.map(name=>({name,head_sha:R33_PIN.sha,
      status:'completed',conclusion:'success'})),
    ancestry:{base:R33_PIN.parent,head:R33_PIN.sha,status:'ahead'},
    releaseCommit:{sha:R33_PIN.sha,tree:{sha:TREE}},
    mainCommit:{sha:'a'.repeat(40),tree:{sha:'c'.repeat(40)}}
  };
}
function client(){
  return {schema:R34_CLIENT_SCHEMA,tenantId:TENANT,pilotId:PILOT,
    changeId:CHANGE,releaseSha:R33_PIN.sha,treeSha:TREE,
    issuedAt:'2026-11-19T11:57:00.000Z',
    expiresAt:'2026-11-19T12:05:00.000Z',
    purpose:'guest_experience_aggregate',
    dataCategories:['aggregate-guest-metrics'],retentionDays:14,
    aggregatedOnly:true,personalIdentifiersCollected:false,
    thirdPartyExportAllowed:false,consentOrOtherBasisReviewed:true,
    contractSha:sha('contract'),processorAgreementSha:sha('processor'),
    privacyNoticeSha:sha('privacy notice'),
    lawfulBasisOpinionSha:sha('lawful basis'),
    deletionProcedureSha:sha('deletion'),
    productionCollectionAuthorized:false};
}
function custody(){
  return {schema:R34_CUSTODY_SCHEMA,tenantId:TENANT,pilotId:PILOT,
    releaseSha:R33_PIN.sha,treeSha:TREE,
    issuedAt:'2026-11-19T11:57:00.000Z',
    expiresAt:'2026-11-19T12:05:00.000Z',
    productionDatabaseTouched:false,targetRtoMinutes:5,
    targetRpoMinutes:5,
    copies:['A','B'].map((id,i)=>({
      copyId:id,storageRealm:i?'independent-region-b':'independent-region-a',
      archiveSha:sha('archive'+id),keyFingerprint:sha('key'+id),
      restoreTarget:'industry_dr_r34_testcopy'+i,
      encryptedWithAge:true,restoredRows:24,
      restoredDataSha:sha('same restored data'),
      restoreStartedAt:'2026-11-19T11:58:00.000Z',
      restoreFinishedAt:'2026-11-19T11:59:30.000Z',
      lastExpectedEventAt:'2026-11-19T11:59:00.000Z',
      lastRecoveredEventAt:'2026-11-19T11:58:00.000Z'
    }))};
}
const keys=Object.fromEntries([...R34_CUSTODY_ROLES,...R34_CLIENT_ROLES]
  .map((role,i)=>{
    const {publicKey,privateKey}=generateKeyPairSync('ed25519');
    return [role,{publicKey,privateKey,keyId:'rolekey'+i}];
  }));
const publicKeys=Object.fromEntries(Object.entries(keys).map(
  ([role,k])=>[role,{keyId:k.keyId,publicKey:k.publicKey}]));
function signed(packet,roles,domain){
  return roles.map((role,i)=>{
    const statement={role,keyId:keys[role].keyId,
      nonce:sha(role).slice(0,32),decision:'reviewed',
      observedAt:'2026-11-19T11:59:45.000Z'};
    return {...statement,signature:sign(null,r34SigningBytes({
      domain,payload:packet,statement
    }),keys[role].privateKey).toString('base64')};
  });
}
const times=['2026-11-19T11:58:00.000Z',
  '2026-11-19T11:58:00.000Z','2026-11-19T11:59:00.000Z',
  '2026-11-19T12:00:00.000Z'];
async function hostFixture(){
  const statuses=[];
  let index=0;
  const result=await observeR34Staging({
    approved:true,pilotId:PILOT,sourceTreeSha:TREE,
    resolveIpv4:async()=>['8.8.8.8','1.1.1.1'],
    inspectTls:async()=>({authorized:true,serverName:'staging.osmanx.world',
      sha256:sha('valid cert')}),
    fetchStatus:async x=>{
      statuses.push(x);
      return x.path.includes('/health/')?200:401;
    },
    clock:()=>new Date(times[Math.min(index++,times.length-1)]),
    delay:async ms=>assert.equal(ms,30000)
  });
  assert.equal(statuses.length,10);
  for(const x of statuses){
    assert.equal(x.host,'staging.osmanx.world');
    assert.equal(x.method,'GET');
    assert.equal(x.ip,'8.8.8.8');
    assert.equal(x.path.startsWith('/api/industry/v1/'),true);
  }
  return result.record;
}
function signedBundle(host,customKeys=publicKeys){
  const dr=custody(),legal=client();
  return {evidence:{source:evaluateR34Source(sourceFixture()),host,
    custody:dr,custodyStatements:signed(dr,R34_CUSTODY_ROLES,
      'osmanx.guest.r34.offsite-custody.v1'),
    client:legal,clientStatements:signed(legal,R34_CLIENT_ROLES,
      'osmanx.guest.r34.client-authorization.v1')},
    trustedKeys:customKeys};
}
function r33Packet(){
  const {r24,r25,r26,decision}=buildR27SyntheticCase('normal');
  const handoff=makeR27Handoff({r24,r25,r26,audit:decision,
    rehearsal:runR27FirstClientRehearsal(),now:NOW});
  const r28=makeR28OperatorPacket({handoff,
    gate:evaluateR28ManualGate({handoff,now:NOW}),now:NOW});
  const r29=makeR29Report({r28,now:NOW});
  const r30=makeR30Report({r29,now:NOW});
  const r31=makeR31OperatorReport({r30,now:NOW});
  const r32=makeR32Readiness({r31,now:NOW});
  return makeR33Readiness({r32,now:NOW});
}
test('R34 exact 20 PR chain and actionable first pending manual review, no automatic merge',()=>{
  const f=sourceFixture(),x=evaluateR34Source(f);
  assert.equal(x.observedPrs,20);
  assert.equal(x.sourceCiPassed,true);
  assert.equal(x.humanSequence.at(-1).pr,68);
  assert.equal(x.nextManualAction.pr,47);
  assert.equal(x.nextManualAction.action,'REVIEW_AND_MERGE_ONE_PR');
  assert.equal(x.productionAuthorized,false);
  assert.equal(x.automaticMergeAllowed,false);
  assert.equal(x.postMergeMainCiPassed,false);
  assert.ok(evaluateR34Source({...f,checks:f.checks.slice(1)})
    .blockers.includes('R33_REQUIRED_JOBS_NOT_GREEN'));
  assert.ok(evaluateR34Source({...f,pr:{...f.pr,
    head:{...f.pr.head,sha:'f'.repeat(40)}}})
    .blockers.includes('R33_PR_HEAD_MOVED'));
});
test('R34 host: explicit approval, safe pinned public IP, TLS and two GET-only samples',async()=>{
  assert.equal(publicIpv4('127.0.0.1'),false);
  assert.equal(publicIpv4('10.2.2.2'),false);
  assert.equal(publicIpv4('169.254.1.1'),false);
  assert.equal(publicIpv4('192.168.2.4'),false);
  assert.equal(publicIpv4('203.0.113.7'),false);
  assert.equal(publicIpv4('8.8.8.8'),true);
  const x=await hostFixture();
  assert.equal(reviewR34HostEvidence(x,{pilotId:PILOT,
    sourceTreeSha:TREE,now:NOW}).locallyObservedHealthy,true);
  assert.equal(reviewR34HostEvidence({...x,
    tlsCertSha256:sha('changed')},{now:NOW}).locallyObservedHealthy,false);
  assert.equal(reviewR34HostEvidence(x,{pilotId:randomUUID(),
    now:NOW}).locallyObservedHealthy,false);
  const bad={...x,samples:x.samples.map((s,i)=>i?{
    ...s,observations:s.observations.map((p,n)=>n===2?
      {...p,status:200}:p)}:s)};
  assert.equal(reviewR34HostEvidence(bad,{now:NOW}).locallyObservedHealthy,false);
  let contact=0;
  await assert.rejects(observeR34Staging({
    approved:false,pilotId:PILOT,sourceTreeSha:TREE,
    resolveIpv4:async()=>{contact++;return ['8.8.8.8']},
    inspectTls:async()=>{},fetchStatus:async()=>200,
    delay:async()=>{}
  }),/approval/i);
  assert.equal(contact,0);
  await assert.rejects(observeR34Staging({
    approved:true,pilotId:PILOT,sourceTreeSha:TREE,
    resolveIpv4:async()=>['127.0.0.1'],
    inspectTls:async()=>{contact++;return {}},
    fetchStatus:async()=>{contact++;return 200},
    delay:async()=>{}
  }),/Unsafe/);
  assert.equal(contact,0);
});
test('R34 custody: dual distinct offsite AGE archive claims and signatures, RTO/RPO',()=>{
  const d=custody(),statements=signed(d,R34_CUSTODY_ROLES,
    'osmanx.guest.r34.offsite-custody.v1');
  const good=evaluateR34Custody({packet:d,statements,
    trustedKeys:publicKeys,now:NOW});
  assert.equal(good.metadataReadyForHumanAudit,true,JSON.stringify(good.blockers));
  assert.equal(good.measurements.length,2);
  assert.equal(good.measurements[0].rtoMinutes,1.5);
  assert.equal(good.measurements[0].rpoMinutes,1);
  assert.equal(good.independentlyVerifiedRealOffsite,false);
  assert.equal(good.productionAuthorized,false);
  assert.equal(evaluateR34Custody({packet:{...d,
    copies:[d.copies[0],d.copies[0]]},statements,
    trustedKeys:publicKeys,now:NOW}).metadataReadyForHumanAudit,false);
  assert.equal(evaluateR34Custody({packet:{...d,
    targetRtoMinutes:1},statements,
    trustedKeys:publicKeys,now:NOW}).metadataReadyForHumanAudit,false);
  assert.equal(evaluateR34Custody({packet:d,statements,
    trustedKeys:{},now:NOW}).metadataReadyForHumanAudit,false);
});
test('R34 client signed scope prevents PII, overlong retention and forged agreement',()=>{
  const c=client(),statements=signed(c,R34_CLIENT_ROLES,
    'osmanx.guest.r34.client-authorization.v1');
  const good=evaluateR34ClientScope({packet:c,statements,
    trustedKeys:publicKeys,now:NOW});
  assert.equal(good.signedScopeMetadataValid,true,JSON.stringify(good.blockers));
  assert.equal(good.legalBasisVerifiedExternally,false);
  for(const delta of [{retentionDays:180},{aggregatedOnly:false},
    {personalIdentifiersCollected:true},{thirdPartyExportAllowed:true},
    {productionCollectionAuthorized:true},
    {contractSha:sha('different')},{pilotId:randomUUID()}])
    assert.equal(evaluateR34ClientScope({packet:{...c,...delta},
      statements,trustedKeys:publicKeys,now:NOW})
      .signedScopeMetadataValid,false);
});
test('R34 final package is human-review eligible but always production NO-GO',async()=>{
  const host=await hostFixture(),{evidence,trustedKeys}=signedBundle(host);
  const result=evaluateR34Acceptance({evidence,trustedKeys,now:NOW});
  assert.equal(result.canSubmitToHumanAudit,true,JSON.stringify(result.blockers));
  assert.equal(result.productionAuthorized,false);
  assert.equal(result.customerGo,false);
  assert.equal(result.independentlyWitnessedOffsiteRestore,false);
  assert.equal(result.freshMergedMainCiVerified,false);
  assert.equal(evaluateR34Acceptance({evidence:{...evidence,
    client:{...evidence.client,pilotId:randomUUID()}},
    trustedKeys,now:NOW}).canSubmitToHumanAudit,false);
  assert.equal(evaluateR34Acceptance({evidence,
    trustedKeys:{...trustedKeys,
      data_protection_reviewer:trustedKeys.offsite_custodian},
    now:NOW}).canSubmitToHumanAudit,false);
});
test('R34 offline operator CLI accepts only pinned 4-role trust file, 256KiB limit and no PII output',async()=>{
  const host=await hostFixture(),{evidence}=signedBundle(host);
  const dir=await mkdtemp(join(tmpdir(),'r34-test-'));
  const file=join(dir,'trusted.json');
  try{
    const publicPem=Object.fromEntries(Object.entries(publicKeys).map(
      ([role,x])=>[role,{keyId:x.keyId,
        publicKey:x.publicKey.export({type:'spki',format:'pem'})}]));
    await writeFile(file,JSON.stringify(publicPem),{mode:0o600});
    const input=JSON.stringify(evidence);
    const execute=()=>runR34OfflineReview({stream:Readable.from([input]),
      trustFile:file,now:NOW});
    const x=await execute();
    assert.equal(x.canSubmitToHumanAudit,true,JSON.stringify(x.blockers));
    assert.equal(x.productionAuthorized,false);
    assert.equal(JSON.stringify(x).includes('PRIVATE KEY'),false);
    await chmod(file,0o666);
    await assert.rejects(execute(),/safe, regular/);
    await chmod(file,0o600);
    await assert.rejects(runR34OfflineReview({
      stream:Readable.from(['x'.repeat(256*1024+1)]),
      trustFile:file,now:NOW
    }),/256KiB/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('R34 chained API report remains tenant bound, SHA safe and expires ≤10 minutes',()=>{
  const r33=r33Packet(),report=makeR34Readiness({r33,now:NOW});
  assert.equal(report.source.requiredPrs,20);
  assert.equal(report.productionAuthorized,false);
  assert.equal(report.staging.realHttpsRequestsMadeByWebApi,0);
  assert.equal(verifyR34Readiness(report,{pilotId:r33.pilotId,now:NOW}).valid,true);
  assert.equal(verifyR34Readiness({...report,customerGo:true},{now:NOW}).valid,false);
  assert.equal(verifyR34Readiness({...report,blockers:[]},{now:NOW}).valid,false);
  assert.equal(verifyR34Readiness({...report,email:'x@example.test'},{now:NOW}).valid,false);
  assert.equal(verifyR34Readiness(report,{pilotId:randomUUID(),now:NOW}).valid,false);
  assert.equal(verifyR34Readiness(report,{
    now:new Date(report.expiresAt)}).valid,false);
  const csv=r34ReadinessCsv(report,{now:NOW});
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('NO-GO'));
  assert.equal(csv.includes('x@example.test'),false);
});
