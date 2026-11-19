import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,api,source,host,custody,client,report,cli]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r34-source.mjs'),
  read('services/industry-api/src/guest-r34-host-evidence.mjs'),
  read('services/industry-api/src/guest-r34-custody.mjs'),
  read('services/industry-api/src/guest-r34-client.mjs'),
  read('services/industry-api/src/guest-r34-report.mjs'),
  read('services/industry-api/scripts/r34-operator-staging.mjs')
]);
test('R34 Russian cockpit is scoped, read-only and hidden at logout',()=>{
  for(const id of ['r34Panel','r34Heading','r34Status','r34PrCount',
    'r34Staging','r34External','r34Blockers','r34Expiry',
    'r34Refresh','r34Download'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(js,/async function loadR34Acceptance\(\)/);
  assert.match(js,/await loadR34Acceptance\(\)/);
  assert.match(js,/r34\/readiness/);
  assert.match(js,/r34\/report\.csv/);
  assert.match(js,/\$\('r34Panel'\)\.hidden=true/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r34Deploy"|id="r34Merge"|id="r34StopLift"/);
});
test('R34 Web API has two MANAGE GETs only, zero external evidence acceptance',()=>{
  assert.match(api,/async function r34Readiness\(db,s,pilotId\)/);
  assert.match(api,/const r33=await r33Readiness\(db,s,pilotId\)/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r34\/readiness'/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r34\/report\.csv'/);
  assert.doesNotMatch(api,/app\.post\(P\+'\/pilots\/:id\/r34\//);
  assert.match(source,/automaticMergeAllowed:false/);
  assert.match(host,/independentHostWitnessVerified:false/);
  assert.match(custody,/independentlyVerifiedRealOffsite:false/);
  assert.match(client,/legalBasisVerifiedExternally:false/);
  assert.match(report,/productionAuthorized:false/);
  assert.match(cli,/GUEST_R34_OPERATOR_APPROVAL/);
  assert.match(cli,/APPROVED_READ_ONLY_STAGING/);
  assert.doesNotMatch(cli,/https:\/\/osmanx\.world\b/);
});
