import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inspectR38RenderedCompose}
  from '../src/guest-r38-compose-runtime.mjs';
import {checkR38Compose}
  from '../scripts/r38-check-compose.mjs';
import {inspectR38DbState,proofR38Restore,R38_DB_QUERY}
  from '../src/guest-r38-dr-safety.mjs';
import {evaluateR38CurrentReview}
  from '../src/guest-r38-review-policy.mjs';
import {evaluateR38Evidence}
  from '../src/guest-r38-rollout-evidence.mjs';
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
import {makeR37Readiness} from '../src/guest-r37-report.mjs';
import {makeR38Readiness,verifyR38Readiness,r38ReadinessCsv}
  from '../src/guest-r38-report.mjs';
const NOW=new Date('2026-11-19T12:00:00.000Z');
const HEAD='840bb083e606058a9a32450f3b3a3e881a34891e';
const HASH='a'.repeat(64);
function compose(){
  const services={};
  for(const name of ['db','provision','migrate','bootstrap','api']){
    services[name]={networks:{r14_private:{}},ports:[],
      security_opt:['no-new-privileges:true']};
  }
  services.db.volumes=[{type:'volume',
    source:'osmanx-guest-r14-canary_guest_r14_data',
    target:'/var/lib/postgresql/data'}];
  services.provision.volumes=[{type:'bind',
    source:fileURLToPath(new URL('../ops/provision-roles.sh',import.meta.url)),
    target:'/ops/provision-roles.sh',read_only:true}];
  for(const name of ['migrate','bootstrap']){
    services[name].read_only=true;
    services[name].profiles=['setup'];
  }
  services.api.init=true;
  services.api.tmpfs=['/tmp'];
  services.api.ports=[{host_ip:'127.0.0.1',published:3150,
    target:3047,protocol:'tcp'}];
  services.api.environment={GUEST_WRITES_ENABLED:'false',
    NODE_ENV:'production',PORT:'3047'};
  services.api.read_only=true;
  services.api.security_opt=['no-new-privileges:true'];
  return {name:'osmanx-guest-r14-canary',
    services,networks:{r14_private:{driver:'bridge'}}};
}
function row(after=false){
  return {database_name:'industry_dr_r36_trial123',server_ip:'127.0.0.1',
    server_port:5432,in_recovery:false,
    server_started:'2026-11-19T11:00:00Z',
    user_relation_count:after?28:0,
    industry_relation_count:after?28:0,
    migration_count:after?16:0};
}
function previous(){
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
test('R38 actually validates resolved Compose configuration and refuses public ports',()=>{
  const good=inspectR38RenderedCompose(compose());
  assert.equal(good.valid,true,good.blockers.join(','));
  assert.equal(good.secretsReturned,false);
  const publicPort=compose();
  publicPort.services.api.ports[0].host_ip='0.0.0.0';
  assert.equal(inspectR38RenderedCompose(publicPort).valid,false);
  const apiWritable=compose();
  apiWritable.services.api.environment.GUEST_WRITES_ENABLED='true';
  assert.equal(inspectR38RenderedCompose(apiWritable).valid,false);
  const service=compose();
  service.services.worker={networks:{r14_private:{}}};
  assert.equal(inspectR38RenderedCompose(service).valid,false);
  const otherPort=compose();
  otherPort.services.db.ports=[{host_ip:'127.0.0.1',
    published:5432,target:5432,protocol:'tcp'}];
  assert.equal(inspectR38RenderedCompose(otherPort).valid,false);
});
test('R38 rendered Compose tool does not leak resolved env passwords',async()=>{
  const f=compose(),password='synthetic-secret-db-password';
  f.services.db.environment={POSTGRES_PASSWORD:password};
  let calls=0;
  const result=await checkR38Compose({envFile:'/tmp/operator.env',
    runner:async args=>{
      calls++;
      assert.equal(args.at(-3),'config');
      assert.equal(args.at(-2),'--format');
      assert.equal(args.at(-1),'json');
      return JSON.stringify(f);
    }
  });
  assert.equal(result.valid,true);
  assert.equal(calls,1);
  assert.equal(JSON.stringify(result).includes(password),false);
  await assert.rejects(checkR38Compose({envFile:'relative.env',
    runner:async()=>{calls++}}),/local Docker/);
  assert.equal(calls,1);
});
test('R38 counts public schema tables and refuses reused local database',()=>{
  assert.match(R38_DB_QUERY,/n\.nspname NOT IN \('pg_catalog','information_schema'\)/);
  assert.equal(inspectR38DbState(row(),{
    expectedName:'industry_dr_r36_trial123'}).valid,true);
  assert.equal(inspectR38DbState({...row(),user_relation_count:1},{
    expectedName:'industry_dr_r36_trial123'}).valid,false);
  assert.equal(inspectR38DbState({...row(),server_ip:'192.0.2.3'},{
    expectedName:'industry_dr_r36_trial123'}).valid,false);
  const restored=inspectR38DbState(row(true),{
    expectedName:'industry_dr_r36_trial123',phase:'after',
    initialServer:row()});
  assert.equal(restored.valid,true);
  assert.equal(inspectR38DbState({...row(true),
    server_started:'2026-11-19T11:10:00Z'},{
    expectedName:'industry_dr_r36_trial123',phase:'after',
    initialServer:row()}).valid,false);
  const proof=proofR38Restore({before:{valid:true},after:restored,
    operatorResult:{sha256:HASH,localDisposableRestoreExecuted:true,
      productionAuthorized:false}});
  assert.equal(proof.productionAuthorized,false);
  assert.equal(proof.realOffsiteWitness,false);
});
test('R38 reviewer ledger drops stale approval after CHANGES_REQUESTED',()=>{
  const pr={number:47,state:'open',draft:false,merged:false,
    head:{sha:HEAD},user:{login:'author'}};
  const review=(state,id,time,commit=HEAD)=>({
    id,state,submitted_at:time,commit_id:commit,
    user:{login:'independent'}});
  const checks=[{head_sha:HEAD,status:'completed',
    conclusion:'success'}];
  const argumentsBase={pr,requiredHead:HEAD,
    reviewsComplete:true,checks,checksComplete:true};
  assert.equal(evaluateR38CurrentReview({...argumentsBase,
    reviews:[review('APPROVED',1,'2026-11-19T10:00:00Z')]}
  ).reviewSignalComplete,true);
  const revoked=evaluateR38CurrentReview({...argumentsBase,
    reviews:[review('APPROVED',1,'2026-11-19T10:00:00Z'),
      review('CHANGES_REQUESTED',2,'2026-11-19T10:01:00Z')]});
  assert.equal(revoked.reviewSignalComplete,false);
  assert.equal(revoked.outstandingChangeRequestCount,1);
  assert.equal(evaluateR38CurrentReview({...argumentsBase,
    reviews:[review('APPROVED',1,'2026-11-19T10:00:00Z','f'.repeat(40))]}
  ).reviewSignalComplete,false);
  assert.equal(evaluateR38CurrentReview({...argumentsBase,
    pr:{...pr,draft:true},
    reviews:[review('APPROVED',1,'2026-11-19T10:00:00Z')]}
  ).reviewSignalComplete,false);
});
test('R38 combined evidence never authorizes production, even if local checks all pass',()=>{
  const x=evaluateR38Evidence({
    compose:{schema:'osmanx.guest.r38.rendered-compose.v1',
      valid:true,productionAuthorized:false},
    dr:{schema:'osmanx.guest.r38.local-restore-proof.v1',
      localDbVerified:true,realOffsiteWitness:false,productionAuthorized:false},
    image:{localMetadataConsistent:true,
      remoteVpsDeploymentVerified:false,productionAuthorized:false},
    review:{schema:'osmanx.guest.r38.first-review-policy.v1',
      reviewSignalComplete:true,mergePermissionGranted:false}
  });
  assert.equal(x.localEvidenceReadyForIndependentHumanReview,true);
  assert.equal(x.productionAuthorized,false);
  assert.equal(x.customerGo,false);
  assert.equal(evaluateR38Evidence({}).localEvidenceReadyForIndependentHumanReview,false);
});
test('R38 short-lived read-only report rejects GO and cross-pilot replay',()=>{
  const r37=previous(),packet=makeR38Readiness({r37,now:NOW});
  assert.equal(packet.source.requiredPrs,24);
  assert.equal(packet.runtime.liveDockerCallsInApi,0);
  assert.equal(packet.recovery.localRestoresInApi,0);
  assert.equal(verifyR38Readiness(packet,{pilotId:r37.pilotId,now:NOW}).valid,true);
  assert.equal(verifyR38Readiness({...packet,customerGo:true},{now:NOW}).valid,false);
  assert.equal(verifyR38Readiness({...packet,blockers:[]},{now:NOW}).valid,false);
  assert.equal(verifyR38Readiness({...packet,email:'secret@example.test'},{now:NOW}).valid,false);
  assert.equal(verifyR38Readiness(packet,{pilotId:randomUUID(),now:NOW}).valid,false);
  assert.equal(verifyR38Readiness(packet,{now:new Date(packet.expiresAt)}).valid,false);
  const csv=r38ReadinessCsv(packet,{now:NOW});
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('NO-GO'));
});
