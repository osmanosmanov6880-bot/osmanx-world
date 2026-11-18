import test from 'node:test';
import assert from 'node:assert/strict';
import {launchPreflight,snapshotLaunch,SCHEMA} from '../src/guest-launch.mjs';
const now=new Date('2026-11-18T12:00:00Z');
const READINESS={
  repeatDefinition:true,sameWindow:true,independentGroups:true,
  marginVerified:true,contactConsent:true,ownerAgreed:true
};
const pilot={
  id:'00000000-0000-4000-8000-000000000021',
  phase:'draft',version:2,
  launch_gate_enrolled_at:'2026-11-18T12:00:00Z',
  protocol:{startDate:'2026-11-19',endDate:'2026-11-27',
    outcomeWindowDays:1,allocation:'random',source:'pos',primaryMetric:'repeat_visit'},
  protocol_registered_at:'2026-11-18T09:30:00Z',
  readiness:READINESS,target_per_group:294
};
const members=[
  {account_id:'owner-1',role:'owner',active:true},
  {account_id:'manager-1',role:'manager',active:true}
];
const approved=(role,actorId,hash)=>({
  role,actor_id:actorId,snapshot_digest:hash,
  accepted_at:'2026-11-18T11:00:00Z',expires_at:'2026-12-02T11:00:00Z'
});
test('R12 gate rejects missing human signoffs even with six existing flags',()=>{
  const result=launchPreflight({pilot,members,now});
  assert.equal(result.schema,SCHEMA);
  assert.equal(result.canStartIsolatedPilot,false);
  assert.equal(result.customerProductionAuthorized,false);
  assert.equal(result.blockers.map(x=>x.code).join(','),'ownerSigned,managerSigned,independent');
  assert.match(result.disclaimer,/не является электронной подписью/);
});
test('R12 both independent active roles on same frozen snapshot authorize isolated study start',()=>{
  const hash=launchPreflight({pilot,members,now}).snapshotDigest;
  const attestations=[approved('owner','owner-1',hash),approved('manager','manager-1',hash)];
  const r=launchPreflight({pilot,members,attestations,now});
  assert.equal(r.blockers.length,0);
  assert.equal(r.canStartIsolatedPilot,true);
  assert.equal(r.attestations.owner.actorId,'owner-1');
  assert.equal(r.attestations.manager.current,true);
});
test('R12 changed readiness immediately invalidates both old confirmations',()=>{
  const hash=launchPreflight({pilot,members,now}).snapshotDigest;
  const attestations=[approved('owner','owner-1',hash),approved('manager','manager-1',hash)];
  const changed={...pilot,readiness:{...READINESS,marginVerified:false}};
  const r=launchPreflight({pilot:changed,members,attestations,now});
  assert.equal(r.checks.sixReadiness,false);
  assert.equal(r.checks.ownerSigned,false);
  assert.equal(r.canStartIsolatedPilot,false);
  assert.notEqual(r.snapshotDigest,hash);
});
test('R12 expired, demoted, disabled or same-actor approvals never qualify',()=>{
  const hash=launchPreflight({pilot,members,now}).snapshotDigest;
  for(const [ms,signs] of [
    [members,[approved('owner','owner-1',hash),{...approved('manager','manager-1',hash),expires_at:'2026-11-17T00:00:00Z'}]],
    [[{account_id:'owner-1',role:'owner',active:true}],[
      approved('owner','owner-1',hash),approved('manager','manager-1',hash)]],
    [[{account_id:'owner-1',role:'owner',active:false},members[1]],[
      approved('owner','owner-1',hash),approved('manager','manager-1',hash)]],
    [members,[approved('owner','owner-1',hash),approved('manager','owner-1',hash)]]
  ]){
    const result=launchPreflight({pilot,members:ms,attestations:signs,now});
    assert.equal(result.canStartIsolatedPilot,false);
  }
});
test('R12 retroactive protocol, stale period and un-enrolled drafts fail closed',()=>{
  const hash=launchPreflight({pilot,members,now}).snapshotDigest;
  const signs=[approved('owner','owner-1',hash),approved('manager','manager-1',hash)];
  const old={...pilot,protocol_registered_at:'2026-11-20T00:00:00Z'};
  assert.ok(launchPreflight({pilot:old,members,attestations:signs,now}).blockers.some(x=>x.code==='prospective'));
  const stale={...pilot,protocol:{...pilot.protocol,endDate:'2026-11-01'}};
  assert.ok(launchPreflight({pilot:stale,members,attestations:signs,now}).blockers.some(x=>x.code==='measurementWindow'));
  assert.equal(launchPreflight({pilot:{...pilot,launch_gate_enrolled_at:null},members,attestations:signs,now}).canStartIsolatedPilot,false);
});
test('R12 digest binds pilot revision, protocol and target; prior signoffs cannot reactivate after reverting changes',()=>{
  const baseline=snapshotLaunch(pilot),hash=launchPreflight({pilot,members,now}).snapshotDigest;
  assert.notDeepEqual(snapshotLaunch({...pilot,version:900}),baseline);
  assert.notEqual(launchPreflight({pilot:{...pilot,version:900},members,now}).snapshotDigest,hash);
  assert.notEqual(launchPreflight({pilot:{...pilot,target_per_group:500},members,now}).snapshotDigest,hash);
  assert.notEqual(launchPreflight({pilot:{...pilot,protocol:{...pilot.protocol,source:'crm'}},members,now}).snapshotDigest,hash);
});
