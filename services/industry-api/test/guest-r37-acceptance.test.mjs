import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,chmod,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectR37CanaryTopology,inspectR37PrivateEnvironment,
  checkR37CanaryPreflight} from '../src/guest-r37-canary-guard.mjs';
import {evaluateR37DatabaseInspection,runR37VerifiedRestore}
  from '../src/guest-r37-dr-verified.mjs';
import {evaluateR37ImageProvenance}
  from '../src/guest-r37-image-provenance.mjs';
import {verifyR37DockerImage}
  from '../scripts/r37-verify-container.mjs';
import {R36_PIN,R37_MAIN_CI,evaluateR37ReleaseChain,
  evaluateR37PostMerge} from '../src/guest-r37-postmerge.mjs';
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
import {makeR36Readiness} from '../src/guest-r36-report.mjs';
import {makeR37Readiness,verifyR37Readiness,r37ReadinessCsv}
  from '../src/guest-r37-report.mjs';
const NOW=new Date('2026-11-19T12:00:00.000Z'),
  PILOT=randomUUID(),TREE='b'.repeat(40),
  SOURCE='a'.repeat(40),SHA='f'.repeat(64);
const CONTAINER='osmanx-guest-r14-canary-api-1',IMG='sha256:'+'d'.repeat(64);
const composeUrl=new URL('../ops/compose.r14.yml',import.meta.url);
function release(){
  return {schema:'osmanx.industry.r14.release.v1',
    commit:SOURCE.slice(0,12),fullCommit:SOURCE,
    latestMigration:'016_guest_r26_source_reviews.sql',
    guestWritesDefault:false};
}
function imageData(){
  return {expectedCommit:SOURCE,release:release(),
    containerName:CONTAINER,
    container:{running:true,imageId:IMG,
      networkMode:'osmanx-guest-r14-canary_r14_private',
      ports:{'3047/tcp':[{HostIp:'127.0.0.1',HostPort:'3150'}]}},
    image:{id:IMG,revision:SOURCE,guestWritesDefault:'false'}};
}
function sourceFixture(){
  const ids=[47,48,49,51,52,53,54,55,56,57,58,59,60,61,62,
    64,65,66,67,68,69,70];
  const prior={schema:'osmanx.guest.r36.twenty-two-pr-gate.v1',
    sourcePrsRequired:22,observedPrs:22,
    humanSequence:ids.map((pr,i)=>({order:i+1,pr,sourceSha:
      pr===70?'3e4d0609950fbc315947481cf4e431a0afe87e67':SOURCE}))
  };
  return {prior,pr:{number:71,draft:true,state:'open',merged:false,
    head:{ref:R36_PIN.head,sha:R36_PIN.sha},
    base:{ref:R36_PIN.base}},
    ci:R36_PIN.jobs.map(name=>({
      name,head_sha:R36_PIN.sha,status:'completed',conclusion:'success'})),
    compare:{status:'ahead',base:R36_PIN.parent,head:R36_PIN.sha},
    releaseCommit:{sha:R36_PIN.sha,tree:{sha:TREE}}};
}
function dbRow(after=false){
  return {database_name:'industry_dr_r36_trial123',
    server_ip:'127.0.0.1',server_port:5432,
    in_recovery:false,server_started:'2026-11-19T11:00:00.000Z',
    industry_schema_count:after?1:0,
    industry_relation_count:after?28:0,
    user_relation_count:after?28:0,
    unexpected_relation_count:0,migration_count:after?16:0};
}
function r36Fixture(){
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
    r34=makeR34Readiness({r33,now:NOW}),
    r35=makeR35Readiness({r34,now:NOW});
  return makeR36Readiness({r35,now:NOW});
}
test('R37 original R14 compose is isolated and rejects public port, worker, writes',async()=>{
  const src=await readFile(composeUrl,'utf8');
  assert.equal(inspectR37CanaryTopology(src).valid,true);
  assert.equal(inspectR37CanaryTopology(src.replace(
    '127.0.0.1:3150:3047','0.0.0.0:3150:3047')).valid,false);
  assert.equal(inspectR37CanaryTopology(src.replace(
    'GUEST_WRITES_ENABLED: "false"','GUEST_WRITES_ENABLED: "true"')).valid,false);
  assert.equal(inspectR37CanaryTopology(src+'\n  worker:\n    image: fake\n').valid,false);
  assert.equal(inspectR37CanaryTopology(src+'\n    ports: ["0.0.0.0:5050:3047"]\n').valid,false);
});
test('R37 actual private env lstat detects public perms, symlink, checkout and reads no secrets',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'r37canary-')),
    checkout=new URL('../',import.meta.url).pathname;
  try{
    const env=join(dir,'operator.env');
    await writeFile(env,'TEST_PRIVATE_VAR="synthetic"\n',{mode:0o600});
    let r=await checkR37CanaryPreflight({
      envPath:env,composePath:composeUrl.pathname,checkoutRoot:checkout});
    assert.equal(r.valid,true,JSON.stringify(r.errors));
    assert.equal(r.environmentRead,false);
    assert.equal(JSON.stringify(r).includes('synthetic'),false);
    await chmod(env,0o644);
    r=await checkR37CanaryPreflight({
      envPath:env,composePath:composeUrl.pathname,checkoutRoot:checkout});
    assert.equal(r.valid,false);
    assert.ok(r.errors.includes('PRIVATE_FILE_PERMISSIONS_TOO_OPEN'));
    const fakeStats={isFile:()=>true,isSymbolicLink:()=>false,
      size:100,mode:0o100600,uid:100};
    const same=inspectR37PrivateEnvironment({
      path:'/repo/secret.env',canonical:'/repo/secret.env',
      checkout:'/repo',stats:fakeStats,currentUid:100});
    assert.equal(same.valid,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('R37 live DB probe refuses existing tables, remote server and wrong database',()=>{
  assert.equal(evaluateR37DatabaseInspection({
    row:dbRow(),expectedName:'industry_dr_r36_trial123',phase:'before'}).valid,true);
  assert.equal(evaluateR37DatabaseInspection({
    row:dbRow(true),expectedName:'industry_dr_r36_trial123',phase:'after'}).valid,true);
  for(const row of [
    {...dbRow(),server_ip:'192.0.2.10'},
    {...dbRow(),industry_schema_count:1},
    {...dbRow(),unexpected_relation_count:1},
    {...dbRow(),database_name:'industry'},
    {...dbRow(),in_recovery:true}
  ])assert.equal(evaluateR37DatabaseInspection({
    row,expectedName:'industry_dr_r36_trial123',phase:'before'}).valid,false);
  assert.equal(evaluateR37DatabaseInspection({
    row:{...dbRow(true),migration_count:0},
    expectedName:'industry_dr_r36_trial123',phase:'after'}).valid,false);
});
test('R37 actual DB preflight before restore and after restore; no remote DB called',async()=>{
  const plan={schema:'osmanx.guest.r36.local-disposable-restore.v1',
    pilotId:PILOT,releaseSha:
      '3e4d0609950fbc315947481cf4e431a0afe87e67',
    sourceTreeSha:TREE,archiveSha256:SHA,
    archivePath:'/private/synthetic.age',identityFile:'/private/key.txt',
    issuedAt:'2026-11-19T11:59:00.000Z',
    expiresAt:'2026-11-19T12:04:00.000Z',
    nonce:'a'.repeat(32),allowedTargetDb:'industry_dr_r36_trial123'};
  const dbUrl='postgresql://operator:SECRET@127.0.0.1:5432/industry_dr_r36_trial123';
  let probes=[],restoreCalls=0;
  const probe=async({phase})=>{
    probes.push(phase);return dbRow(phase==='after');
  };
  const restore=async()=>{restoreCalls++;return {
    localDisposableRestoreExecuted:true,noProductionDatabaseUsed:true,
    productionAuthorized:false,sha256:SHA
  }};
  const out=await runR37VerifiedRestore({
    plan,dbUrl,approved:true,inspectDatabase:probe,
    executeR36Restore:restore,clock:()=>NOW});
  assert.deepEqual(probes,['before','after']);
  assert.equal(restoreCalls,1);
  assert.equal(out.afterSchemaMigrationsVerified,true);
  assert.equal(out.remoteOffsiteCustodyIndependentlyVerified,false);
  assert.equal(out.productionAuthorized,false);
  await assert.rejects(runR37VerifiedRestore({plan,
    dbUrl:'postgresql://operator:SECRET@outside.com/industry_dr_r36_trial123',
    approved:true,inspectDatabase:probe,executeR36Restore:restore,
    clock:()=>NOW}),/No explicit loopback/);
  assert.equal(restoreCalls,1);
  await assert.rejects(runR37VerifiedRestore({plan,dbUrl,approved:true,
    inspectDatabase:async()=>({...dbRow(),unexpected_relation_count:2}),
    executeR36Restore:restore,clock:()=>NOW
  }),/Existing or remote database refused/);
  assert.equal(restoreCalls,1);
});
test('R37 image provenance checks actual running image ID, loopback binding and SHA',()=>{
  const good=evaluateR37ImageProvenance(imageData());
  assert.equal(good.localMetadataConsistent,true,JSON.stringify(good.blockers));
  assert.equal(good.productionAuthorized,false);
  assert.equal(good.trustedBuildProvenanceCryptographicallyVerified,false);
  const f=imageData();
  f.container.ports['3047/tcp'][0].HostIp='0.0.0.0';
  assert.equal(evaluateR37ImageProvenance(f).localMetadataConsistent,false);
  const g=imageData();g.image.revision='e'.repeat(40);
  assert.equal(evaluateR37ImageProvenance(g).localMetadataConsistent,false);
  const h=imageData();h.container.imageId='sha256:'+'e'.repeat(64);
  assert.equal(evaluateR37ImageProvenance(h).localMetadataConsistent,false);
});
test('R37 operator Docker inspect uses restricted --format, refuses wrong release without calls',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'r37image-'));
  try{
    const file=join(dir,'RELEASE.json');
    await writeFile(file,JSON.stringify(release()),{mode:0o600});
    const calls=[];
    const execDocker=async(args)=>{
      calls.push(args);
      if(args[0]==='context')return 'default';
      if(args[0]==='container')
        return IMG+';true;'+JSON.stringify(imageData().container.ports)+
          ';osmanx-guest-r14-canary_r14_private';
      if(args[0]==='image')
        return IMG+';'+SOURCE+';false';
      throw Error('Unapproved Docker call');
    };
    const result=await verifyR37DockerImage({
      releaseFile:file,expectedCommit:SOURCE,approved:true,execDocker});
    assert.equal(result.localMetadataConsistent,true,JSON.stringify(result.blockers));
    assert.equal(calls.length,3);
    assert.equal(calls.every(x=>!x.includes('Env')),true);
    assert.equal(JSON.stringify(result).includes('SECRET'),false);
    await assert.rejects(verifyR37DockerImage({
      releaseFile:file,expectedCommit:'e'.repeat(40),
      approved:true,execDocker}),/mismatch before Docker access/);
    assert.equal(calls.length,3);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('R37 source checks 23 PR and honest postmerge gate',()=>{
  const f=sourceFixture(),source=evaluateR37ReleaseChain(f);
  assert.equal(source.observedPrs,23);
  assert.equal(source.r36CiPassed,true);
  assert.equal(source.blockers.length,0);
  assert.equal(source.mainChanged,false);
  const mergedAt='2026-11-19T11:00:00.000Z',
    prs=source.ordered.map(e=>({number:e.pr,
      head:{sha:e.sourceSha},draft:false,state:'closed',
      merged:true,merged_at:mergedAt})),
    mainSha='c'.repeat(40);
  const options={source,prs,
    mainRef:{ref:'refs/heads/main',object:{sha:mainSha}},
    mainCommit:{sha:mainSha,tree:{sha:TREE}},
    mainChecks:R37_MAIN_CI.map(name=>({name,head_sha:mainSha,
      status:'completed',conclusion:'success',
      completed_at:'2026-11-19T11:10:00.000Z'})),
    checksComplete:true,now:NOW};
  const done=evaluateR37PostMerge(options);
  assert.equal(done.exactSourcesMergedWithFreshMainCi,true,
    JSON.stringify(done.missingPrerequisites));
  assert.equal(done.productionAuthorized,false);
  assert.equal(done.operatorFinalChangeApprovalGranted,false);
  const blocked=evaluateR37PostMerge({...options,
    prs:prs.map(x=>x.number===47?{...x,draft:true,merged:false}:x)});
  assert.equal(blocked.exactSourcesMergedWithFreshMainCi,false);
  assert.ok(blocked.missingPrerequisites.some(x=>x.includes('PR_47')));
  assert.equal(evaluateR37PostMerge({...options,
    mainChecks:options.mainChecks.slice(1)})
    .exactSourcesMergedWithFreshMainCi,false);
  assert.equal(evaluateR37PostMerge({...options,
    mainCommit:{sha:mainSha,tree:{sha:'e'.repeat(40)}}})
    .exactSourcesMergedWithFreshMainCi,false);
});
test('R37 inherited tenant packet SHA-bound ≤10m, no guest writes and safe CSV',()=>{
  const r36=r36Fixture(),packet=makeR37Readiness({r36,now:NOW});
  assert.equal(packet.source.requiredPrs,23);
  assert.equal(packet.canary.dockerCallsFromWebApi,0);
  assert.equal(packet.image.liveContainerInspectionsFromWebApi,0);
  assert.equal(packet.disasterRecovery.localRestoreCallsFromWebApi,0);
  assert.equal(verifyR37Readiness(packet,{pilotId:r36.pilotId,now:NOW}).valid,true);
  assert.equal(verifyR37Readiness({...packet,productionAuthorized:true},
    {now:NOW}).valid,false);
  assert.equal(verifyR37Readiness({...packet,blockers:[]},
    {now:NOW}).valid,false);
  assert.equal(verifyR37Readiness({...packet,secret:'private'},
    {now:NOW}).valid,false);
  assert.equal(verifyR37Readiness(packet,{
    now:new Date(packet.expiresAt)}).valid,false);
  assert.ok(r37ReadinessCsv(packet,{now:NOW}).startsWith('\uFEFF'));
  assert.ok(r37ReadinessCsv(packet,{now:NOW}).includes('NO-GO'));
});
