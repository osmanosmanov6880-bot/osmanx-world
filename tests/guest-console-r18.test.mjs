import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const [html,js,api,migration,anchor,proof]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/app.mjs'),
  read('services/industry-api/migrations/013_guest_external_anchor_fence.sql'),
  read('services/industry-api/src/guest-r18-anchor.mjs'),
  read('services/industry-api/src/guest-r18-proof.mjs')
]);
test('R18 company dashboard reports only signed receipt status, never private material',()=>{
  assert.match(html,/id="admissionPanel"/);
  assert.match(js,/api\('\/guest\/admission\/self'\)/);
  assert.match(js,/externalAnchorVerified===true/);
  assert.match(js,/externalAnchorFenceReady===true/);
  assert.match(js,/r18_anchor_or_fence_unavailable/);
  assert.match(js,/внешняя проверка не пройдена/);
  assert.match(api,/forTenant\(req,rolesManage/);
  assert.match(api,/session\.tenant_id/);
  assert.match(api,/externalAnchorVerified,externalAnchorFenceReady,externalAnchorSequence/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.doesNotMatch(js,/GUEST_R18_.*=\s*['"]true/);
});
test('R18 production mutation wraps R17+R18 fences inside one tenant transaction',()=>{
  assert.match(api,/await assertR17Fence\(db,witness\)/);
  assert.match(api,/await assertR18Fence\(db,externalAnchor\)/);
  assert.match(api,/await assertR18Fence\(db,latestAnchor\)/);
  assert.match(api,/await loadR18Anchor\(process\.env,witness\)/);
  assert.match(api,/await loadR18Anchor\(process\.env,latest\)/);
  assert.match(api,/r18Configured\(process\.env\)&&!r17Configured\(process\.env\)/);
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/BEFORE UPDATE OR DELETE ON industry\.guest_external_anchor_fence/);
  assert.match(migration,/BEFORE UPDATE OR DELETE ON industry\.guest_external_anchor_receipts/);
  assert.match(anchor,/offsiteStorageVerified:false/);
  assert.match(proof,/offsiteStorageVerified:false/);
});
