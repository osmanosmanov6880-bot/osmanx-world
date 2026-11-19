import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,api,source,canary,archived,docs,report,cli]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r35-source.mjs'),
  read('services/industry-api/src/guest-r35-staging.mjs'),
  read('services/industry-api/src/guest-r35-archive-bytes.mjs'),
  read('services/industry-api/src/guest-r35-document-bytes.mjs'),
  read('services/industry-api/src/guest-r35-report.mjs'),
  read('services/industry-api/scripts/r35-operator-audit.mjs')
]);
test('R35 Russian cockpit is tenant role scoped, read-only and resets after logout',()=>{
  for(const id of ['r35Panel','r35Heading','r35Status','r35Source',
    'r35Stage','r35Files','r35Blockers','r35Expiry',
    'r35Refresh','r35Download'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(js,/async function loadR35Acceptance\(\)/);
  assert.match(js,/await loadR35Acceptance\(\)/);
  assert.match(js,/r35\/readiness/);
  assert.match(js,/r35\/report\.csv/);
  assert.match(js,/\$\('r35Panel'\)\.hidden=true/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r35Deploy"|id="r35Merge"|id="r35StopLift"/);
});
test('R35 API has only manager GETs: external keys and private documents never enter browser',()=>{
  assert.match(api,/async function r35Readiness\(db,s,pilotId\)/);
  assert.match(api,/const r34=await r34Readiness\(db,s,pilotId\)/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r35\/readiness'/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r35\/report\.csv'/);
  assert.doesNotMatch(api,/app\.post\(P\+'\/pilots\/:id\/r35\//);
  assert.match(source,/automaticMergeAllowed:false/);
  assert.match(canary,/independentWitnessVerified:false/);
  assert.match(archived,/actualDecryptionAndRestorationPerformed:false/);
  assert.match(docs,/legalValidityIndependentlyEstablished:false/);
  assert.match(report,/productionAuthorized:false/);
  assert.match(cli,/R35_TRUSTED_PUBLIC_KEYS_FILE/);
  assert.match(cli,/LIMIT=256\*1024/);
});
