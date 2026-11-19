import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,api,packet,cli,dr,graph]=await Promise.all([
  read('assets/guest/console.html'),
  read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r31-report.mjs'),
  read('services/industry-api/scripts/r31-approved-staging.mjs'),
  read('services/industry-api/src/guest-r31-dr-review.mjs'),
  read('services/industry-api/scripts/r31-review-github.mjs')
]);
test('R31 Russian UI has no publish, merge, network staging or arbitrary HTML action',()=>{
  for(const id of ['r31Panel','r31Heading','r31Status','r31Sources',
    'r31Witnesses','r31Expiry','r31Blockers','r31Refresh','r31Download'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(js,/async function loadR31Acceptance\(\)/);
  assert.match(js,/await loadR31Acceptance\(\)/);
  assert.match(js,/r31\/readiness/);
  assert.match(js,/r31\/report\.csv/);
  assert.match(js,/\$\('r31Panel'\)\.hidden=true/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r31Merge"|id="r31Deploy"|id="r31Start"|id="r31StopLift"/);
});
test('R31 API is read-only, scoped to manager and owner with no external evidence import',()=>{
  assert.match(api,/async function r31Readiness\(db,s,pilotId\)/);
  assert.match(api,/const r30=await r30Readiness\(db,s,pilotId\)/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r31\/readiness'/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r31\/report\.csv'/);
  assert.doesNotMatch(api,/app\.post\(P\+'\/pilots\/:id\/r31\//);
  assert.match(packet,/productionGo:false/);
  assert.match(cli,/--approved-staging/);
  assert.match(cli,/APPROVED_READ_ONLY_STAGING/);
  assert.doesNotMatch(cli,/https:\/\/osmanx\.world\b/);
  assert.match(dr,/externalCustodyIndependentlyVerified:false/);
  assert.match(graph,/method:'GET'/);
});
