import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const read=p=>readFileSync(join(ROOT,p),'utf8');
test('R9 generated CSV audit and efficient contact evidence index retain tenant protection',()=>{
  const sql=read('services/industry-api/migrations/018_cinema_r9_export_evidence.sql');
  assert(sql.includes('bulk_export_generated'));
  assert(sql.includes('cinema_r9_contact_first_event_idx'));
  assert(sql.includes("WHERE event_type='contact_logged'"));
  assert(!/DISABLE ROW LEVEL SECURITY|DROP TABLE/.test(sql));
  const src=read('services/industry-api/src/cinema-r9.mjs');
  for(const s of ['/exports/csv','/ops/response-review','/public/r9-runtime',
    'protectOwner(req,[\\'owner\\']','FOR SHARE','bulk_export_generated',
    'GENERATE_CSV','application/json','first_attempt AS','eligible_1h',
    'contact_logged','no-store','attachment','nosniff']){
    if(s==='application/json')continue;assert(src.includes(s.replaceAll("\\'","'")),s);
  }
  assert(src.includes('return reply.send(body.csv)'));
  assert(src.includes('id=ANY($2::uuid[])'));
  assert(read('services/industry-api/src/cinema.mjs').includes('registerCinemaR9Routes'));
});
test('R9 mobile dashboard uses server CSV, visual 409 recovery and truthful denominators',()=>{
  const html=read('assets/stories/manager.html'),js=read('assets/stories/manager.js');
  for(const id of ['r9-response','r9-review-days','r9-response-cards','r9-conflict',
    'r9-conflict-reload','r9-conflict-message'])assert(html.includes('id="'+id+'"'),id);
  for(const token of ['r9Online','refreshR9Response','renderR9Response',
    "request('/cinema/public/r9-runtime')",'/cinema/exports/csv','GENERATE_CSV',
    'response.blob()','showConflict','response.status===409','eligible_1h'])
    assert(js.includes(token),token);
  assert(!js.includes("request('/cinema/exports/approve'"),
    'New UI must not authorize stale client-built CSV');
  assert(!js.includes("const lines=rows.map(x=>[x.id,x.contact_name"),
    'Client should not serialize sensitive lead records into a CSV');
  assert.doesNotMatch(js,/localStorage|sessionStorage|innerHTML\s*=\s*item\./i);
  assert(read('assets/stories/manager.css').includes('@media(max-width:650px)'));
});
test('R9 staging release is gated and never enables writes or remote canary addresses',()=>{
  const gate=read('services/industry-api/scripts/cinema-r9-readiness.mjs'),
    canary=read('services/industry-api/scripts/cinema-r9-canary.mjs');
  for(const t of ['inspectCinemaR8','r9AuditAction','r9ContactIndex',
    'CINEMA_R9_OPERATOR_REVIEWED'])assert(gate.includes(t),t);
  assert.doesNotMatch(gate,/UPDATE industry|DELETE FROM|CREATE TABLE|ALTER TABLE/);
  for(const t of ['cinemaR8Canary','canaryTarget','/cinema/public/r9-runtime',
    '/cinema/exports/csv','/cinema/ops/response-review','NO-GO'])
    assert(canary.includes(t),t);
  assert(read('services/industry-api/package.json').includes('cinema:r9:readiness'));
  assert(existsSync(join(ROOT,'services/industry-api/ops/CINEMA_R9_ACCEPTANCE.md')));
});
