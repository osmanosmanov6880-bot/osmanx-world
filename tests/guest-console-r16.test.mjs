import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,server,registry]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/app.mjs'),
  read('services/industry-api/src/guest-r16-registry.mjs')
]);
test('R16 Russian dashboard reveals only current tenant permit state',()=>{
  for(const name of ['admissionPanel','admissionHeading','admissionStatus','admissionExpiration'])
    assert.ok(html.includes('id="'+name+'"'));
  assert.match(js,/api\('\/guest\/admission\/self'\)/);
  assert.match(js,/await loadAdmission\(\)/);
  assert.match(js,/model\.admission=null/);
  assert.match(js,/!manage\(\)/);
  assert.match(server,/forTenant\(req,rolesManage/);
  assert.match(server,/session\.tenant_id/);
  assert.match(server,/registryRevision:status\.registryRevision/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
});
test('R16 production mutation guard fails closed without permitting browser controls to enable collection',()=>{
  assert.match(server,/await assertR16Tenant\(session\.tenant_id,process\.env\)/);
  assert.match(server,/req\.guestRegistry=await loadR16Registry\(process\.env\)/);
  assert.match(server,/GUEST_WRITES_ENABLED/);
  assert.match(registry,/global_emergency_stop/);
  assert.match(registry,/tenant_emergency_stop/);
  assert.doesNotMatch(js,/GUEST_WRITES_ENABLED\s*=\s*['"]true/);
});
