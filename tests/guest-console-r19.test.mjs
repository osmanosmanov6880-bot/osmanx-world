import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const [html,ui,app,guest,scope,usage,migration,operator]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/app.mjs'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r19-scope.mjs'),
  read('services/industry-api/src/guest-r19-usage.mjs'),
  read('services/industry-api/migrations/014_guest_single_pilot_rollout.sql'),
  read('services/industry-api/scripts/r19-operator.mjs')
]);
test('R19 Russian workspace renders one selected pilot and never exposes controls to enable production',()=>{
  for(const id of ['r19Panel','r19Heading','r19Status','r19Checklist',
    'r19ProtocolHash','r19Refresh'])assert.ok(html.includes('id="'+id+'"'));
  assert.match(ui,/loadR19Preflight/);
  assert.match(ui,/api\('\/guest\/pilots\/'\+pilotId\+'\/r19\/preflight'\)/);
  assert.match(ui,/pilotCollection\.valid/);
  assert.match(ui,/withinDailyLimit/);
  assert.match(ui,/scopeExpiresAt/);
  assert.match(guest,/currentLaunchGate\(db,s\.tenant_id,pilot\)/);
  assert.match(guest,/scope\.record\.protocolDigest===fingerprint/);
  assert.match(guest,/customerGo:false,legalApprovalNotVerified:true/);
  assert.doesNotMatch(ui,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(ui,/GUEST_WRITES_ENABLED\s*=\s*['"]true/);
});
test('R19 is enforced on protected collection POST, not on emergency R13 stop, and is transaction-scoped',()=>{
  assert.match(scope,/R19 one-way STOP active/);
  assert.match(scope,/collectionOperation\(url,method\)/);
  assert.match(scope,/consentEvidenceSha/);
  assert.match(app,/await loadR19Scope\(process\.env,req\.r18Anchor\)/);
  assert.match(app,/await assertR19Pilot\(db,session\.tenant_id,collection\.pilotId,scopedPilot\)/);
  assert.match(app,/await assertR19Pilot\(db,session\.tenant_id,collection\.pilotId,latest\)/);
  assert.match(app,/if\(response\?\.duplicate!==true\)/);
  assert.match(app,/await consumeR19Budget\(db/);
  assert.match(app,/await assertR18Fence\(db,latestAnchor\)/);
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/guest_r19_collection_events_immutable/);
  assert.match(migration,/BEFORE UPDATE OR DELETE ON industry\.guest_r19_daily_usage/);
  assert.match(usage,/ON CONFLICT\(tenant_id,pilot_id,utc_day\) DO UPDATE/);
  assert.match(operator,/CONFIRM_R19_PERMANENT_STOP/);
  assert.doesNotMatch(operator,/unlink\(|rmSync|removeStop|autoResume/);
});
