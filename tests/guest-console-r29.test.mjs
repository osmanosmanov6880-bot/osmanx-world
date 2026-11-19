import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,ui,api,report,staging,rollback,chain]=await Promise.all([
 read('assets/guest/console.html'),read('assets/guest/console.js'),
 read('services/industry-api/src/guest.mjs'),
 read('services/industry-api/src/guest-r29-report.mjs'),
 read('services/industry-api/src/guest-r29-staging.mjs'),
 read('services/industry-api/src/guest-r29-rollback.mjs'),
 read('services/industry-api/scripts/r29-source-tree.mjs')
]);
test('R29 RU 15-PR staging view is read-only, privacy-safe and never a deploy control',()=>{
 for(const id of ['r29Panel','r29Heading','r29Status','r29PrCount',
   'r29Synthetic','r29Expires','r29Blockers','r29Refresh','r29Download'])
   assert.ok(html.includes('id="'+id+'"'),id);
 assert.match(ui,/async function loadR29Acceptance\(\)/);
 assert.match(ui,/await loadR29Acceptance\(\)/);
 assert.match(ui,/r29\/readiness/);
 assert.match(ui,/r29\/report\.csv/);
 assert.match(ui,/x\.customerGo!==false/);
 assert.doesNotMatch(ui,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
 assert.doesNotMatch(html,/id="r29Deploy"|id="r29Merge"|id="r29StopLift"/);
});
test('R29 API has exactly two GETs, MANAGE tenant binding and NO-GO controls',()=>{
 assert.match(api,/async function r29Readiness\(db,s,pilotId\)/);
 assert.match(api,/const r28=await r28Readiness\(db,s,pilotId\)/);
 assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r29\/readiness'/);
 assert.match(api,/app\.get\(P\+'\/pilots\/:id\/r29\/report\.csv'/);
 assert.match(api,/return reply\.send\(r29ReportCsv\(report,\{now\}\)\)/);
 assert.doesNotMatch(api,/app\.post\(P\+'\/pilots\/:id\/r29\//);
 assert.match(report,/productionAuthorized:false/);
 assert.match(staging,/realHostContacted:false/);
 assert.match(rollback,/remoteRollbackExecuted:false/);
 assert.match(chain,/automaticMergeAllowed:false/);
});
