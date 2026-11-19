import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,ui,guest,audit,rehearsal,packet,graph]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r27-decision-audit.mjs'),
  read('services/industry-api/src/guest-r27-rehearsal.mjs'),
  read('services/industry-api/src/guest-r27-handoff.mjs'),
  read('services/industry-api/scripts/r27-release-plan.mjs')
]);
test('R27 premium Russian owner view separates synthetic runs, pilot state and NO-GO blockers',()=>{
  for(const id of ['r27Panel','r27Heading','r27Status','r27Passed',
    'r27Stage','r27Expiry','r27Cases','r27Blockers',
    'r27NextAction','r27Evidence','r27Refresh','r27Download'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(ui,/async function loadR27Readiness\(\)/);
  assert.match(ui,/await loadR27Readiness\(\)/);
  assert.match(ui,/r27\/readiness/);
  assert.match(ui,/r27\/rehearsal/);
  assert.match(ui,/r27\/handoff\.csv/);
  assert.match(ui,/packet\.customerGo!==false/);
  assert.match(ui,/rehearsal\.realCustomerDataUsed!==false/);
  assert.match(ui,/R27_HUMAN_MERGE_AND_CHANGE_TICKET_REQUIRED/);
  assert.doesNotMatch(ui,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r27MergeNow"|id="r27ProductionEnable"/);
});
test('R27 server exposes three GET routes only, tenant-scoped manager authorization and SHA evidence',()=>{
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r27\/readiness'/);
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r27\/rehearsal'/);
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r27\/handoff\.csv'/);
  assert.match(guest,/async function r27Readiness\(db,s,pilotId\)/);
  assert.match(guest,/await getPilot\(db,s\.tenant_id,pilotId\)/);
  assert.match(guest,/auditR27Decision\(\{r24,r25,r26\}\)/);
  assert.match(guest,/return makeR27Handoff\(\{r24,r25,r26,audit,rehearsal\}\)/);
  assert.match(guest,/return reply\.send\(r27HandoffCsv\(packet,\{now\}\)\)/);
  assert.match(audit,/customerGo:false/);
  assert.match(rehearsal,/realCustomerDataUsed:false/);
  assert.match(packet,/legalBasisVerified:false/);
  assert.match(graph,/automaticMergeAllowed:false/);
  assert.doesNotMatch(guest,/app\.post\(P\+'\/pilots\/:id\/r27\//);
});
