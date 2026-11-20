import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import Fastify from 'fastify';
import {evaluateR38ComposePolicy,evaluateR38LocalDockerEndpoint}
  from '../src/guest-r38-compose.mjs';
import {inspectR38ComposeStdin}
  from '../scripts/r38-compose-policy.mjs';
import {evaluateR38BuildIdentity,evaluateR38SourceInput}
  from '../src/guest-r38-build.mjs';
import {registerR38BuildHealth}
  from '../src/guest-r38-build-route.mjs';
import {runR38LocalBuildProbe}
  from '../scripts/r38-local-build-probe.mjs';
import {evaluateR38RestoreTarget}
  from '../src/guest-r38-dr-preflight.mjs';
import {R37_PIN,evaluateR38Source,evaluateR38MainAncestry}
  from '../src/guest-r38-mainline.mjs';
import {buildR27SyntheticCase,runR27FirstClientRehearsal}
  from '../src/guest-r27-rehearsal.mjs';
import {makeR27Handoff} from '../src/guest-r27-handoff.mjs';
import {evaluateR28ManualGate}
  from '../src/guest-r28-stage-gate.mjs';
import {makeR28OperatorPacket}
  from '../src/guest-r28-operator-packet.mjs';
import {makeR29Report} from '../src/guest-r29-report.mjs';
import {makeR30Report} from '../src/guest-r30-report.mjs';
import {makeR31OperatorReport} from '../src/guest-r31-report.mjs';
import {makeR32Readiness} from '../src/guest-r32-report.mjs';
import {makeR33Readiness} from '../src/guest-r33-report.mjs';
import {makeR34Readiness} from '../src/guest-r34-report.mjs';
import {makeR35Readiness} from '../src/guest-r35-report.mjs';
import {makeR36Readiness} from '../src/guest-r36-report.mjs';
import {makeR37Readiness} from '../src/guest-r37-report.mjs';
import {makeR38Readiness,verifyR38Readiness,r38ReadinessCsv}
  from '../src/guest-r38-report.mjs';
const NOW=new Date('2026-11-19T12:00:00.000Z');
const SHA='a'.repeat(40),T='b'.repeat(40),PILOT=randomUUID();
function composeFixture(){
  const server=()=>({
    networks:{r14_private:null},security_opt:['no-new-privileges:true']
  });
  return {name:'osmanx-guest-r14-canary',
    services:{
      api:{...server(),read_only:true,init:true,tmpfs:['/tmp'],
        ports:[{target:3047,published:'3150',host_ip:'127.0.0.1',
          protocol:'tcp'}],
        environment:{GUEST_WRITES_ENABLED:'false',
          OSMANX_SOURCE_SHA:SHA},
        build:{args:{OSMANX_SOURCE_SHA:SHA}}},
      db:{...server(),image:'postgres:16',
        environment:{POSTGRES_DB:'guest_r14_canary'},
        volumes:[{target:'/var/lib/postgresql/data',
          type:'volume',source:'guest_r14_data'}]},
      provision:{...server(),profiles:['setup']},
      migrate:{...server(),profiles:['setup'],read_only:true},
      bootstrap:{...server(),profiles:['setup'],read_only:true}
    },
    networks:{r14_private:{driver:'bridge',
      name:'osmanx-guest-r14-canary_r14_private'}},
    volumes:{guest_r14_data:{
      name:'osmanx-guest-r14-canary_guest_r14_data'}}
  };
}
function reviewChain(){
  const ids=[47,48,49,51,52,53,54,55,56,57,58,59,60,61,62,
    64,65,66,67,68,69,70,71];
  const prior={schema:'osmanx.guest.r37.twenty-three-pr-postmerge.v1',
    sourcePrsRequired:23,observedPrs:23,blockers:[],
    ordered:ids.map((pr,i)=>({
      order:i+1,pr,sourceSha:pr===71?
        '8da6192969ec8a5d1d1523a6a605ba04d5299718':SHA
    }))};
  const pr={number:72,state:'open',draft:true,merged:false,
    head:{ref:R37_PIN.head,sha:R37_PIN.sha},
    base:{ref:R37_PIN.base}};
  return {prior,pr,
    checks:R37_PIN.jobs.map(name=>({
      name,head_sha:R37_PIN.sha,status:'completed',conclusion:'success'
    })),
    comparison:{base:R37_PIN.parent,head:R37_PIN.sha,status:'ahead'},
    commit:{sha:R37_PIN.sha,tree:{sha:T}}};
}
function reportFixture(){
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
    r35=makeR35Readiness({r34,now:NOW}),
    r36=makeR36Readiness({r35,now:NOW});
  return makeR37Readiness({r36,now:NOW});
}
test('R38 resolved compose is checked after interpolation, no secrets are returned',async()=>{
  const f=composeFixture();
  const ok=evaluateR38ComposePolicy({config:f,expectedCommit:SHA});
  assert.equal(ok.valid,true,JSON.stringify(ok.blockers));
  assert.equal(JSON.stringify(ok).includes('POSTGRES_ADMIN_PASSWORD'),false);
  const stdin=Readable.from([JSON.stringify({...f,secret:'password-hidden'})]);
  const run=await inspectR38ComposeStdin({input:stdin,sha:SHA});
  assert.equal(run.valid,true);
  assert.equal(JSON.stringify(run).includes('password-hidden'),false);
  const publicPort=composeFixture();
  publicPort.services.api.ports[0].host_ip='0.0.0.0';
  assert.equal(evaluateR38ComposePolicy({
    config:publicPort,expectedCommit:SHA}).valid,false);
  const writes=composeFixture();
  writes.services.api.environment.GUEST_WRITES_ENABLED='true';
  assert.equal(evaluateR38ComposePolicy({
    config:writes,expectedCommit:SHA}).valid,false);
  const extra=composeFixture();extra.services.webhook={};
  assert.equal(evaluateR38ComposePolicy({
    config:extra,expectedCommit:SHA}).valid,false);
  const stale=composeFixture();
  stale.services.api.build.args.OSMANX_SOURCE_SHA='c'.repeat(40);
  assert.equal(evaluateR38ComposePolicy({
    config:stale,expectedCommit:SHA}).valid,false);
  await assert.rejects(inspectR38ComposeStdin({
    input:Readable.from(['X'.repeat(256*1024+1)]),sha:SHA
  }),/exceeds limit/);
});
test('R38 Docker endpoint disallows remote TCP even when named default',()=>{
  assert.equal(evaluateR38LocalDockerEndpoint({
    context:'default',endpoint:'unix:///var/run/docker.sock'}).valid,true);
  assert.equal(evaluateR38LocalDockerEndpoint({
    context:'default',endpoint:'unix:///run/user/1000/docker.sock',uid:1000})
    .valid,true);
  for(const endpoint of ['tcp://127.0.0.1:2375',
    'tcp://203.0.113.2:2376','ssh://operator@somehost',
    'unix:///tmp/attacker.sock'])
    assert.equal(evaluateR38LocalDockerEndpoint({
      context:'default',endpoint}).valid,false);
});
test('R38 source clean SHA and SHA256-checked bundle, refuse edits and fake files',()=>{
  const bundle={schema:'osmanx.industry.r14.release.v1',
    commit:SHA.slice(0,12),fullCommit:SHA,guestWritesDefault:false};
  assert.equal(evaluateR38SourceInput({
    release:bundle,checksumVerified:true}).valid,true);
  assert.equal(evaluateR38SourceInput({
    release:bundle,checksumVerified:false}).valid,false);
  assert.equal(evaluateR38SourceInput({
    gitCommit:SHA,dirty:false}).valid,true);
  assert.equal(evaluateR38SourceInput({
    gitCommit:SHA,dirty:true}).valid,false);
});
test('R38 actual Fastify health/build is fail-closed for unsafe or missing SHA',async()=>{
  const make=async env=>{
    const app=Fastify({logger:false});
    registerR38BuildHealth(app,{env});
    const response=await app.inject({method:'GET',
      url:'/api/industry/v1/health/build'});
    await app.close();return response;
  };
  const okay=await make({NODE_ENV:'production',
    GUEST_WRITES_ENABLED:'false',OSMANX_SOURCE_SHA:SHA});
  assert.equal(okay.statusCode,200);
  assert.equal(okay.json().commit,SHA);
  assert.equal(okay.json().signedBuildProvenanceVerified,false);
  assert.equal(okay.headers['cache-control'],'no-store');
  assert.equal((await make({NODE_ENV:'production',
    GUEST_WRITES_ENABLED:'true',OSMANX_SOURCE_SHA:SHA})).statusCode,503);
  assert.equal((await make({NODE_ENV:'production',
    GUEST_WRITES_ENABLED:'false'})).statusCode,503);
  assert.equal((await make({NODE_ENV:'test',
    GUEST_WRITES_ENABLED:'false',OSMANX_SOURCE_SHA:SHA})).statusCode,503);
});
test('R38 loopback build probe validates real commit without logging response',async()=>{
  const body={status:'build',commit:SHA,guestWritesEnabled:false,
    provenance:'operator-self-reported',
    signedBuildProvenanceVerified:false};
  const fetcher=async(url,options)=>{
    assert.equal(url,'http://127.0.0.1:3150/api/industry/v1/health/build');
    assert.equal(options.method,'GET');
    assert.equal(options.redirect,'error');
    return {status:200,headers:{get:()=> 'application/json'},
      arrayBuffer:async()=>Buffer.from(JSON.stringify(body))};
  };
  const out=await runR38LocalBuildProbe({expectedSha:SHA,fetcher});
  assert.equal(out.valid,true);
  assert.equal(out.signedBuildProvenanceVerified,false);
  assert.equal(evaluateR38BuildIdentity({expectedSha:SHA,status:200,
    contentType:'application/json',
    json:{...body,commit:'c'.repeat(40)}}).valid,false);
  await assert.rejects(runR38LocalBuildProbe({expectedSha:SHA,
    fetcher:async()=>({status:200,headers:{get:()=> 'application/json'},
      arrayBuffer:async()=>Buffer.alloc(1025)})}),/limit/);
});
test('R38 direct restore refuses remote/production DB, symlink and unsafe AGE key',()=>{
  const regular=(mode=0o100600,size=400)=>({
    isFile:()=>true,isSymbolicLink:()=>false,size,mode
  });
  const opts={dbUrl:'postgresql://postgres:password@127.0.0.1:5432/industry_dr_r19_first',
    archive:'/tmp/copy.age',key:'/tmp/age.key',
    archiveStat:regular(),keyStat:regular(),
    checksumStat:regular(0o100600,120)};
  assert.equal(evaluateR38RestoreTarget(opts).valid,true);
  for(const dbUrl of [
    'postgresql://postgres:p@192.168.1.10:5432/industry_dr_r19_first',
    'postgresql://postgres:p@127.0.0.1:5432/industry_ci',
    'postgresql://postgres:p@127.0.0.1:5432/industry_dr_prod',
    'postgresql://postgres:p@127.0.0.1:5432/industry_dr_r19_first?sslmode=disable'
  ])assert.equal(evaluateR38RestoreTarget({...opts,dbUrl}).valid,false);
  assert.equal(evaluateR38RestoreTarget({
    ...opts,keyStat:regular(0o100644)}).valid,false);
  assert.equal(evaluateR38RestoreTarget({
    ...opts,archiveStat:{...regular(),isSymbolicLink:()=>true}}).valid,false);
});
test('R38 24-PR ancestry permits unrelated CINEMA commit, requires fresh main CI',()=>{
  const f=reviewChain(),source=evaluateR38Source(f);
  assert.equal(source.observedPrs,24);
  assert.equal(source.r37CiPassed,true);
  assert.deepEqual(source.blockers,[]);
  const mainSha='c'.repeat(40),when='2026-11-19T11:00:00.000Z';
  const prs=source.ordered.map(e=>({number:e.pr,head:{sha:e.sourceSha},
    state:'closed',merged:true,draft:false,merged_at:when}));
  const ci=R37_PIN.jobs.map(name=>({name,head_sha:mainSha,
    status:'completed',conclusion:'success',
    completed_at:'2026-11-19T11:05:00.000Z'}));
  const opts={source,prs,
    mainBefore:{ref:'refs/heads/main',object:{sha:mainSha}},
    mainAfter:{ref:'refs/heads/main',object:{sha:mainSha}},
    mainCommit:{sha:mainSha,tree:{sha:'e'.repeat(40)}},
    ancestry:{base:R37_PIN.sha,head:mainSha,
      status:'ahead',mergeBaseSha:R37_PIN.sha},
    checks:ci,checksComplete:true,now:NOW};
  const accepted=evaluateR38MainAncestry(opts);
  assert.equal(accepted.mergeCommitAncestryVerified,true,
    JSON.stringify(accepted.blockers));
  assert.equal(accepted.productionAuthorized,false);
  assert.equal(evaluateR38MainAncestry({...opts,
    mainAfter:{ref:'refs/heads/main',object:{sha:'f'.repeat(40)}}})
    .mergeCommitAncestryVerified,false);
  assert.equal(evaluateR38MainAncestry({...opts,
    ancestry:{...opts.ancestry,status:'diverged'}})
    .mergeCommitAncestryVerified,false);
  assert.equal(evaluateR38MainAncestry({...opts,
    checks:ci.map(x=>({...x,completed_at:'2026-11-19T10:00:00.000Z'}))})
    .mergeCommitAncestryVerified,false);
  assert.equal(evaluateR38MainAncestry({...opts,
    prs:prs.map(x=>x.number===47?{...x,merged:false,draft:true}:x)})
    .firstPendingPr,47);
});
test('R38 tenant SHA NO-GO packet rejects tampering, expiry and extra keys',()=>{
  const r37=reportFixture(),packet=makeR38Readiness({r37,now:NOW});
  assert.equal(packet.source.requiredPrs,24);
  assert.equal(packet.source.mergedPrsVerifiedInApi,0);
  assert.equal(packet.compose.operatorComposeCallsFromWebApi,0);
  assert.equal(packet.productionAuthorized,false);
  assert.equal(verifyR38Readiness(packet,{
    pilotId:r37.pilotId,now:NOW}).valid,true);
  assert.equal(verifyR38Readiness({...packet,productionAuthorized:true},
    {now:NOW}).valid,false);
  assert.equal(verifyR38Readiness({...packet,blockers:[]},{now:NOW}).valid,false);
  assert.equal(verifyR38Readiness({...packet,email:'private@example.test'},
    {now:NOW}).valid,false);
  assert.equal(verifyR38Readiness(packet,{
    now:new Date(packet.expiresAt)}).valid,false);
  const csv=r38ReadinessCsv(packet,{now:NOW});
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('NO-GO'));
  assert.equal(csv.includes('private@example.test'),false);
});
