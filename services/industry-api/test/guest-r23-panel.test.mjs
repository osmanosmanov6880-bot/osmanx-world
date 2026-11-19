import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectR23Panel,PANEL_SCHEMA}
  from '../src/guest-r23-panel.mjs';
function fixture(){
  const tenantId=randomUUID(),pilot={id:randomUUID(),phase:'running'};
  return {tenantId,pilot,hold:null,
    scope:{valid:true,tenantId,pilotId:pilot.id},
    r20:{checks:{registeredProtocol:true,launchEnrolled:true},
      technicalReviewPossible:true},
    r21:{checks:{allMigrationsPresent:true,allSecurityTablesForcedRls:true,
      runtimeRoleUnprivileged:true,auditMatchesQuota:true,
      noOverRetentionDrift:true}}
  };
}
test('R23 owner handoff shows ten local checks and never treats them as legal GO',()=>{
  const r=inspectR23Panel(fixture());
  assert.equal(r.schema,PANEL_SCHEMA);
  assert.equal(r.localTechnicalPossible,true);
  assert.equal(r.checks.independentOffsiteDrVerified,false);
  assert.equal(r.checks.orderedPrMergesVerified,false);
  assert.equal(r.operatorSequence.length,7);
  assert.equal(r.customerGo,false);
  assert.equal(r.legalGo,false);
  assert.equal(r.productionAuthorized,false);
  assert.equal(r.onlyCurrentTenantReport,true);
  assert.equal(r.evidenceCollectionComplete,false);
  assert.equal(r.pending.length,6);
});
test('R23 revoked scope, safety stop and failed ledger are explicit blockers',()=>{
  const f=fixture();
  f.hold={active:true};
  f.scope={...f.scope,tenantId:randomUUID()};
  f.r21.checks.auditMatchesQuota=false;
  const r=inspectR23Panel(f);
  assert.equal(r.localTechnicalPossible,false);
  assert.equal(r.checks.noEmergencyStop,false);
  assert.equal(r.checks.independentSignedPilot,false);
  assert.equal(r.checks.immutableLedgerInSync,false);
  assert.equal(r.productionAuthorized,false);
});
test('R23 never accepts an unauthenticated or missing pilot model',()=>{
  assert.throws(()=>inspectR23Panel({tenantId:randomUUID()}),TypeError);
});
