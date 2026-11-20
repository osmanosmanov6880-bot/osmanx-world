import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const read=p=>readFileSync(join(ROOT,p),'utf8');
test('R5 schema enforces same-tenant staff FK and distinct contact events',()=>{
  const sql=read('services/industry-api/migrations/014_cinema_r5_sales_operations.sql');
  assert.match(sql,/REFERENCES industry\.memberships\(tenant_id,account_id\)/);
  assert.match(sql,/ON DELETE SET NULL \(assigned_to\)/);
  assert.match(sql,/first_contact_at/);assert.match(sql,/last_contact_at/);
  assert.match(sql,/contact_logged/);assert.match(sql,/contact_outcome/);
  assert.doesNotMatch(sql,/DISABLE ROW LEVEL SECURITY|DROP TABLE industry\.cinema_leads/);
});
test('R5 private owner routes retain independent role guards and no public contact API',()=>{
  const api=read('services/industry-api/src/cinema-r5.mjs');
  assert.match(api,/registerCinemaR5Routes/);
  assert.match(api,/base\+'\/assignees'/);
  assert.match(api,/base\+'\/performance'/);
  assert.match(api,/base\+'\/privacy\/search'/);
  assert.match(api,/base\+'\/leads\/:id\/export'/);
  assert.match(api,/base\+'\/leads\/:id\/contacts'/);
  assert.match(api,/\['owner'\]/);
  assert.match(api,/\['owner','manager'\]/);
  assert.match(api,/FOR UPDATE/);
  assert.match(api,/expectedVersion/);
  assert.match(api,/completeFollowup/);
  assert.match(api,/contact_count/);
  assert.match(api,/Cache-Control/);
  const main=read('services/industry-api/src/cinema.mjs');
  assert.match(main,/registerCinemaR5Routes/);
  assert.match(main,/assignedTo/);
  assert.match(main,/assigned_changed/);
});
test('R5 dashboard renders without HTML interpolation of private lead values',()=>{
  const ui=read('assets/stories/manager.html'),script=read('assets/stories/manager.js');
  for(const id of ['r5-report-days','r5-report','r5-subject','r5-subject-form','r5-identity-verified','r5-subject-results'])
    assert(ui.includes('id="'+id+'"'),id);
  for(const token of ['renderPerformance','r5Online','r5-contact','r5-staff','nextActionAt','assignedTo',
    'completeFollowup','r5-identity-verified','verified','/cinema/privacy/search','/cinema/leads/']){
    assert(script.includes(token),token);
  }
  assert.match(script,/Promise\.allSettled/);
  assert.doesNotMatch(script,/localStorage|sessionStorage|innerHTML\s*=\s*item\.|eval\(/);
  assert.match(read('assets/stories/manager.css'),/@media\(max-width:650px\)/);
});
test('R5 operator gate remains read-only and human attestations stay mandatory',()=>{
  const script=read('services/industry-api/scripts/cinema-r5-readiness.mjs');
  assert.match(script,/cinemaGoNoGo/);
  assert.match(script,/CINEMA_R5_OPERATOR_REVIEWED/);
  assert.match(script,/r5Schema/);
  assert.doesNotMatch(script,/DELETE FROM|UPDATE industry|CREATE TABLE|CINEMA_PUBLIC_WRITE_ENABLED\s*=\s*'true'/);
  assert(existsSync(join(ROOT,'services/industry-api/migrations/014_cinema_r5_sales_operations.sql')));
});
