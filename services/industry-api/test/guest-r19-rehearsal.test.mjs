import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {syntheticR19} from './r19-synthetic-fixture.mjs';
import {rehearseR19} from '../scripts/r19-first-client-rehearsal.mjs';
import {PROBES,LOCAL} from '../scripts/r14-monitor.mjs';

test('R19 read-only first-customer rehearsal never grants legal or customer GO',async t=>{
  const now=new Date(),ids=[randomUUID(),randomUUID()],pilotId=randomUUID();
  const dayOffset=n=>new Date(now.getTime()+n*86400000).toISOString().slice(0,10);
  const protocol={id:pilotId,protocol:{
    startDate:dayOffset(-2),endDate:dayOffset(7),outcomeWindowDays:7,
    allocation:'random',source:'pos',primaryMetric:'repeat_visit'
  },protocol_registered_at:new Date(now.getTime()-4*86400000)};
  const fx=await syntheticR19(ids,pilotId,protocol,{now});
  t.after(async()=>fx.cleanup());
  const visited=[];
  const fetcher=async(url,init)=>{
    visited.push({url,method:init.method,redirect:init.redirect});
    const probe=PROBES.find(x=>url.endsWith(x.path));
    assert.ok(probe);
    return {status:probe.status,
      headers:{get:key=>key==='content-type'?'application/json':null},
      json:async()=>probe.id==='live'?{status:'live'}:
        probe.id==='ready'?{status:'ready',database:'ok',
          schemaVersion:'011_guest_pilot_safety.sql',leastPrivilege:true,
          forcedRls:true,guestWritesEnabled:false}:{error:'authentication required'}
    };
  };
  const r=await rehearseR19({tenantId:ids[0],pilotId,env:fx.env,now,fetcher});
  assert.equal(r.r16PermitValid,true);
  assert.equal(r.r17WitnessValid,true);
  assert.equal(r.r18CustodianValid,true);
  assert.equal(r.r19PilotScopeValid,true);
  assert.equal(r.canaryHealthy,true);
  assert.equal(r.technicalPreflightReady,false);
  assert.equal(r.legalGo,false);
  assert.equal(r.customerGo,false);
  assert.equal(r.changedProduction,false);
  assert.equal(r.offsiteStorageVerified,false);
  assert.ok(r.blockers.includes('read_only_database_unavailable'));
  assert.ok(visited.length===PROBES.length);
  assert.ok(visited.every(x=>x.method==='GET'&&x.redirect==='error'&&
    x.url.startsWith(LOCAL)));
  const cross=await rehearseR19({tenantId:ids[1],pilotId,env:fx.env,now,fetcher});
  assert.equal(cross.r19PilotScopeValid,false);
  assert.ok(cross.blockers.includes('r19_wrong_tenant_or_pilot'));
});
