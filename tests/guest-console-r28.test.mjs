import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,ui,guest,gate,source,packet,release]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r28-stage-gate.mjs'),
  read('services/industry-api/src/guest-r28-attestations.mjs'),
  read('services/industry-api/src/guest-r28-operator-packet.mjs'),
  read('services/industry-api/scripts/r28-release-plan.mjs')
]);
test('R28 premium RU manager view renders 7 steps, blockers and a short-lived handoff without HTML injection',()=>{
  for(const id of ['r28Panel','r28Heading','r28Status','r28Stage',
    'r28Verified','r28Expiry','r28Tasks','r28Blockers',
    'r28Next','r28Refresh','r28Download'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(ui,/async function loadR28OperatorStatus\(\)/);
  assert.match(ui,/await loadR28OperatorStatus\(\)/);
  assert.match(ui,/r28\/readiness/);
  assert.match(ui,/r28\/handoff\.csv/);
  assert.match(ui,/packet\.customerGo!==false/);
  assert.match(ui,/packet\.productionAuthorized!==false/);
  assert.match(ui,/packet\.operatorSteps\.length!==7/);
  assert.doesNotMatch(ui,/\binnerHTML\s*=|\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(html,/id="r28Merge"|id="r28EnableProduction"|id="r28LiftStop"/);
});
test('R28 strictly read-only per-pilot API never ingests external signatures via browser',()=>{
  assert.match(guest,/async function r28Readiness\(db,s,pilotId\)/);
  assert.match(guest,/const r27=await r27Readiness\(db,s,pilotId\)/);
  assert.match(guest,/chain:null,receipts:null,now/);
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r28\/readiness'/);
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r28\/handoff\.csv'/);
  assert.match(guest,/forTenant\(req,MANAGE/);
  assert.match(guest,/return reply\.send\(r28OperatorCsv\(report,\{now:checkedAt\}\)\)/);
  assert.doesNotMatch(guest,/app\.post\(P\+'\/pilots\/:id\/r28\//);
  assert.match(gate,/productionAuthorized:false/);
  assert.match(source,/permissionToDeploy:false/);
  assert.match(packet,/generatedAsHumanReviewOnly:true/);
  assert.match(release,/automaticMergeAllowed:false/);
});
