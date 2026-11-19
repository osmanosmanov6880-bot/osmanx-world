import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,ui,guest,migration,review,bias,decision,brief]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/migrations/016_guest_r26_source_reviews.sql'),
  read('services/industry-api/src/guest-r26-review.mjs'),
  read('services/industry-api/src/guest-r26-bias.mjs'),
  read('services/industry-api/src/guest-r26-decision.mjs'),
  read('services/industry-api/src/guest-r26-brief.mjs')
]);
test('R26 premium RU form, two-person independent-role review and guarded CSV',()=>{
  for(const id of [
    'r26Panel','r26Heading','r26Status','r26Rows','r26StaffShare',
    'r26ShiftDrift','r26BiasWarnings','r26ReviewList',
    'r26ReviewForm','r26ReviewFieldset','r26Method','r26Verdict',
    'r26EvidenceSha','r26ReviewSubmit','r26NextAction',
    'r26EvidenceRequired','r26Refresh','r26Download'
  ])assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(html,/id="r26ReviewFieldset" class="grid" disabled/);
  assert.match(ui,/async function loadR26Reliability\(\)/);
  assert.match(ui,/await loadR26Reliability\(\)/);
  assert.match(ui,/data\.reviewEnabled!==true/);
  assert.match(ui,/guest\/pilots\/'\+model\.selected\.item\.id\+'\/r26\/reliability/);
  assert.match(ui,/guest\/pilots\/'\+model\.selected\.item\.id\+'\/r26\/report\.csv/);
  assert.match(ui,/r26\/source-review/);
  assert.match(ui,/Idempotency-Key':idempotency\(\)/);
  assert.doesNotMatch(ui,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r26EnableProduction"/);
});
test('R26 manager-only API preserves pilot version, immutable source and STOP',()=>{
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r26\/reliability',req=>forTenant\(req,MANAGE/);
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r26\/report\.csv'/);
  assert.match(guest,/app\.post\(P\+'\/pilots\/:id\/r26\/source-review',\(req,reply\)=>/);
  assert.match(guest,/forTenant\(req,MANAGE,async\(db,s,role\)=>/);
  assert.match(guest,/GUEST_R26_SOURCE_REVIEW_ENABLED/);
  assert.match(guest,/await assertUnheld\(db,s\.tenant_id,pilot\.id\)/);
  assert.match(guest,/verifyVersion\(pilot,b\.expectedVersion\)/);
  assert.match(guest,/scope\.pilotId===pilot\.id/);
  assert.match(guest,/r25Intelligence\(db,s,pilot\.id\)/);
  assert.match(guest,/r26Intelligence\(db,s,req\.params\.id\)/);
  assert.match(review,/reviewedPrimaryEvidenceExternally:false/);
  assert.match(bias,/causalExplanationProven:false/);
  assert.match(decision,/experimentStarted:false/);
  assert.match(brief,/reportSigned:false/);
});
test('R26 migration is FORCE RLS, append-only, two-person keyed and no PII fields',()=>{
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/UNIQUE\(tenant_id,pilot_id,pilot_version,tally_source_sha,actor_role\)/);
  assert.match(migration,/GRANT SELECT,INSERT ON industry\.guest_r26_source_reviews/);
  assert.match(migration,/guest_r26_source_reviews_immutable/);
  assert.doesNotMatch(migration,/GRANT SELECT,INSERT,UPDATE/);
  assert.doesNotMatch(migration,/varchar\([^)]+\)\s+free_text|customer_email/);
});
