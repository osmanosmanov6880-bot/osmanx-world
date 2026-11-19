import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,api,report,window,drift,restore,cli]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r32-report.mjs'),
  read('services/industry-api/src/guest-r32-change-window.mjs'),
  read('services/industry-api/src/guest-r32-staging-drift.mjs'),
  read('services/industry-api/src/guest-r32-recovery-objectives.mjs'),
  read('services/industry-api/scripts/r32-offline-preflight.mjs')
]);
test('R32 full RU cockpit is read-only and resets after logout',()=>{
  for(const id of ['r32Panel','r32Heading','r32Status','r32Sources',
    'r32Snapshots','r32Expiry','r32Blockers','r32Refresh','r32Download'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(js,/async function loadR32Acceptance\(\)/);
  assert.match(js,/await loadR32Acceptance\(\)/);
  assert.match(js,/r32\/readiness/);
  assert.match(js,/r32\/report\.csv/);
  assert.match(js,/\$\('r32Panel'\)\.hidden=true/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r32Deploy"|id="r32Merge"|id="r32StopLift"/);
});
test('R32 API accepts no external evidence, only two tenant MANAGE GETs',()=>{
  assert.match(api,/async function r32Readiness\(db,s,pilotId\)/);
  assert.match(api,/const r31=await r31Readiness\(db,s,pilotId\)/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r32\/readiness'/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r32\/report\.csv'/);
  assert.doesNotMatch(api,/app\.post\(P\+'\/pilots\/:id\/r32\//);
  assert.match(report,/productionAuthorized:false/);
  assert.match(window,/environment!=='staging'/);
  assert.match(drift,/realStagingIndependentlyVerified:false/);
  assert.match(restore,/actualOffsiteRestoreVerified:false/);
  assert.match(cli,/R32_TRUSTED_PUBLIC_KEYS_FILE/);
  assert.match(cli,/MAX_BYTES=512\*1024/);
});
