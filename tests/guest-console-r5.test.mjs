import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const get=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const [html,script,join,joinScript,api,model]=await Promise.all([
  get('assets/guest/console.html'),get('assets/guest/console.js'),
  get('assets/guest/join.html'),get('assets/guest/join.js'),
  get('services/industry-api/src/guest.mjs'),get('services/industry-api/shared/pilot-model.js')
]);
test('R5 staff flow is discoverable and makes real authorized requests',()=>{
  for(const id of ['staffPanel','inviteForm','inviteToken','newInvite','copyInvite','staffList',
    'inviteEmail','inviteRole','archivePanel','archivePilot','downloadEvidence','archiveReason']){
    assert.ok(html.includes('id="'+id+'"'),id+' missing');
  }
  assert.match(html,/href="\.\/join\.html"/);
  assert.match(script,/api\('\/staff\/invitations'/);
  assert.match(script,/api\('\/staff'/);
  assert.match(script,/\/revoke/);
  assert.match(script,/model\.me\.role==='owner'/);
});
test('R5 invite token is neither persisted nor embedded in invitation URL',()=>{
  assert.match(join,/connect-src 'self'/);
  assert.match(join,/id="token" type="password"/);
  assert.match(join,/src="\.\/join\.js"/);
  assert.match(joinScript,/credentials:'omit'/);
  assert.match(joinScript,/\/staff\/invitations\/accept/);
  assert.doesNotMatch(joinScript,/\b(localStorage|sessionStorage)\b/);
  assert.doesNotMatch(joinScript,/location\.|URLSearchParams|console\.log/);
  assert.doesNotMatch(script,/\b(localStorage|sessionStorage)\b|\.innerHTML\s*=/);
});
test('R5 exported JSON is checked against SHA-256 in browser',()=>{
  assert.match(script,/crypto\.subtle\.digest\('SHA-256'/);
  assert.match(script,/hash!==data\.sha256/);
  assert.match(api,/guest\.evidence\.export\.v1/);
  assert.match(api,/latest\.evidence_digest!==sha256/);
});
test('R5 archive requires owner and proof, and does not erase earlier review',()=>{
  assert.match(api,/forTenant\(req,\['owner'\]/);
  assert.match(api,/phase='archived'/);
  assert.match(api,/pilot\.submitted_digest!==sha/);
  assert.match(api,/pilot\.archived/);
  assert.doesNotMatch(api,/DELETE FROM industry\.guest_observations/);
});
test('R5 distributed math is an exact approved copy, not a modified business rule',async()=>{
  const browserModel=await get('assets/guest/pilot-model.js');
  assert.equal(model,browserModel);
  const exp=await get('assets/guest/experiment-model.js');
  assert.equal(await get('services/industry-api/shared/experiment-model.js'),exp);
});
