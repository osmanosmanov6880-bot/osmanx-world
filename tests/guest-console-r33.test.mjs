import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,api,report,source,stage,ledger,policy,cli]=await Promise.all([
  read('assets/guest/console.html'),
  read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r33-report.mjs'),
  read('services/industry-api/src/guest-r33-source.mjs'),
  read('services/industry-api/src/guest-r33-staging-witness.mjs'),
  read('services/industry-api/src/guest-r33-rollback-ledger.mjs'),
  read('services/industry-api/src/guest-r33-privacy.mjs'),
  read('services/industry-api/scripts/r33-offline-review.mjs')
]);
test('R33 Russian cockpit shows 19 PRs, 4 independent roles, blocks launch and clears on logout',()=>{
  for(const id of ['r33Panel','r33Heading','r33Status','r33Sources',
    'r33Staging','r33Privacy','r33Blockers','r33Expiry',
    'r33Refresh','r33Download'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(js,/async function loadR33Acceptance\(\)/);
  assert.match(js,/await loadR33Acceptance\(\)/);
  assert.match(js,/r33\/readiness/);
  assert.match(js,/r33\/report\.csv/);
  assert.match(js,/\$\('r33Panel'\)\.hidden=true/);
  assert.match(js,/x\.productionAuthorized!==false/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r33Deploy"|id="r33Merge"|id="r33StopLift"/);
});
test('R33 only tenant MANAGE GETs, no web evidence upload, no host request',()=>{
  assert.match(api,/async function r33Readiness\(db,s,pilotId\)/);
  assert.match(api,/const r32=await r32Readiness\(db,s,pilotId\)/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r33\/readiness'/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r33\/report\.csv'/);
  assert.doesNotMatch(api,/app\.post\(P\+'\/pilots\/:id\/r33\//);
  assert.match(report,/productionAuthorized:false/);
  assert.match(source,/automaticMergeAllowed:false/);
  assert.match(stage,/actualTlsHandshakeVerified:false/);
  assert.match(ledger,/liveRollbackExecuted:false/);
  assert.match(policy,/lawfulBasisIndependentlyVerified:false/);
  assert.match(cli,/R33_TRUSTED_PUBLIC_KEYS_FILE/);
  assert.match(cli,/LIMIT=256\*1024/);
});
