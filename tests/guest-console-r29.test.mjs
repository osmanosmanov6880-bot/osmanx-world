import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,ui,guest,stage,rollback,virtual,review]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r29-preflight.mjs'),
  read('services/industry-api/src/guest-r29-rollback.mjs'),
  read('services/industry-api/scripts/r29-merge-tree.mjs'),
  read('services/industry-api/scripts/r29-release-review.mjs')
]);
test('R29 Russian owner dashboard gives exact first PR review, five tasks and no publish switch',()=>{
  for(const id of [
    'r29Panel','r29Heading','r29Status','r29Reviewed','r29FirstPr',
    'r29Expiry','r29Tasks','r29Blockers','r29Next',
    'r29Refresh','r29Download'
  ])assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(ui,/async function loadR29Staging\(\)/);
  assert.match(ui,/await loadR29Staging\(\)/);
  assert.match(ui,/r29\/preflight/);
  assert.match(ui,/r29\/report\.csv/);
  assert.match(ui,/report\.requiredSourcePrs!==15/);
  assert.match(ui,/report\.customerGo!==false/);
  assert.doesNotMatch(ui,/\binnerHTML\s*=|\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(html,/id="r29Merge"|id="r29EnableProduction"|id="r29LiftStop"/);
});
test('R29 manager-only, read-only API gets pilot R28 snapshot before check and never trusts browser evidence',()=>{
  assert.match(guest,/async function r29Readiness\(db,s,pilotId\)/);
  assert.match(guest,/const r28=await r28Readiness\(db,s,pilotId\)/);
  assert.match(guest,/r28,chain:null,virtualMerge:null,rollback:null,now/);
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r29\/preflight'/);
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r29\/report\.csv'/);
  assert.match(guest,/forTenant\(req,MANAGE/);
  assert.match(guest,/r29HandoffCsv\(packet,\{now:verifiedAt\}\)/);
  assert.doesNotMatch(guest,/app\.post\(P\+'\/pilots\/:id\/r29\//);
  assert.match(stage,/productionAuthorized:false/);
  assert.match(rollback,/productionDatabaseTouched:false/);
  assert.match(virtual,/realMergePerformed:false/);
  assert.match(review,/automaticMergeAllowed:false/);
});
test('R29 no real production DB drill and no external auto-merge',()=>{
  assert.match(rollback,/process\.env\.NODE_ENV!=='test'/);
  assert.match(rollback,/SYNTHETIC_DB\.test\(name/);
  assert.match(rollback,/ROLLBACK/);
  assert.match(virtual,/merge-tree/);
  assert.match(virtual,/mainRefUnchanged:true/);
  assert.doesNotMatch(virtual,/execFileSync\('git'.*push/);
});
