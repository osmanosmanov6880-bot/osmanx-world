import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,api,canary,image,dr,report,gate,run,compose,docker]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r37-canary-guard.mjs'),
  read('services/industry-api/src/guest-r37-image-provenance.mjs'),
  read('services/industry-api/src/guest-r37-dr-verified.mjs'),
  read('services/industry-api/src/guest-r37-report.mjs'),
  read('services/industry-api/src/guest-r37-postmerge.mjs'),
  read('services/industry-api/ops/r14-canary.sh'),
  read('services/industry-api/ops/compose.r14.yml'),
  read('services/industry-api/Dockerfile')
]);
test('R37 Russian owner/manager UI read-only NO-GO and reset on logout',()=>{
  for(const id of ['r37Panel','r37Heading','r37Status','r37Pr',
    'r37Image','r37Dr','r37Blockers','r37Expiry',
    'r37Refresh','r37Download'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(js,/async function loadR37Acceptance\(\)/);
  assert.match(js,/await loadR37Acceptance\(\)/);
  assert.match(js,/r37\/readiness/);
  assert.match(js,/r37\/report\.csv/);
  assert.match(js,/\$\('r37Panel'\)\.hidden=true/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r37Deploy"|id="r37Merge"|id="r37Write"/);
});
test('R37 API has two tenant-only GETs, no public operator actions',()=>{
  assert.match(api,/async function r37Readiness\(db,s,pilotId\)/);
  assert.match(api,/const r36=await r36Readiness\(db,s,pilotId\)/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r37\/readiness'/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r37\/report\.csv'/);
  assert.doesNotMatch(api,/app\.post\(P\+'\/pilots\/:id\/r37\//);
  assert.match(report,/productionAuthorized:false/);
  assert.match(canary,/dockerCommandsExecuted:false/);
  assert.match(image,/remoteVpsDeploymentVerified:false/);
  assert.match(dr,/externalRollbackDrillVerified:false/);
  assert.match(gate,/automaticMergeAllowed:false/);
});
test('R37 real source canary preflight and Docker build metadata are wired',()=>{
  assert.match(run,/r37-canary-preflight\.mjs/);
  assert.match(run,/Refusing automatic overwrite or replay/);
  assert.match(compose,/OSMANX_SOURCE_SHA/);
  assert.match(compose,/127\.0\.0\.1:3150:3047/);
  assert.match(docker,/org\.opencontainers\.image\.revision/);
  assert.match(docker,/io\.osmanx\.guest\.writes-default/);
  assert.doesNotMatch(docker,/ENV GUEST_WRITES_ENABLED=true/);
});
