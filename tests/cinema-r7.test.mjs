import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=p=>readFileSync(join(root,p),'utf8');
test('R7 indexed tenant-safe duplicate lookup and atomic ownership',()=>{
  const sql=read('services/industry-api/migrations/016_cinema_r7_lookup.sql');
  assert(sql.includes("industry.cinema_leads(tenant_id, lower(contact_email)"));
  assert.doesNotMatch(sql,/DISABLE ROW LEVEL SECURITY|DROP TABLE/);
  const src=read('services/industry-api/src/cinema-r7.mjs');
  for(const v of ['/leads/:id/claim','/leads/:id/similar','/leads/:id/audit-integrity',
    '/team/workload','FOR UPDATE','expectedVersion','assigned_changed','lower(contact_email)']){
    assert(src.includes(v),v);
  }
  assert(src.includes("role!=='owner'"));
  assert(src.includes("proofLevel:'sequence_consistency_only_not_cryptographic'"));
});
test('R7 manager frontend is backward-compatible, never interpolates raw lead HTML',()=>{
  const h=read('assets/stories/manager.html'),ui=read('assets/stories/manager.js');
  assert(h.includes('id="r7-workload"'));assert(h.includes('id="r7-staff-overview"'));
  for(const s of ['r7Online','renderWorkload','/cinema/team/workload','/cinema/leads/',
    "'/claim'","'/similar'","'/audit-integrity'","method:'POST',payload:{email}"])
    assert(ui.includes(s),s);
  assert.doesNotMatch(ui,/localStorage|sessionStorage|innerHTML\s*=\s*item\./i);
  assert(read('assets/stories/manager.css').includes('min-height:44px'));
});
test('R7 staging canary is loopback only and read-only gate never activates writes',()=>{
  const gate=read('services/industry-api/scripts/cinema-r7-readiness.mjs');
  const probe=read('services/industry-api/scripts/cinema-r7-canary.mjs');
  for(const s of ['inspectCinemaR6','r7Index','CINEMA_R7_OPERATOR_REVIEWED',
    'publicIntakeOff','aggregateActionsOff'])assert(gate.includes(s),s);
  assert(!/UPDATE industry|INSERT INTO|DROP TABLE|ALTER TABLE/.test(gate));
  for(const s of ['127.0.0.1',"redirect:'error'",'/cinema/public/config',
    '/cinema/queue','/cinema/public/leads','config.payload.intakeEnabled!==false'])
    assert(probe.includes(s),s);
  assert(existsSync(join(root,'services/industry-api/ops/CINEMA_R7_RUNBOOK.md')));
});
