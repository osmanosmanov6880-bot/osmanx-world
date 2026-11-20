import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {checkR39TargetUrl,checkR39TargetSnapshot,R39_EMPTY_SQL}
  from '../src/guest-r39-dr-guard.mjs';
import {preflightR39RestoreTarget}
  from '../scripts/r39-dr-preflight.mjs';
import {inspectR39ComposePrivileges}
  from '../src/guest-r39-compose-boundaries.mjs';
import {buildR39FirstPrPacket}
  from '../src/guest-r39-review-packet.mjs';
import {buildR39OperatorHandoff}
  from '../src/guest-r39-operator-handoff.mjs';
const NOW=new Date('2026-11-20T04:00:00.000Z');
const HEAD='840bb083e606058a9a32450f3b3a3e881a34891e';
const SHA='a'.repeat(40),HEX64='f'.repeat(64);
const url='postgresql://operator:secret@127.0.0.1:5432/industry_dr_r36_trial123';
function snapshot(){
  return {database_name:'industry_dr_r36_trial123',
    server_ip:'127.0.0.1',server_port:5432,
    in_recovery:false,server_started:'2026-11-20T02:00:00Z',
    non_system_relations:0,other_connections:0};
}
function compose(){
  const services={};
  for(const name of ['db','provision','migrate','bootstrap','api'])
    services[name]={networks:{r14_private:{}},ports:[]};
  services.db.volumes=[{type:'volume',
    source:'osmanx-guest-r14-canary_guest_r14_data',
    target:'/var/lib/postgresql/data'}];
  services.provision.volumes=[{type:'bind',
    source:'/private/checkout/ops/provision-roles.sh',
    target:'/ops/provision-roles.sh',read_only:true}];
  for(const n of ['migrate','bootstrap']){
    services[n].read_only=true;services[n].profiles=['setup'];
  }
  services.api.ports=[{host_ip:'127.0.0.1',published:3150,
    target:3047,protocol:'tcp'}];
  services.api.read_only=true;
  services.api.init=true;
  services.api.tmpfs=['/tmp'];
  services.api.security_opt=['no-new-privileges:true'];
  services.api.environment={NODE_ENV:'production',PORT:'3047',
    GUEST_WRITES_ENABLED:'false'};
  return {name:'osmanx-guest-r14-canary',services,
    networks:{r14_private:{driver:'bridge'}},
    volumes:{guest_r14_data:{name:'osmanx-guest-r14-canary_guest_r14_data'}}};
}
function review(){
  const files=[
    '.github/workflows/guest-r14-operations.yml',
    'docs/GUEST_INTELLIGENCE_R14.md',
    'services/industry-api/ops/build-release.sh',
    'services/industry-api/ops/compose.r14.yml',
    'services/industry-api/ops/r14-canary.sh',
    'services/industry-api/ops/verify-release.sh',
    'services/industry-api/scripts/r14-admission.mjs',
    'services/industry-api/scripts/r14-incident.mjs',
    'services/industry-api/scripts/r14-monitor.mjs',
    'services/industry-api/test/guest-r14.test.mjs'
  ];
  const pr={number:47,head:{sha:HEAD},
    base:{ref:'main'},state:'open',merged:false,draft:true,
    changed_files:10};
  const commit={sha:HEAD,tree:{sha:SHA}};
  return {pr,commit,
    files:files.map(filename=>({filename,
      patch:'@@ -0,0 +1,1 @@\n+R14 audit content',
      status:'added',additions:1,deletions:0})),
    filesComplete:true,review:{
      schema:'osmanx.guest.r38.first-review-policy.v1',
      currentHeadApprovalCount:0,
      outstandingChangeRequestCount:0,
      reviewSignalComplete:false
    }};
}
test('R39 direct restore accepts only loopback disposable DB and no query params',()=>{
  assert.equal(checkR39TargetUrl(url).valid,true);
  for(const bad of [
    'postgresql://operator:secret@db.internal:5432/industry_dr_r36_trial123',
    'postgresql://operator:secret@127.0.0.1:5432/industry_ci',
    'postgresql://operator:secret@127.0.0.1:5432/industry_dr_live',
    'postgresql://operator:secret@127.0.0.1:5432/industry_dr_r36_trial123?sslmode=disable',
    'postgresql://operator:secret@127.0.0.1:5434/industry_dr_r36_trial123',
    'file:///tmp/industry_dr_r36_trial123'
  ])assert.equal(checkR39TargetUrl(bad).valid,false,bad);
});
test('R39 DB snapshot rejects public relations, other sessions, nulls, wrong server',()=>{
  assert.match(R39_EMPTY_SQL,/pg_stat_activity/);
  assert.match(R39_EMPTY_SQL,/n\.nspname NOT IN/);
  assert.equal(checkR39TargetSnapshot(snapshot(),{
    expectedDb:'industry_dr_r36_trial123'}).valid,true);
  for(const x of [
    {...snapshot(),non_system_relations:1},
    {...snapshot(),non_system_relations:null},
    {...snapshot(),other_connections:1},
    {...snapshot(),other_connections:null},
    {...snapshot(),server_ip:'192.0.2.1'},
    {...snapshot(),database_name:'industry_ci'},
    {...snapshot(),in_recovery:true}
  ])assert.equal(checkR39TargetSnapshot(x,{
    expectedDb:'industry_dr_r36_trial123'}).valid,false);
});
test('R39 injected PG preflight never touches remote target or leaks connection credentials',async()=>{
  let connected=0,queried=0,closed=0;
  const factory=()=>({
    connect:async()=>{connected++},
    query:async(q)=>{queried++;assert.equal(q,R39_EMPTY_SQL);
      return {rowCount:1,rows:[snapshot()]}},
    end:async()=>{closed++}
  });
  const report=await preflightR39RestoreTarget({url,clientFactory:factory});
  assert.equal(report.emptyDatabaseVerified,true);
  assert.equal(report.productionAuthorized,false);
  assert.equal(connected,1);assert.equal(queried,1);assert.equal(closed,1);
  assert.ok(!JSON.stringify(report).includes('secret'));
  await assert.rejects(preflightR39RestoreTarget({
    url:'postgresql://operator:secret@remote.tld/industry_dr_r36_trial123',
    clientFactory:factory}),/R39 refused/);
  assert.equal(connected,1);
  await assert.rejects(preflightR39RestoreTarget({
    url,clientFactory:()=>({
      connect:async()=>{},query:async()=>({
        rowCount:1,rows:[{...snapshot(),non_system_relations:2}]}),
      end:async()=>{}
    })
  }),/user data/);
});
test('R39 Compose accepts approved canary and forbids host/system privileges',()=>{
  const good=inspectR39ComposePrivileges(compose());
  assert.equal(good.valid,true,JSON.stringify(good.blockers));
  assert.equal(good.credentialValuesReturned,false);
  const scenarios=[
    o=>{o.services.api.cap_add=['SYS_ADMIN']},
    o=>{o.services.api.devices=['/dev/kvm']},
    o=>{o.services.api.privileged=true},
    o=>{o.services.api.volumes=[{type:'bind',source:'/var/run/docker.sock',
      target:'/var/run/docker.sock'}]},
    o=>{o.services.db.volumes[0].target='/var/lib/mysql'},
    o=>{o.services.provision.volumes[0].read_only=false},
    o=>{o.services.migrate.profiles=[]},
    o=>{o.services.api.init=false},
    o=>{o.services.api.tmpfs=[]},
    o=>{o.services.db.network_mode='host'}
  ];
  for(const change of scenarios){
    const c=compose();change(c);
    assert.equal(inspectR39ComposePrivileges(c).valid,false,
      'Must refuse dangerous runtime drift');
  }
});
test('R39 reviewer packet binds all 10 exact PR47 patches and cannot approve',()=>{
  const fixture=review();
  const packet=buildR39FirstPrPacket(fixture);
  assert.equal(packet.blockers.length,0,JSON.stringify(packet.blockers));
  assert.equal(packet.fileCount,10);
  assert.ok(packet.reviewChecklist.length>=6);
  assert.equal(packet.manualReviewPerformedByThisTool,false);
  assert.equal(packet.productionAuthorized,false);
  assert.equal(packet.reviewSignal.reviewSignalComplete,false);
  const missing=buildR39FirstPrPacket({...fixture,
    files:fixture.files.slice(1),filesComplete:false});
  assert.ok(missing.blockers.length>0);
  const wrong=buildR39FirstPrPacket({...fixture,
    pr:{...fixture.pr,head:{sha:SHA}}});
  assert.ok(wrong.blockers.includes('PR47_DRIFT'));
  const altered=buildR39FirstPrPacket({...fixture,
    files:[{...fixture.files[0],patch:'@@ -1 +1 @@\n+tampered diff'},
      ...fixture.files.slice(1)]});
  assert.notEqual(altered.packetSha256,packet.packetSha256);
});
test('R39 operator handoff has actions even with complete local evidence',()=>{
  const report=buildR39OperatorHandoff({
    review:buildR39FirstPrPacket(review()),
    compose:{schema:'osmanx.guest.r38.rendered-compose.v1',
      valid:true,r39SandboxVerified:true},
    restore:{schema:'osmanx.guest.r39.readonly-preflight.v1',
      localHostValidated:true,emptyDatabaseVerified:true,
      productionAuthorized:false},
    image:{localMetadataConsistent:true,
      remoteVpsDeploymentVerified:false,productionAuthorized:false},
    now:NOW
  });
  assert.equal(report.totalSteps,7);
  assert.equal(report.readySteps,3);
  assert.equal(report.allExternalPrerequisitesVerified,false);
  assert.equal(report.productionAuthorized,false);
  assert.equal(report.guestWritesEnabled,false);
  assert.equal(report.customerGo,false);
  assert.ok(report.checks.some(x=>x.id==='PR47_HUMAN_REVIEW'&&!x.ready));
  assert.ok(report.checks.some(x=>x.id==='EXTERNAL_STAGING_AND_OFFSITE_DR'&&!x.ready));
  assert.match(report.sha256,/^[a-f0-9]{64}$/);
});
test('R39 actual restore shell mandates both DB probes and atomic restore',async()=>{
  const script=await readFile(new URL('../ops/restore-dr.sh',import.meta.url),'utf8');
  assert.equal((script.match(/r39-dr-preflight\.mjs/g)||[]).length,2);
  assert.match(script,/pg_restore --single-transaction --exit-on-error/);
  assert.match(script,/test ! -L "\$archive"/);
  assert.match(script,/test ! -L "\$AGE_IDENTITY_FILE"/);
  assert.match(script,/sha256sum -c/);
  assert.doesNotMatch(script,/pg_restore --jobs/);
});
