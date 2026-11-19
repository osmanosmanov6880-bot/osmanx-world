import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {syntheticPermit} from './r15-synthetic-fixture.mjs';
import {
  inspectTenantPermit,permitMessage,loadTenantPermit,assertTenantPermission,
  readOutsideCheckout
} from '../src/guest-tenant-authorization.mjs';
import {decideR15,inspectR15} from '../scripts/r15-review.mjs';
import {PROBES,LOCAL} from '../scripts/r14-monitor.mjs';

const tenantId=randomUUID();
const clock=new Date();
const restoreEnv=Object.fromEntries([
 'NODE_ENV','GUEST_WRITES_ENABLED','GUEST_RELEASE_COMMIT','GUEST_R15_ADMISSION_FILE',
 'GUEST_R15_PERMIT_FILE','GUEST_R15_OWNER_PUBLIC_KEY','GUEST_R15_MANAGER_PUBLIC_KEY'
].map(name=>[name,process.env[name]]));
let fixture;
test.before(async()=>{
  fixture=await syntheticPermit(tenantId,clock);
  process.env.NODE_ENV='production';
  process.env.GUEST_WRITES_ENABLED='true';
});
test.after(async()=>{
  if(fixture)await fixture.cleanup();
  for(const [name,value] of Object.entries(restoreEnv))
    if(value===undefined)delete process.env[name];else process.env[name]=value;
});
function validate(permit=fixture.permit,admission=fixture.admission,tid=tenantId,now=clock){
  return inspectTenantPermit({permit,admission,
    keys:Object.fromEntries(['owner','manager'].map(role=>[role,
      fixture.keys[role].publicKey.export({type:'spki',format:'pem'})])),
    tenantId:tid,releaseCommit:'a'.repeat(40),now});
}
test('R15 binds owner+manager Ed25519 signatures to one tenant, one commit and R14 evidence',()=>{
  assert.equal(validate().permitValid,true);
  assert.equal(validate(undefined,undefined,randomUUID()).permitValid,false);
  assert.equal(validate({...fixture.permit,releaseCommit:'c'.repeat(40)}).permitValid,false);
  assert.equal(validate({...fixture.permit,admissionDigest:'c'.repeat(64)}).permitValid,false);
  assert.equal(validate({...fixture.permit,expiresAt:new Date(clock.getTime()-100).toISOString()}).permitValid,false);
  assert.equal(validate({...fixture.permit,attestations:[
    fixture.permit.attestations[0],fixture.permit.attestations[0]
  ]}).permitValid,false);
  assert.equal(validate({...fixture.permit,attestations:[
    fixture.permit.attestations[0],{...fixture.permit.attestations[1],actorId:'wrong-actor'}
  ]}).permitValid,false);
  assert.equal(validate({...fixture.permit,extra:true}).permitValid,false);
  assert.equal(validate(fixture.permit,{...fixture.admission,evidence:{
    ...fixture.admission.evidence,lawfulBasis:{...fixture.admission.evidence.lawfulBasis,ok:false}
  }}).permitValid,false);
  assert.equal(validate(fixture.permit,fixture.admission,tenantId,
    new Date(clock.getTime()+3*3600000)).permitValid,false);
  assert.match(permitMessage(fixture.permit,fixture.permit.attestations[0]),/tenantId/);
});
test('R15 external files fail closed, protected paths and independent tenant check',async()=>{
  const bundle=await loadTenantPermit(process.env,clock);
  assert.equal(assertTenantPermission(bundle,tenantId,clock),true);
  assert.throws(()=>assertTenantPermission(bundle,randomUUID(),clock),/не разрешена/);
  await assert.rejects(readOutsideCheckout('/etc/passwd',{privateFile:true}));
  const old=process.env.GUEST_R15_PERMIT_FILE;
  try{
    process.env.GUEST_R15_PERMIT_FILE='/nonexistent/r15-permit.json';
    await assert.rejects(loadTenantPermit(process.env,clock),/could not be verified/);
  }finally{process.env.GUEST_R15_PERMIT_FILE=old;}
  const contents=JSON.parse(await readFile(old,'utf8'));
  await writeFile(old,JSON.stringify({...contents,tenantId:randomUUID()}),{mode:0o600});
  await assert.rejects(loadTenantPermit(process.env,clock),/could not be verified/);
  await writeFile(old,JSON.stringify(contents),{mode:0o600});
});
test('R15 operator gate never mistakes a canary or incident for permission to collect',()=>{
  const valid={permitValid:true};
  const monitor={status:'healthy',guestWritesExpected:false,customerGoDecision:false};
  const incident={phase:'normal',event:'none',failures:0};
  assert.equal(decideR15({permitReport:valid,monitor,incident,tenantId}).technicalReviewPassed,true);
  assert.equal(decideR15({permitReport:valid,monitor:{...monitor,status:'degraded'},incident,tenantId}).technicalReviewPassed,false);
  assert.equal(decideR15({permitReport:valid,monitor,incident:{...incident,phase:'incident'},tenantId}).technicalReviewPassed,false);
  assert.equal(decideR15({permitReport:{permitValid:false},monitor,incident,tenantId}).technicalReviewPassed,false);
  assert.equal(decideR15({permitReport:valid,monitor,incident,tenantId}).writesChanged,false);
});
test('R15 canary review sends ONLY read-only GET checks and never invokes customer writes',async()=>{
  const calls=[];
  const fetcher=async(url,init)=>{
    calls.push({url,method:init.method,redirect:init.redirect});
    const probe=PROBES.find(x=>url.endsWith(x.path));
    assert.ok(probe);
    return {
      status:probe.status,
      headers:{get:key=>key==='content-type'?'application/json':null},
      json:async()=>probe.id==='live'?{status:'live'}:
        probe.id==='ready'?{
          status:'ready',database:'ok',schemaVersion:'011_guest_pilot_safety.sql',
          leastPrivilege:true,forcedRls:true,guestWritesEnabled:false
        }:{error:'authentication required'}
    };
  };
  const result=await inspectR15({tenantId,env:process.env,now:clock,fetcher});
  assert.equal(result.decision.technicalReviewPassed,true);
  assert.equal(result.decision.writesChanged,false);
  assert.equal(calls.length,PROBES.length);
  assert.ok(calls.every(c=>c.method==='GET'&&c.redirect==='error'&&c.url.startsWith(LOCAL)));
});
