import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,ui,guest,audit,host,chain,assemble]=await Promise.all([
  read('assets/guest/console.html'),
  read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/src/guest-r21-db-audit.mjs'),
  read('services/industry-api/scripts/r21-host-posture.mjs'),
  read('services/industry-api/scripts/r21-release-chain.mjs'),
  read('services/industry-api/scripts/r21-assemble.mjs')
]);
test('R21 Russian UI is read-only, tenant-specific and always warns of external approvals',()=>{
  for(const id of ['r21Panel','r21Heading','r21Status','r21Checks',
    'r21Summary','r21Refresh'])
    assert.ok(html.includes('id="'+id+'"'),id);
  assert.match(ui,/async function loadR21Posture\(\)/);
  assert.match(ui,/guest\/pilots\/'\+model\.selected\.item\.id\+'\/r21\/posture/);
  assert.match(ui,/independentHostAuditVerified|независимой проверки VPS/);
  assert.match(ui,/NO-GO/);
  assert.doesNotMatch(ui,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(ui,/GUEST_WRITES_ENABLED\s*=\s*['"]true/);
});
test('R21 owner/manager inspection is wrapped in existing authenticated tenant transaction',()=>{
  assert.match(guest,/app\.get\(P\+'\/pilots\/:id\/r21\/posture',req=>forTenant\(req,MANAGE/);
  assert.match(guest,/const pilot=await getPilot\(db,s\.tenant_id,req\.params\.id\)/);
  assert.match(guest,/await auditR21Database\(db/);
  assert.match(guest,/independentHostAuditVerified:false/);
  assert.match(guest,/signedReleaseChainVerified:false/);
  assert.match(audit,/runtimeRoleUnprivileged/);
  assert.match(audit,/has_table_privilege/);
  assert.match(audit,/noOverRetentionDrift/);
  assert.match(host,/productionActivationPermitted:false/);
  assert.match(chain,/automaticProductionApproval:false/);
  assert.match(assemble,/offsiteUploadPerformed:false/);
});
