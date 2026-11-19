import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,api,review,staging,restore,report,cli]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r36-source.mjs'),
  read('services/industry-api/src/guest-r36-staging-content.mjs'),
  read('services/industry-api/src/guest-r36-disposable-restore.mjs'),
  read('services/industry-api/src/guest-r36-report.mjs'),
  read('services/industry-api/scripts/r36-review-github.mjs')
]);
test('R36 Russian 22-PR UI works without write controls and resets on logout',()=>{
  for(const id of ['r36Panel','r36Heading','r36Status','r36Source',
    'r36Staging','r36Recovery','r36Blockers','r36Refresh',
    'r36Download','r36Expiry'])assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(js,/async function loadR36Acceptance\(\)/);
  assert.match(js,/await loadR36Acceptance\(\)/);
  assert.match(js,/r36\/readiness/);
  assert.match(js,/r36\/report\.csv/);
  assert.match(js,/\$\('r36Panel'\)\.hidden=true/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r36Merge"|id="r36Deploy"|id="r36StopLift"/);
});
test('R36 has only tenant MANAGE GETs; no web operator tool, no artificial GO',()=>{
  assert.match(api,/async function r36Readiness\(db,s,pilotId\)/);
  assert.match(api,/const r35=await r35Readiness\(db,s,pilotId\)/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r36\/readiness'/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r36\/report\.csv'/);
  assert.doesNotMatch(api,/app\.post\(P\+'\/pilots\/:id\/r36\//);
  assert.match(review,/automaticMergeAllowed:false/);
  assert.match(staging,/realDeployedCommitVerified:false/);
  assert.match(restore,/realProductionRollbackTested:false/);
  assert.match(report,/productionAuthorized:false/);
  assert.match(cli,/githubWriteCount:0/);
});
