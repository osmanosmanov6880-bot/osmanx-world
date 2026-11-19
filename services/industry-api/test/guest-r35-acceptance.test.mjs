import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdtemp,writeFile,symlink,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {R34_PIN,evaluateR35Source,evaluateR35HumanReview}
  from '../src/guest-r35-source.mjs';
import {R35_STAGING_SCHEMA,runR35PinnedStaging}
  from '../src/guest-r35-staging.mjs';
import {hashR35RegularFile}
  from '../src/guest-r35-byte-proof.mjs';
import {auditR35ArchiveBytes}
  from '../src/guest-r35-archive-bytes.mjs';
import {auditR35LegalDocumentBytes}
  from '../src/guest-r35-document-bytes.mjs';
import {evaluateR35OperatorHandoff}
  from '../src/guest-r35-handoff.mjs';
import {runR35OperatorAudit}
  from '../scripts/r35-operator-audit.mjs';
import {r34SigningBytes} from '../src/guest-r34-quorum.mjs';
import {R33_PIN} from '../src/guest-r34-source.mjs';
import {R34_CUSTODY_SCHEMA,R34_CUSTODY_ROLES}
  from '../src/guest-r34-custody.mjs';
import {R34_CLIENT_SCHEMA,R34_CLIENT_ROLES}
  from '../src/guest-r34-client.mjs';
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
import {makeR35Readiness,verifyR35Readiness,r35ReadinessCsv}
  from '../src/guest-r35-report.mjs';

const NOW=new Date('2026-11-19T12:00:00.000Z');
const sha=x=>createHash('sha256').update(x).digest('hex');
const TENANT=randomUUID(),PILOT=randomUUID(),CHANGE=randomUUID();
const TREE='b'.repeat(40);
const KEYS=Object.fromEntries([...R34_CUSTODY_ROLES,...R34_CLIENT_ROLES]
  .map((role,i)=>{
    const {publicKey,privateKey}=generateKeyPairSync('ed25519');
    return [role,{publicKey,privateKey,keyId:'role'+i+'review'}];
  }));
const trustedKeys=Object.fromEntries(Object.entries(KEYS).map(
  ([r,k])=>[r,{keyId:k.keyId,publicKey:k.publicKey}]));
function sourceFixture(){
  const ids=[47,48,49,51,52,53,54,55,56,57,58,59,60,61,62,64,65,66,67,68];
  const prior={
    schema:'osmanx.guest.r34.twenty-pr-review.v1',
    sourcePrsRequired:20,observedPrs:20,mainSha:'a'.repeat(40),
    allHumanMerged:false,humanSequence:ids.map((pr,i)=>({
      pr,order:i+1,sourceSha:pr===68?
        '9957b916a3e72fbf7aba73d0e9da0f176013a037':
        'a'.repeat(40),reviewedAndMerged:false
    }))
  };
  return {prior,pr:{number:69,head:{ref:R34_PIN.head,sha:R34_PIN.sha},
    base:{ref:R34_PIN.base},draft:true,merged:false,state:'open'},
    checks:R34_PIN.jobs.map(name=>({name,head_sha:R34_PIN.sha,
      status:'completed',conclusion:'success'})),
    ancestry:{base:R34_PIN.parent,head:R34_PIN.sha,status:'ahead'},
    releaseCommit:{sha:R34_PIN.sha,tree:{sha:TREE}},
    mainCommit:{sha:'a'.repeat(40),tree:{sha:'c'.repeat(40)}}
  };
}
function reviewFixture(source){
  return evaluateR35HumanReview({source,pr:{
    number:47,head:{sha:'a'.repeat(40)},draft:true,merged:false,
    state:'open',user:{login:'repo-author'}},reviews:[],checks:[]});
}
function stagingProfile(){
  return {schema:R35_STAGING_SCHEMA,environment:'staging',
    origin:'https://staging.osmanx.world',
    releaseSha:R34_PIN.sha,sourceTreeSha:TREE,pilotId:PILOT,
    approvedIpv4:'8.8.8.8',approvedCertSha256:sha('approved certificate'),
    operatorNonce:'a'.repeat(32),
    issuedAt:'2026-11-19T11:57:00.000Z',
    expiresAt:'2026-11-19T12:05:00.000Z',
    allowWrites:false};
}
async function stagingFixture(override={}){
  let calls=0;const at=[
    '2026-11-19T12:00:00.000Z','2026-11-19T12:00:00.000Z',
    '2026-11-19T12:00:00.000Z','2026-11-19T12:01:00.000Z',
    '2026-11-19T12:01:00.000Z','2026-11-19T12:01:00.000Z'
  ];
  return runR35PinnedStaging({
    profile:stagingProfile(),approved:true,
    clock:()=>new Date(at[Math.min(calls++,at.length-1)]),
    delay:async ms=>assert.equal(ms,30000),
    resolveIpv4:async host=>{
      assert.equal(host,'staging.osmanx.world');
      return ['8.8.8.8'];
    },
    inspectTls:async({host,ip})=>{
      assert.equal(host,'staging.osmanx.world');
      assert.equal(ip,'8.8.8.8');
      return {authorized:true,serverName:host,
        sha256:sha('approved certificate')};
    },
    fetchStatus:async({host,ip,path,method})=>{
      assert.equal(host,'staging.osmanx.world');
      assert.equal(ip,'8.8.8.8');
      assert.equal(method,'GET');
      return path.includes('/health/')?200:401;
    },...override
  });
}
function signPacket(packet,roles,domain){
  return roles.map(role=>{
    const item={role,keyId:KEYS[role].keyId,
      nonce:sha(role).slice(0,32),decision:'reviewed',
      observedAt:'2026-11-19T11:59:45.000Z'};
    return {...item,signature:sign(null,r34SigningBytes({
      domain,payload:packet,statement:item
    }),KEYS[role].privateKey).toString('base64')};
  });
}
function custodyFixture(archives){
  return {
    schema:R34_CUSTODY_SCHEMA,tenantId:TENANT,pilotId:PILOT,
    releaseSha:R33_PIN.sha,treeSha:TREE,
    issuedAt:'2026-11-19T11:57:00.000Z',
    expiresAt:'2026-11-19T12:05:00.000Z',
    productionDatabaseTouched:false,
    targetRtoMinutes:5,targetRpoMinutes:5,
    copies:['A','B'].map((copyId,i)=>({
      copyId,storageRealm:i?'independent-region-b':'independent-region-a',
      archiveSha:archives[copyId],
      keyFingerprint:sha('key-'+copyId),
      restoreTarget:'industry_dr_r34_testcopy'+i,
      encryptedWithAge:true,restoredRows:25,
      restoredDataSha:sha('matching recovered rows'),
      restoreStartedAt:'2026-11-19T11:58:00.000Z',
      restoreFinishedAt:'2026-11-19T11:59:30.000Z',
      lastExpectedEventAt:'2026-11-19T11:59:00.000Z',
      lastRecoveredEventAt:'2026-11-19T11:58:00.000Z'
    }))
  };
}
const DOCS=['contract','processorAgreement','privacyNotice',
  'lawfulBasisOpinion','deletionProcedure'];
const FIELDS=['contractSha','processorAgreementSha','privacyNoticeSha',
  'lawfulBasisOpinionSha','deletionProcedureSha'];
function clientFixture(hashes){
  return {schema:R34_CLIENT_SCHEMA,tenantId:TENANT,pilotId:PILOT,
    changeId:CHANGE,releaseSha:R33_PIN.sha,treeSha:TREE,
    issuedAt:'2026-11-19T11:57:00.000Z',
    expiresAt:'2026-11-19T12:05:00.000Z',
    purpose:'guest_experience_aggregate',
    dataCategories:['aggregate-guest-metrics'],retentionDays:14,
    aggregatedOnly:true,personalIdentifiersCollected:false,
    thirdPartyExportAllowed:false,consentOrOtherBasisReviewed:true,
    productionCollectionAuthorized:false,
    ...Object.fromEntries(FIELDS.map((field,i)=>[field,hashes[DOCS[i]]]))
  };
}
async function filesFixture(dir){
  const archiveFiles={},docFiles={},archiveHashes={},docHashes={};
  for(const id of ['A','B']){
    const path=join(dir,'copy-'+id+'.age');
    const bytes=Buffer.from('age-encryption.org/v1\n---'+
      'encrypted-'+id.repeat(256));
    await writeFile(path,bytes,{mode:0o600});
    archiveFiles[id]=path;archiveHashes[id]=sha(bytes);
  }
  for(const name of DOCS){
    const path=join(dir,name+'.txt');
    const bytes=Buffer.from('Approved aggregate pilot document: '+
      name+' '.repeat(140)+' unique '+name);
    await writeFile(path,bytes,{mode:0o600});
    docFiles[name]=path;docHashes[name]=sha(bytes);
  }
  const custody=custodyFixture(archiveHashes),
    client=clientFixture(docHashes);
  const custodyStatements=signPacket(custody,R34_CUSTODY_ROLES,
    'osmanx.guest.r34.offsite-custody.v1'),
    clientStatements=signPacket(client,R34_CLIENT_ROLES,
      'osmanx.guest.r34.client-authorization.v1');
  return {archiveFiles,docFiles,custody,client,
    custodyStatements,clientStatements};
}
function r34Packet(){
  const {r24,r25,r26,decision}=buildR27SyntheticCase('normal');
  const handoff=makeR27Handoff({r24,r25,r26,audit:decision,
    rehearsal:runR27FirstClientRehearsal(),now:NOW});
  const r28=makeR28OperatorPacket({handoff,
    gate:evaluateR28ManualGate({handoff,now:NOW}),now:NOW});
  const r29=makeR29Report({r28,now:NOW});
  const r30=makeR30Report({r29,now:NOW});
  const r31=makeR31OperatorReport({r30,now:NOW});
  const r32=makeR32Readiness({r31,now:NOW});
  const r33=makeR33Readiness({r32,now:NOW});
  return makeR34Readiness({r33,now:NOW});
}

test('R35 21 PR source pinned and first pending PR47 requires real independent review',()=>{
  const f=sourceFixture(),source=evaluateR35Source(f);
  assert.equal(source.sourceCiPassed,true);
  assert.equal(source.observedPrs,21);
  assert.equal(source.firstPendingPr,47);
  assert.equal(source.automaticMergeAllowed,false);
  assert.equal(source.productionAuthorized,false);
  const review=reviewFixture(source);
  assert.equal(review.firstPendingPr,47);
  assert.equal(review.githubApprovedCurrentHead,false);
  assert.equal(review.manualNextAction,'MARK_PR_READY_FOR_REVIEW');
  assert.ok(review.blockers.includes('NO_INDEPENDENT_APPROVAL_FOR_HEAD'));
  const approved=evaluateR35HumanReview({source,pr:{
    number:47,head:{sha:'a'.repeat(40)},draft:false,merged:false,
    state:'open',user:{login:'repo-author'}},
    reviews:[{state:'APPROVED',commit_id:'a'.repeat(40),
      submitted_at:NOW.toISOString(),user:{login:'independent-user'}}],
    checks:[{head_sha:'a'.repeat(40),status:'completed',
      conclusion:'success'}]});
  assert.equal(approved.githubApprovedCurrentHead,true);
  assert.equal(approved.productionAuthorized,false);
  assert.equal(approved.manualNextAction,'INDEPENDENT_MERGE_DECISION_REQUIRED');
  const stale=evaluateR35HumanReview({source,pr:{
    number:47,head:{sha:'a'.repeat(40)},draft:false,merged:false,
    state:'open',user:{login:'repo-author'}},
    reviews:[{state:'APPROVED',commit_id:'f'.repeat(40),
      submitted_at:NOW.toISOString(),user:{login:'independent-user'}}],
    checks:[{head_sha:'a'.repeat(40),status:'completed',
      conclusion:'success'}]});
  assert.equal(stale.githubApprovedCurrentHead,false);
  assert.equal(evaluateR35Source({...f,checks:f.checks.slice(1)})
    .sourceCiPassed,false);
});
test('R35 fixed public DNS IP, certificate hash, allowed routes and profile expiry',async()=>{
  const good=await stagingFixture();
  assert.equal(good.dnsAndTlsPinned,true);
  assert.equal(good.observations,10);
  assert.equal(good.productionAuthorized,false);
  assert.equal(good.independentWitnessVerified,false);
  let calls=0;
  await assert.rejects(runR35PinnedStaging({
    profile:{...stagingProfile(),approvedIpv4:'127.0.0.1'},
    approved:true,clock:()=>NOW,
    resolveIpv4:async()=>{calls++;return ['8.8.8.8']},
    inspectTls:async()=>{},fetchStatus:async()=>200,
    delay:async()=>{}
  }),/approval/i);
  assert.equal(calls,0);
  await assert.rejects(runR35PinnedStaging({
    profile:stagingProfile(),approved:true,clock:()=>NOW,
    resolveIpv4:async()=>['8.8.4.4'],
    inspectTls:async()=>{calls++;return {}},
    fetchStatus:async()=>{calls++;return 200},
    delay:async()=>{}
  }),/DNS does not match/);
  assert.equal(calls,0);
  await assert.rejects(runR35PinnedStaging({
    profile:{...stagingProfile(),origin:'https://osmanx.world'},
    approved:true,clock:()=>NOW,
    resolveIpv4:async()=>{calls++;return ['8.8.8.8']},
    inspectTls:async()=>{},fetchStatus:async()=>200,
    delay:async()=>{}
  }),/approval/i);
  assert.equal(calls,0);
});
test('R35 byte audit truly hashes both AGE files and five documents, rejects tampering/symlinks',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'r35-bytes-'));
  try{
    const f=await filesFixture(dir);
    const archive=await auditR35ArchiveBytes({
      custody:f.custody,statements:f.custodyStatements,
      trustedKeys,archiveFiles:f.archiveFiles,now:NOW});
    assert.equal(archive.proofs.length,2);
    assert.equal(archive.actualDecryptionAndRestorationPerformed,false);
    const documents=await auditR35LegalDocumentBytes({
      client:f.client,statements:f.clientStatements,
      trustedKeys,documentFiles:f.docFiles,now:NOW});
    assert.equal(documents.proofs.length,5);
    assert.equal(documents.legalValidityIndependentlyEstablished,false);
    const alias=join(dir,'alias.age');
    await symlink(f.archiveFiles.A,alias);
    await assert.rejects(hashR35RegularFile({
      path:alias,expectedSha:f.custody.copies[0].archiveSha,
      maxBytes:1024*1024,requireAgeHeader:true
    }),/regular/);
    await writeFile(f.archiveFiles.B,
      Buffer.from('age-encryption.org/v1\n'+
        'altered-encrypted-material'.repeat(30)),{mode:0o600});
    await assert.rejects(auditR35ArchiveBytes({
      custody:f.custody,statements:f.custodyStatements,
      trustedKeys,archiveFiles:f.archiveFiles,now:NOW
    }),/do not match signed SHA/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('R35 linked offline audit is eligible for human examination but never production',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'r35-gate-'));
  try{
    const f=await filesFixture(dir),staging=await stagingFixture();
    const archive=await auditR35ArchiveBytes({
      custody:f.custody,statements:f.custodyStatements,
      trustedKeys,archiveFiles:f.archiveFiles,now:NOW});
    const documents=await auditR35LegalDocumentBytes({
      client:f.client,statements:f.clientStatements,
      trustedKeys,documentFiles:f.docFiles,now:NOW});
    const source=evaluateR35Source(sourceFixture()),
      review=reviewFixture(source);
    const out=evaluateR35OperatorHandoff({source,review,staging,
      archive,documents,client:f.client,custody:f.custody,now:NOW});
    assert.equal(out.eligibleForIndependentHumanReview,true,
      JSON.stringify(out.blockers));
    assert.equal(out.firstPendingPr,47);
    assert.equal(out.customerGo,false);
    assert.equal(out.productionAuthorized,false);
    assert.equal(out.realOffsiteRestoreExecuted,false);
    assert.equal(evaluateR35OperatorHandoff({source,review,
      staging:{...staging,pilotId:randomUUID()},
      archive,documents,client:f.client,custody:f.custody,now:NOW})
      .eligibleForIndependentHumanReview,false);
    assert.equal(evaluateR35OperatorHandoff({source,review,
      staging,archive,documents,client:{...f.client,
        tenantId:randomUUID()},custody:f.custody,now:NOW})
      .eligibleForIndependentHumanReview,false);
    const keys=Object.fromEntries(Object.entries(trustedKeys).map(
      ([role,item])=>[role,{keyId:item.keyId,
        publicKey:item.publicKey.export({type:'spki',format:'pem'})}]));
    const keyFile=join(dir,'pinned-public-keys.json');
    await writeFile(keyFile,JSON.stringify(keys),{mode:0o600});
    const evidence={source,review,staging,
      custody:f.custody,custodyStatements:f.custodyStatements,
      client:f.client,clientStatements:f.clientStatements,
      archiveFiles:f.archiveFiles,documentFiles:f.docFiles};
    const execute=()=>runR35OperatorAudit({
      trustFile:keyFile,stream:Readable.from([JSON.stringify(evidence)]),
      now:NOW});
    const result=await execute();
    assert.equal(result.eligibleForIndependentHumanReview,true,
      JSON.stringify(result.blockers));
    assert.equal(result.productionAuthorized,false);
    assert.equal(JSON.stringify(result).includes('Approved aggregate pilot document'),false);
    await chmod(keyFile,0o666);
    await assert.rejects(execute(),/trust file permissions/);
    await chmod(keyFile,0o600);
    await assert.rejects(runR35OperatorAudit({trustFile:keyFile,
      stream:Readable.from(['x'.repeat(256*1024+1)]),now:NOW
    }),/larger than 256KiB/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('R35 inherited 10 minute tenant packet SHA, PII exclusion and NO-GO',()=>{
  const r34=r34Packet(),p=makeR35Readiness({r34,now:NOW});
  assert.equal(p.source.requiredPrs,21);
  assert.equal(p.staging.networkCallsMadeByApi,0);
  assert.equal(p.archive.localFilesReadByApi,0);
  assert.equal(p.customerGo,false);
  assert.equal(verifyR35Readiness(p,{pilotId:r34.pilotId,now:NOW}).valid,true);
  assert.equal(verifyR35Readiness({...p,productionAuthorized:true},
    {now:NOW}).valid,false);
  assert.equal(verifyR35Readiness({...p,blockers:[]},
    {now:NOW}).valid,false);
  assert.equal(verifyR35Readiness({...p,email:'someone@example.test'},
    {now:NOW}).valid,false);
  assert.equal(verifyR35Readiness(p,{
    now:new Date(p.expiresAt)}).valid,false);
  const csv=r35ReadinessCsv(p,{now:NOW});
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('NO-GO'));
  assert.equal(csv.includes('someone@example.test'),false);
});
