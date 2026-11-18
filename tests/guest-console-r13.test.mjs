import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const [html,js,api,migration,engine,readiness,release]=await Promise.all([
 read('assets/guest/console.html'),read('assets/guest/console.js'),
 read('services/industry-api/src/guest.mjs'),
 read('services/industry-api/migrations/011_guest_pilot_safety.sql'),
 read('services/industry-api/src/guest-safety.mjs'),
 read('services/industry-api/src/readiness.mjs'),
 read('services/industry-api/ops/build-release.sh')
]);
test('R13 premium Russian pilot safety UI has real controls and server wiring',()=>{
 for(const id of ['safetyPanel','safetyHeading','safetyStatus','safetyQualitySummary',
  'safetyQualityList','safetyReason','safetyRefresh','safetyHold','safetyResume','safetyExport'])
  assert.ok(html.includes('id="'+id+'"'),'Missing element '+id);
 for(const id of ['safetyStatus','safetyQualitySummary','safetyQualityList',
  'safetyReason','safetyRefresh','safetyHold','safetyResume','safetyExport'])
  assert.ok(js.includes("$('"+id+"')"),'Missing wiring '+id);
 assert.match(html,/Guest Intelligence \/ R13 \/ Защищённый кабинет/);
 assert.match(js,/await loadSafety\(\)/);
 assert.match(js,/guestCollectionPaused/);
 assert.match(js,/model\.safety\.hold\?\.held_by===model\.me\?\.account\?\.id/);
 assert.match(js,/bulkPreview'\)\.disabled=held/);
 assert.match(js,/submitReview'\)\.disabled=held/);
});
test('R13 API enforces pause on all aggregate mutation paths even without UI',()=>{
 for(const path of [
  '/pilots/:id/observations','/pilots/:id/observations/import/preview',
  '/pilots/:id/observations/import','/pilots/:id/observations/:observationId/void',
  '/pilots/:id/submit'
 ])assert.ok(api.includes(path),'missing server mutation '+path);
 assert.ok((api.match(/await assertUnheld\(db,s\.tenant_id,pilot\.id\)/g)||[]).length>=5);
 assert.match(api,/s\.account_id===hold\.held_by/);
 assert.match(api,/safety\.held/);
 assert.match(api,/safety\.resumed/);
 assert.match(api,/FOR UPDATE/);
});
test('R13 no raw guest identities, executable HTML or local credential persistence',()=>{
 assert.match(js,/crypto\.subtle\.digest\('SHA-256',bytes\)/);
 assert.match(js,/digest!==packet\.sha256/);
 assert.match(js,/osmanx-guest-r13-safety\.json/);
 assert.match(js,/credentials:'same-origin'/);
 assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
 assert.match(engine,/блокирует пилот сами по себе|blocksAutomatically:false/);
 assert.match(engine,/не является цифровой подписью/);
 assert.doesNotMatch(engine,/person_name|guest_email|guest_phone/);
});
test('R13 PostgreSQL and readiness require immutable history and no bypass role',()=>{
 for(const table of ['guest_pilot_holds','guest_pilot_hold_events']){
  assert.ok(migration.includes('ALTER TABLE industry.'+table+' FORCE ROW LEVEL SECURITY'));
  assert.ok(readiness.includes("'"+table+"'"));
 }
 assert.match(migration,/BEFORE UPDATE OR DELETE ON industry\.guest_pilot_hold_events/);
 assert.match(migration,/GRANT SELECT,INSERT ON industry\.guest_pilot_hold_events TO industry_app/);
 assert.doesNotMatch(migration,/GRANT\s+.*(?:UPDATE|DELETE) ON industry\.guest_pilot_hold_events/);
 assert.match(readiness,/'011_guest_pilot_safety\.sql'/);
 assert.match(release,/"migration":"011_guest_pilot_safety\.sql"/);
});
