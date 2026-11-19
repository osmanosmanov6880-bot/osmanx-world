import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,guest,engine,chain,dr,ticket]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r20-inspection.mjs'),
  read('services/industry-api/scripts/r20-release-chain.mjs'),
  read('services/industry-api/scripts/r20-restore-crosscheck.mjs'),
  read('services/industry-api/scripts/r20-change-ticket.mjs')
]);
test('R20 Russian premium panel is read-only, company-scoped and gives no production enable button',()=>{
  for(const id of ['r20Panel','r20Heading','r20Status','r20Checklist',
    'r20Budget','r20Refresh'])assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(js,/async function loadR20Inspection\(\)/);
  assert.match(js,/api\('\/guest\/pilots\/'\+model\.selected\.item\.id\+'\/r20\/inspection'\)/);
  assert.match(js,/technicalBlockers/);
  assert.match(js,/externalDrAttested/);
  assert.match(js,/legalEvidenceReviewed/);
  assert.match(js,/R20.*NO-GO|NO-GO/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r20EnableProduction"/);
});
test('R20 inspection route requires owner/manager membership and returns only aggregate proofs',()=>{
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r20\/inspection',req=>forTenant\(req,MANAGE/);
  assert.match(guest,/const pilot=await getPilot\(db,s\.tenant_id,req\.params\.id\)/);
  assert.match(guest,/await inspectR20Pilot\(db/);
  assert.match(engine,/productionAuthorized:false/);
  assert.match(engine,/customerGo:false/);
  assert.match(engine,/changedProduction:false/);
  assert.match(engine,/dailyAuditMatchesQuota/);
  assert.match(chain,/automatedCustomerGo:false/);
  assert.match(dr,/BEGIN READ ONLY/);
  assert.match(ticket,/documentaryReviewOnly:true/);
  assert.doesNotMatch(guest,/GUEST_WRITES_ENABLED\s*=\s*['"]true/);
});
