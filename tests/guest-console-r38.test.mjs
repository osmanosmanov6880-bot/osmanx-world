import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,api,canary,dr,report,script]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/ops/r14-canary.sh'),
  read('services/industry-api/src/guest-r37-dr-verified.mjs'),
  read('services/industry-api/src/guest-r38-report.mjs'),
  read('services/industry-api/scripts/r37-local-dr.mjs')
]);
test('R38 Russian safe cabinet has a real load and safe refresh/export',()=>{
  for(const id of ['r38Panel','r38Heading','r38Status','r38Reviews',
    'r38Runtime','r38Recovery','r38Blockers','r38Refresh',
    'r38Download','r38Expiry'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(js,/async function loadR38Acceptance\(\)/);
  assert.match(js,/await loadR38Acceptance\(\)/);
  assert.match(js,/r38\/readiness/);
  assert.match(js,/r38\/report\.csv/);
  assert.match(js,/\$\('r38Panel'\)\.hidden=true/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
});
test('R38 API only provides tenant-MANAGE GETs and never executes operators',()=>{
  assert.match(api,/async function r38Readiness\(db,s,pilotId\)/);
  assert.match(api,/const r37=await r37Readiness\(db,s,pilotId\)/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r38\/readiness'/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r38\/report\.csv'/);
  assert.doesNotMatch(api,/app\.post\(P\+'\/pilots\/:id\/r38\//);
  assert.match(report,/productionAuthorized:false/);
  assert.match(canary,/r38-check-compose\.mjs/);
  assert.match(dr,/inspectR38DbState/);
  assert.match(script,/R38_DB_QUERY/);
});
