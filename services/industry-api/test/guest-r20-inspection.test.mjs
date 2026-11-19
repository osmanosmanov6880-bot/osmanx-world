import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {protocolDigest} from '../src/guest-r19-scope.mjs';
import {inspectR20Pilot,R20_STATUS_SCHEMA} from '../src/guest-r20-inspection.mjs';
function fixture(){
  const now=new Date('2026-11-19T14:00:00.000Z'),
    tenantId=randomUUID(),pilotId=randomUUID();
  const pilot={id:pilotId,phase:'running',launch_gate_enrolled_at:now,
    protocol:{startDate:'2026-11-18',endDate:'2026-11-25',source:'pos',
      allocation:'matched',primaryMetric:'repeat_visit',outcomeWindowDays:7},
    protocol_registered_at:'2026-11-16T00:00:00.000Z'};
  const witness={sequence:3,checkpointDigest:'a'.repeat(64)};
  const anchor={receiptVerified:true,checkpointDigest:'a'.repeat(64)};
  const scope={valid:true,tenantId,pilotId,maxDailyWrites:5,
    expiresAt:'2026-11-20T00:00:00.000Z',
    record:{checkpointDigest:'a'.repeat(64),
      journalSequence:3,protocolDigest:protocolDigest(pilot),
      policy:{retentionDays:30}}};
  let used=2,events=2;
  const calls=[],db={async query(sql,params){
    calls.push({sql,params});
    if(sql.includes('guest_r19_daily_usage'))
      return {rowCount:1,rows:[{used_count:used,max_daily:5}]};
    if(sql.includes('guest_r19_collection_events'))
      return {rowCount:1,rows:[{n:events}]};
    throw Error('R20 unsafe SQL: '+sql);
  }};
  const args={tenantId,pilot,scope,permit:{permitValid:true},witness,
    anchor,now,hold:null};
  return {db,args,calls,setEvents:x=>events=x,setUsed:x=>used=x};
}
test('R20 owner inspection provides only non-secret aggregates and external blockers',async()=>{
  const f=fixture(),result=await inspectR20Pilot(f.db,f.args);
  assert.equal(result.schema,R20_STATUS_SCHEMA);
  assert.equal(result.technicalReviewPossible,true,JSON.stringify(result.technicalBlockers));
  assert.deepEqual(result.daily,{used:2,max:5,remaining:3,auditEvents:2});
  assert.equal(result.customerGo,false);assert.equal(result.legalGo,false);
  assert.equal(result.productionAuthorized,false);
  assert.equal(result.checks.legalEvidenceReviewed,false);
  assert.equal(result.checks.releaseChainVerified,false);
  assert.equal(result.checks.externalDrAttested,false);
  assert.equal(result.externalBlockers.length,3);
  assert.ok(f.calls.every(x=>x.sql.startsWith('SELECT')&&
    x.params[0]===f.args.tenantId&&x.params[1]===f.args.pilot.id));
});
test('R20 catches a stopped pilot, mismatched audit, wrong signed tenant and expired document',async()=>{
  const f=fixture();
  f.args.hold={active:true};
  f.setEvents(1);
  f.args.scope={...f.args.scope,tenantId:randomUUID()};
  f.args.now=new Date('2026-11-22T14:00:00.000Z');
  const result=await inspectR20Pilot(f.db,f.args);
  assert.equal(result.technicalReviewPossible,false);
  assert.ok(result.technicalBlockers.includes('noSafetyHold'));
  assert.ok(result.technicalBlockers.includes('r19ScopeExact'));
  assert.ok(result.technicalBlockers.includes('dailyAuditMatchesQuota'));
  assert.ok(result.technicalBlockers.includes('scopeInDate'));
});
test('R20 refuses malformed tenant or pilot IDs and never invokes SQL',async()=>{
  const f=fixture();
  await assert.rejects(inspectR20Pilot(f.db,{
    ...f.args,tenantId:'invalid'
  }),TypeError);
  await assert.rejects(inspectR20Pilot(f.db,{
    ...f.args,pilot:{id:'not-a-uuid'}
  }),TypeError);
  assert.equal(f.calls.length,0);
});
