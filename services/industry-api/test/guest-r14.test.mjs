import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {inspectAvailability,LOCAL,PROBES,assertMonitorOrigin} from '../scripts/r14-monitor.mjs';
import {evaluateAdmission,evidenceDigest,attestationMessage,REQUIRED_EVIDENCE,ADMISSION_SCHEMA} from '../scripts/r14-admission.mjs';
import {advanceIncident} from '../scripts/r14-incident.mjs';

const contentType={get:k=>k==='content-type'?'application/json':null};
function mockedFetch({badReady=false,leak=false,down=false}={}){
  return async (url,init)=>{
    assert.equal(init.method,'GET');
    assert.equal(init.redirect,'error');
    assert.equal(init.headers.Accept,'application/json');
    assert.equal(init.cache,'no-store');
    if(down)throw Error('offline');
    const spec=PROBES.find(x=>url.endsWith(x.path));
    assert.ok(spec);
    const status=spec.id==='ready'&&badReady?503:spec.id==='pilotsPrivate'&&leak?200:spec.status;
    const body=spec.id==='live'?{status:'live'}:spec.id==='ready'?
      {status:'ready',database:'ok',schemaVersion:'011_guest_pilot_safety.sql',
       leastPrivilege:true,forcedRls:true,guestWritesEnabled:false}:
      {error:'authentication required'};
    return {status,headers:contentType,json:async()=>body};
  };
}
test('R14 monitor verifies all endpoints, never writes or follows redirects',async()=>{
  assert.equal((await inspectAvailability({base:LOCAL,fetcher:mockedFetch()})).status,'healthy');
  assert.equal((await inspectAvailability({base:LOCAL,fetcher:mockedFetch({badReady:true})})).status,'degraded');
  assert.equal((await inspectAvailability({base:LOCAL,fetcher:mockedFetch({leak:true})})).status,'degraded');
  assert.equal((await inspectAvailability({base:LOCAL,fetcher:mockedFetch({down:true})})).status,'down');
  assert.throws(()=>assertMonitorOrigin('http://127.0.0.1:3047'));
  assert.throws(()=>assertMonitorOrigin('https://evil.example'));
});
test('R14 independent signoffs cryptographically bind release and evidence',()=>{
  const now=new Date('2026-11-18T10:00:00.000Z');
  const owner=generateKeyPairSync('ed25519');
  const manager=generateKeyPairSync('ed25519');
  const releaseCommit='a'.repeat(40);
  const evidence=Object.fromEntries(REQUIRED_EVIDENCE.map(name=>[name,
    {ok:true,sha256:'b'.repeat(64),observedAt:'2026-11-18T09:00:00.000Z'}]));
  const record={schema:ADMISSION_SCHEMA,releaseCommit,evidence};
  const signedDigest=evidenceDigest(record);
  record.attestations=['owner','manager'].map((role,index)=>{
    const entry={role,actorId:role+'-human',releaseCommit,evidenceDigest:signedDigest,
      acceptedAt:'2026-11-18T09:10:00.000Z',expiresAt:'2026-11-20T09:10:00.000Z'};
    const pair=index===0?owner:manager;
    return {...entry,signature:sign(null,Buffer.from(attestationMessage(entry)),
      pair.privateKey).toString('base64')};
  });
  const keys={owner:owner.publicKey.export({type:'spki',format:'pem'}),
    manager:manager.publicKey.export({type:'spki',format:'pem'})};
  assert.equal(evaluateAdmission(record,keys,now).operatorGo,true);
  assert.equal(evaluateAdmission(record,keys,now).productionWritesEnabled,false);
  record.evidence.lawfulBasis.ok=false;
  assert.equal(evaluateAdmission(record,keys,now).operatorGo,false);
  record.evidence.lawfulBasis.ok=true;
  record.attestations[1].actorId=record.attestations[0].actorId;
  assert.equal(evaluateAdmission(record,keys,now).operatorGo,false);
  record.attestations[1].actorId='manager-human';
  assert.equal(evaluateAdmission(record,{owner:keys.owner,manager:keys.owner},now).operatorGo,false);
  assert.equal(evaluateAdmission(record,keys,new Date('2026-12-19T10:00:00Z')).operatorGo,false);
});
test('R14 incident requires 3 failures and two successes to resolve',()=>{
  let state;
  for(let i=0;i<2;i++)state=advanceIncident(state,{status:'degraded'});
  assert.equal(state.phase,'normal');
  state=advanceIncident(state,{status:'down'});
  assert.equal(state.event,'opened');
  state=advanceIncident(state,{status:'healthy'});
  assert.equal(state.phase,'incident');
  state=advanceIncident(state,{status:'healthy'});
  assert.equal(state.event,'resolved');
  assert.equal(state.phase,'normal');
  assert.throws(()=>advanceIncident(state,{status:'unknown'}));
});
test('R14 canary has isolated topology and disabled writes',()=>{
  const compose=readFileSync(join(import.meta.dirname,'../ops/compose.r14.yml'),'utf8');
  assert.match(compose,/127\.0\.0\.1:3150:3047/);
  assert.match(compose,/GUEST_WRITES_ENABLED: "false"/);
  assert.doesNotMatch(compose,/profiles: \[integrations\]/);
  assert.match(compose,/guest_r14_data/);
  const script=readFileSync(join(import.meta.dirname,'../ops/r14-canary.sh'),'utf8');
  assert.match(script,/CONFIRM_ISOLATED_R14_NO_CUSTOMERS/);
  assert.match(script,/Refusing automatic overwrite or replay/);
  assert.doesNotMatch(script,/down -v/);
});
