import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const get=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,ui,api,report,source,probe,signing]=await Promise.all([
  get('assets/guest/console.html'),
  get('assets/guest/console.js'),
  get('services/industry-api/src/guest.mjs'),
  get('services/industry-api/src/guest-r30-report.mjs'),
  get('services/industry-api/src/guest-r30-source-review.mjs'),
  get('services/industry-api/src/guest-r30-probe.mjs'),
  get('services/industry-api/src/guest-r30-evidence.mjs')
]);
test('R30 Russian cockpit is defensive, read-only and resets on logout',()=>{
  for(const id of ['r30Panel','r30Heading','r30Status','r30PrCount',
    'r30Signers','r30Expires','r30Blockers','r30Refresh','r30Download'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(ui,/async function loadR30Acceptance\(\)/);
  assert.match(ui,/await loadR30Acceptance\(\)/);
  assert.match(ui,/x\.productionAuthorized!==false/);
  assert.match(ui,/r30\/readiness/);
  assert.match(ui,/r30\/report\.csv/);
  assert.match(ui,/\$\('r30Panel'\)\.hidden=true/);
  assert.doesNotMatch(ui,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r30Deploy"|id="r30Merge"|id="r30StopLift"/);
});
test('R30 tenant-scoped MANAGE API exposes exactly two read-only routes',()=>{
  assert.match(api,/async function r30Readiness\(db,s,pilotId\)/);
  assert.match(api,/const r29=await r29Readiness\(db,s,pilotId\)/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r30\/readiness'/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r30\/report\.csv'/);
  assert.doesNotMatch(api,/app\.post\(P\+'\/pilots\/:id\/r30\//);
  assert.match(report,/productionAuthorized:false/);
  assert.match(source,/automaticMergeAllowed:false/);
  assert.match(probe,/realHostVerified:false/);
  assert.match(signing,/externalFactsAudited:false/);
});
