import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,ui,guest,quality,stats,econ,playbook,brief]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r24-quality.mjs'),
  read('services/industry-api/src/guest-r24-statistics.mjs'),
  read('services/industry-api/src/guest-r24-economics.mjs'),
  read('services/industry-api/src/guest-r24-playbook.mjs'),
  read('services/industry-api/src/guest-r24-brief.mjs')
]);
test('R24 Russian owner experience separates observed returns from profit and causal attribution',()=>{
  for(const id of ['r24Panel','r24Heading','r24Status','r24ControlRate',
    'r24OfferRate','r24Difference','r24Interval','r24Economics',
    'r24Quality','r24Decisions','r24Refresh','r24Download'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(ui,/async function loadR24Intelligence\(\)/);
  assert.match(ui,/guest\/pilots\/'\+model\.selected\.item\.id\+'\/r24\/intelligence/);
  assert.match(ui,/guest\/pilots\/'\+model\.selected\.item\.id\+'\/r24\/brief\.csv/);
  assert.match(ui,/report\.causalEffectProven!==false/);
  assert.match(ui,/это не реальная прибыль/i);
  assert.doesNotMatch(ui,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(html,/id="r24AuthorizeProduction"/);
});
test('R24 server routes are tenant+manager bound, read-only, reuse R4 evidence fingerprint',()=>{
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r24\/intelligence',req=>forTenant\(req,MANAGE/);
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r24\/brief\.csv'/);
  assert.match(guest,/const pilot=await getPilot\(db,s\.tenant_id,pilotId\)/);
  assert.match(guest,/const rows=await activeObservations\(db,s\.tenant_id,pilot\.id\)/);
  assert.match(guest,/evidenceDigest:proof\(pilot,rows\)/);
  assert.match(guest,/return reply\.send\(r24BriefCsv\(brief\)\)/);
  assert.match(quality,/unverifiedAssumptions/);
  assert.match(stats,/Newcombe-Wilson/);
  assert.match(econ,/realizedRevenueKnown:false/);
  assert.match(playbook,/causalClaimMade:false/);
  assert.match(brief,/signed:false,guestIdentifiersIncluded:false/);
});
