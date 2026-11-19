import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,ui,guest,panel,merge,canary,isolation,packet]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r23-panel.mjs'),
  read('services/industry-api/scripts/r23-merge-plan.mjs'),
  read('services/industry-api/scripts/r23-http-canary.mjs'),
  read('services/industry-api/scripts/r23-tenant-isolation.mjs'),
  read('services/industry-api/scripts/r23-operator-handoff.mjs')
]);
test('R23 premium Russian screen displays manual sequence without production activator',()=>{
  for(const id of ['r23Panel','r23Heading','r23Status',
    'r23Checks','r23Steps','r23Refresh'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(ui,/async function loadR23Handoff\(\)/);
  assert.match(ui,/api\('\/guest\/pilots\/'\+model\.selected\.item\.id\+'\/r23\/handoff'\)/);
  assert.match(ui,/authorizedChangeWindowVerified/);
  assert.match(ui,/NO-GO/);
  assert.doesNotMatch(ui,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r23EnableProduction"/);
});
test('R23 API validates tenant via existing authenticated MANAGE contract and never allows write',()=>{
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r23\/handoff',req=>forTenant\(req,MANAGE/);
  assert.match(guest,/getPilot\(db,s\.tenant_id,req\.params\.id\)/);
  assert.match(guest,/loadR19Scope\(process\.env,anchor\)/);
  assert.match(guest,/await auditR21Database\(db/);
  assert.match(guest,/await inspectR20Pilot\(db/);
  assert.match(guest,/return inspectR23Panel/);
  assert.match(panel,/productionAuthorized:false/);
  assert.match(merge,/automaticMergeAllowed:false/);
  assert.match(canary,/customerGo:false/);
  assert.match(isolation,/READ ONLY/);
  assert.match(packet,/unsignedDocument:true/);
  assert.doesNotMatch(guest,/GUEST_WRITES_ENABLED\s*=\s*['"]true/);
});
