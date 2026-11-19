import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,ui,api,witness,migration]=await Promise.all([
  read('assets/guest/console.html'),
  read('assets/guest/console.js'),
  read('services/industry-api/src/app.mjs'),
  read('services/industry-api/src/guest-r17-witness.mjs'),
  read('services/industry-api/migrations/012_guest_registry_checkpoint_fence.sql')
]);
test('R17 status is displayed in Russian only for an authenticated company owner/manager',()=>{
  assert.match(html,/id="admissionPanel"/);
  assert.match(ui,/api\('\/guest\/admission\/self'\)/);
  assert.match(ui,/witnessVerified===true&&value\.witnessFenceReady===true/);
  assert.match(ui,/не удалось проверить независимые подтверждения R17/);
  assert.match(ui,/!manage\(\)/);
  assert.match(api,/forTenant\(req,rolesManage/);
  assert.match(api,/session\.tenant_id/);
  assert.doesNotMatch(ui,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
});
test('R17 witness and SQL fence stay server-only without client-side write toggles',()=>{
  assert.match(api,/await assertR17Fence\(db,witness\)/);
  assert.match(api,/await assertR17Fence\(db,latest\)/);
  assert.match(api,/await loadR17Witness\(process\.env\)/);
  assert.match(witness,/GUEST_R17_MIN_SEQUENCE/);
  assert.match(witness,/GUEST_R17_MIN_REVISION/);
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/BEFORE UPDATE OR DELETE/);
  assert.doesNotMatch(ui,/GUEST_WRITES_ENABLED\s*=\s*['"]true/);
});
