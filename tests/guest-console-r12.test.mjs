import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,api,db,engine,readiness,release]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/migrations/010_guest_launch_gate.sql'),
  read('services/industry-api/src/guest-launch.mjs'),
  read('services/industry-api/src/readiness.mjs'),
  read('services/industry-api/ops/build-release.sh')
]);
test('R12 accessible guided owner workflow is mounted and genuinely wired',()=>{
  for(const id of ['launchGatePanel','launchGateHeading','launchGateState',
    'launchGateChecklist','launchGateApprovals','launchGateRefresh',
    'launchGateEnroll','launchGateAttest','launchGateExport']){
    assert.ok(html.includes('id="'+id+'"'),id);
    assert.ok(js.includes("$('"+id+"')")||id==='launchGatePanel'||id==='launchGateHeading',id);
  }
  assert.match(html,/Guest Intelligence \/ R12 \/ Защищённый кабинет/);
  assert.match(js,/updateLaunchButtons\(\)/);
  assert.match(js,/gate\?\.enrolled&&!gate\.canStartIsolatedPilot/);
  assert.match(js,/await Promise\.all\(\[loadDiagnostics\(\),loadActions\(\),loadLaunchGate\(\)\]\)/);
});
test('R12 submits explicit opt-in and independent role acknowledgement with CSRF and idempotency',()=>{
  assert.match(js,/launch\/enroll/);
  assert.match(js,/launch\/attest/);
  assert.match(js,/expectedVersion:pilot\.version,confirm:true/);
  assert.match(js,/expectedVersion:pilot\.version,acknowledge:true/);
  assert.match(js,/'Idempotency-Key':idempotency\(\)/);
  assert.match(js,/window\.confirm\('Включить необратимый/);
  assert.match(js,/window\.confirm\('Подтвердить текущий протокол/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.match(js,/credentials:'same-origin'/);
});
test('R12 WebCrypto verifies integrity of human-gate export; never calls live payment service',()=>{
  assert.match(js,/crypto\.subtle\.digest\('SHA-256',bytes\)/);
  assert.match(js,/digest!==packet\.sha256/);
  assert.match(js,/osmanx-guest-r12-launch-proof\.json/);
  assert.match(html,/Production остаётся заблокированным/);
  assert.doesNotMatch(js,/Stripe|stripe\.com|checkout\.com/i);
});
test('R12 existing start API is guarded, even when clients bypass the R12 UI',()=>{
  assert.match(api,/app\.post\(P\+'\/pilots\/:id\/start'/);
  assert.match(api,/if\(pilot\.launch_gate_enrolled_at\)/);
  assert.match(api,/if\(!gate\.canStartIsolatedPilot\)/);
  assert.match(api,/app\.post\(P\+'\/pilots\/:id\/launch\/enroll',req=>forTenant\(req,\['owner'\]/);
  assert.match(api,/app\.post\(P\+'\/pilots\/:id\/launch\/attest',\(req,reply\)=>forTenant\(req,MANAGE/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/launch\/evidence\.json',\(req,reply\)=>forTenant\(req,MANAGE/);
  assert.match(api,/FOR UPDATE/);
  assert.match(engine,/pilotVersion:pilot\.version/);
  assert.match(engine,/customerProductionAuthorized:false/);
});
test('R12 PostgreSQL is immutable and RLS-protected without app grants for UPDATE/DELETE',()=>{
  assert.match(db,/ALTER TABLE industry\.guest_launch_attestations FORCE ROW LEVEL SECURITY/);
  assert.match(db,/GRANT SELECT,INSERT ON industry\.guest_launch_attestations TO industry_app/);
  assert.match(db,/BEFORE UPDATE OR DELETE ON industry\.guest_launch_attestations/);
  assert.match(db,/guest_launch_enrollment_immutable/);
  assert.doesNotMatch(db,/GRANT\s+[^\n]*(?:UPDATE|DELETE|TRUNCATE) ON industry\.guest_launch_attestations/);
  assert.match(readiness,/'010_guest_launch_gate\.sql'/);
  assert.match(readiness,/'guest_launch_attestations'/);
  assert.match(release,/"migration":"010_guest_launch_gate\.sql"/);
});
