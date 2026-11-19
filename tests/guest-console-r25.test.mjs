import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,ui,guest,scope,budget,signals,board,experiment,brief,migration]=
  await Promise.all([
    read('assets/guest/console.html'),
    read('assets/guest/console.js'),
    read('services/industry-api/src/guest.mjs'),
    read('services/industry-api/src/guest-r19-scope.mjs'),
    read('services/industry-api/src/guest-r19-usage.mjs'),
    read('services/industry-api/src/guest-r25-signals.mjs'),
    read('services/industry-api/src/guest-r25-hypotheses.mjs'),
    read('services/industry-api/src/guest-r25-experiment.mjs'),
    read('services/industry-api/src/guest-r25-brief.mjs'),
    read('services/industry-api/migrations/015_guest_r25_operational_tallies.sql')
  ]);
test('R25 Russian manager UI has real API calls, closed-by-default form and no dynamic HTML injection',()=>{
  for(const id of ['r25Panel','r25Status','r25Sampled','r25Shifts',
    'r25Leader','r25Categories','r25Comparison','r25Hypotheses',
    'r25NextTest','r25EntryForm','r25EntryFieldset','r25Refresh',
    'r25Download','r25Date','r25Shift','r25Source','r25Sample',
    'r25Wait','r25Stockout','r25Ordering','r25Price','r25Service',
    'r25Unknown'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(html,/id="r25EntryFieldset" disabled/);
  assert.match(ui,/async function loadR25Insights\(\)/);
  assert.match(ui,/recordingAvailable!==true/);
  assert.match(ui,/guest\/pilots\/'\+model\.selected\.item\.id\+'\/r25\/insights/);
  assert.match(ui,/guest\/pilots\/'\+model\.selected\.item\.id\+'\/r25\/report\.csv/);
  assert.match(ui,/Idempotency-Key':idempotency\(\)/);
  assert.doesNotMatch(ui,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
});
test('R25 POST explicitly gated by separate env, R19 signed one-pilot chain and manager role',()=>{
  assert.match(guest,/app\.post\(r25Path,\(req,reply\)=>forTenant\(req,MANAGE/);
  assert.match(guest,/GUEST_R25_SIGNALS_ENABLED/);
  assert.match(guest,/r19Configured\(process\.env\)/);
  assert.match(guest,/await assertUnheld\(db,s\.tenant_id,pilot\.id\)/);
  assert.match(guest,/verifyVersion\(pilot,version\)/);
  assert.match(guest,/expectPhase\(pilot,\['running'\]\)/);
  assert.match(guest,/guest_r25_operational_tallies/);
  assert.match(scope,/operational-signals/);
  assert.match(budget,/operational-signals/);
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/GRANT SELECT,INSERT ON industry\.guest_r25_operational_tallies/);
  assert.match(migration,/guest_r25_tallies_immutable/);
  assert.doesNotMatch(migration,/GRANT SELECT,INSERT,UPDATE/);
});
test('R25 owner read-only insights / CSV never claim known individual motives or bypass legal GO',()=>{
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r25\/insights',req=>forTenant\(req,MANAGE/);
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r25\/report\.csv'/);
  assert.match(signals,/customerReportedReasonsVerified:false/);
  assert.match(board,/causalExplanationProven:false/);
  assert.match(experiment,/automaticExperimentStart:false/);
  assert.match(brief,/individualGuestsLinked:false/);
  assert.match(brief,/productionAuthorized:false/);
});
