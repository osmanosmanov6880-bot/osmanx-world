import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,guest,route,server,compose,restore,canary,
  docker,api,build,report]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r38-build-route.mjs'),
  read('services/industry-api/src/server.mjs'),
  read('services/industry-api/src/guest-r38-compose.mjs'),
  read('services/industry-api/ops/restore-dr.sh'),
  read('services/industry-api/ops/r14-canary.sh'),
  read('services/industry-api/Dockerfile'),
  read('services/industry-api/ops/compose.r14.yml'),
  read('services/industry-api/src/guest-r38-build.mjs'),
  read('services/industry-api/src/guest-r38-report.mjs')
]);
test('R38 Russian cockpit is manager-only, read-only, and resets on logout',()=>{
  for(const id of ['r38Panel','r38Heading','r38Status','r38Source',
    'r38Build','r38Recovery','r38Blockers',
    'r38Expiry','r38Refresh','r38Download'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(js,/async function loadR38Acceptance\(\)/);
  assert.match(js,/await loadR38Acceptance\(\)/);
  assert.match(js,/r38\/readiness/);
  assert.match(js,/r38\/report\.csv/);
  assert.match(js,/\$\('r38Panel'\)\.hidden=true/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r38Merge"|id="r38Deploy"|id="r38StopLift"/);
});
test('R38 API does not expose operator files, Docker, GitHub actions or writes',()=>{
  assert.match(guest,/async function r38Readiness\(db,s,pilotId\)/);
  assert.match(guest,/const r37=await r37Readiness\(db,s,pilotId\)/);
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r38\/readiness'/);
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r38\/report\.csv'/);
  assert.doesNotMatch(guest,/app\.post\(P\+'\/pilots\/:id\/r38\//);
  assert.match(report,/productionAuthorized:false/);
  assert.match(build,/signedBuildProvenanceVerified:false/);
});
test('R38 running build route wired into the real server with pinned source SHA',()=>{
  assert.match(server,/registerR38BuildHealth\(app\)/);
  assert.match(route,/guestWritesEnabled:false/);
  assert.match(docker,/ENV OSMANX_SOURCE_SHA=/);
  assert.match(api,/OSMANX_SOURCE_SHA: \$\{OSMANX_SOURCE_SHA:\?/);
  assert.match(canary,/r38-source-commit\.mjs/);
  assert.match(canary,/r38-compose-policy\.mjs/);
  assert.match(canary,/r38-local-build-probe\.mjs/);
  assert.match(canary,/r38-docker-endpoint\.mjs/);
  assert.match(restore,/r38-dr-preflight\.mjs/);
  assert.match(restore,/existing user relations/);
  assert.match(compose,/remoteDockerAllowed:false/);
});
