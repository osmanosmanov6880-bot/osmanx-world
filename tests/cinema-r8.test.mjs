import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=p=>readFileSync(join(root,p),'utf8');
test('R8 migration protects approval and retention evidence with forced tenant RLS',()=>{
  const sql=read('services/industry-api/migrations/017_cinema_r8_operational_evidence.sql');
  for(const part of ['bulk_export_authorized','cinema_retention_runs','ENABLE ROW LEVEL SECURITY',
    'FORCE ROW LEVEL SECURITY','cinema_retention_runs_tenant','GRANT SELECT,INSERT,DELETE'])
    assert(sql.includes(part),part);
  assert.doesNotMatch(sql,/DISABLE ROW LEVEL SECURITY|DROP TABLE industry\.cinema_leads/);
  const keep=read('services/industry-api/src/cinema-retention.mjs');
  assert(keep.includes('INSERT INTO industry.cinema_retention_runs'));
  assert(keep.includes('interval \\'180 days\\''));
});
test('R8 owner-only CSV authorization with strict tenant and UUID validation',()=>{
  const src=read('services/industry-api/src/cinema-r8.mjs');
  for(const bit of ['/public/runtime','/ops/preflight','/exports/approve',
    "['owner']",'bulk_export_authorized','id=ANY($2::uuid[])',
    'approvedCount','retentionAssessment','operatorTenantConfigured'])
    assert(src.includes(bit),bit);
  assert(!src.includes('contact_email'));
  assert(read('services/industry-api/src/cinema.mjs').includes('registerCinemaR8Routes'));
});
test('R8 browser disallows offline/manager CSV and renders honest operator state',()=>{
  const h=read('assets/stories/manager.html'),js=read('assets/stories/manager.js');
  for(const id of ['r8-runtime-status','r8-ops','r8-refresh','r8-ops-result','csv'])
    assert(h.includes('id="'+id+'"'),id);
  assert.match(h,/<button id="csv"[^>]*disabled/);
  for(const fragment of ['refreshR8','refreshR8Ops','r8Online','updateCsvPermission',
    '/cinema/exports/approve','confirm:\\'EXPORT_LOADED\\'','approvedCount',
    'window.confirm','rows.length>500','r8-ops'])
    assert(js.includes(fragment),fragment);
  assert.doesNotMatch(js,/localStorage|sessionStorage|innerHTML\s*=\s*item\./i);
  assert(read('assets/stories/manager.css').includes('@media(max-width:650px)'));
});
test('R8 read-only gate and canary reject live collection and remote services',()=>{
  const gate=read('services/industry-api/scripts/cinema-r8-readiness.mjs');
  const canary=read('services/industry-api/scripts/cinema-r8-canary.mjs');
  for(const term of ['inspectCinemaR7','r8AuditAction','r8ReceiptRls',
    'CINEMA_R8_OPERATOR_REVIEWED','CINEMA_R8_IMAGE_DIGEST','r8RecentRetentionObserved'])
    assert(gate.includes(term),term);
  assert(!/UPDATE industry|ALTER TABLE|CREATE TABLE|DELETE FROM/.test(gate));
  assert(canary.includes('cinemaR7Canary'));
  assert(canary.includes("runtime.data.onlineIntakeEnabled!==false"));
  assert(canary.includes('cinema/ops/preflight'));
  assert(existsSync(join(root,'services/industry-api/ops/CINEMA_R8_ACCEPTANCE.md')));
});
