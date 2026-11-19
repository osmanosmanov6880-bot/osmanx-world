import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,ui,guest,review,dr,host,release]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/scripts/r22-preflight-review.mjs'),
  read('services/industry-api/scripts/r22-dr-quorum.mjs'),
  read('services/industry-api/scripts/r22-host-witness.mjs'),
  read('services/industry-api/scripts/r22-release-chain.mjs')
]);
test('R22 company-only Russian first-client readiness has a complete NO-GO UX and no writable controls',()=>{
  for(const id of ['r22Panel','r22Heading','r22Status',
    'r22Checklist','r22Budget','r22Refresh'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(ui,/async function loadR22LaunchReview\(\)/);
  assert.match(ui,/\/guest\/pilots\/'\+model\.selected\.item\.id\+'\/r22\/launch-review/);
  assert.match(ui,/twoDistinctDrCopiesVerified/);
  assert.match(ui,/allPrsMergedAndMainProtected/);
  assert.match(ui,/NO-GO/);
  assert.doesNotMatch(ui,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r22EnableProduction"/);
});
test('R22 read-only route derives tenant from signed session and never exports raw source documents',()=>{
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r22\/launch-review',req=>forTenant\(req,MANAGE/);
  assert.match(guest,/getPilot\(db,s\.tenant_id,req\.params\.id\)/);
  assert.match(guest,/loadR19Scope\(process\.env,anchor\)/);
  assert.match(guest,/await auditR21Database\(db/);
  assert.match(guest,/await inspectR20Pilot\(db/);
  assert.match(guest,/twoDistinctDrCopiesVerified:false/);
  assert.match(guest,/productionAuthorized:false,productionChanged:false/);
  assert.match(dr,/BEGIN READ ONLY/);
  assert.match(review,/productionAuthorized:false,legalGo:false,customerGo:false/);
  assert.match(host,/actualHostVerifiedByThisSoftware:false/);
  assert.match(release,/main_policy_|mainSha/);
});
