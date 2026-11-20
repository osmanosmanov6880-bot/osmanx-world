import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=fileURLToPath(new URL('../',import.meta.url));
const read=path=>readFileSync(join(dir,path),'utf8');

test('CINEMA R4 backend has shared atomic replay locks, versioned SLA and campaign columns',()=>{
  const api=read('services/industry-api/src/cinema.mjs');
  const migration=read('services/industry-api/migrations/013_cinema_r4_workflow.sql');
  assert.match(api,/pg_advisory_xact_lock\(hashtextextended/);
  assert.match(api,/next_action_at/);
  assert.match(api,/loss_reason_code/);
  assert.match(api,/campaign_code/);
  assert.match(api,/followupWindow/);
  assert.match(api,/sweepCinemaRows/);
  assert.match(migration,/ADD COLUMN campaign_code/);
  assert.match(migration,/cinema_leads_next_action_pair/);
  assert.match(migration,/ADD PRIMARY KEY \(tenant_id,date_utc,event_type,story_id,campaign_code\)/);
  for(const forbidden of ['DROP TABLE industry.cinema_leads','DISABLE ROW LEVEL SECURITY'])
    assert(!migration.includes(forbidden));
});
test('CINEMA R4 manager has safe follow-up and campaign controls without extra analytics trackers',()=>{
  const page=read('assets/stories/manager.html'),script=read('assets/stories/manager.js');
  for(const marker of ['r4-followup-window','r4-followup-items','r4-campaign-metrics','r4-link-form','r4-created-link'])
    assert.match(page,new RegExp(marker));
  for(const marker of ['nextActionAt','nextActionKind','lossReasonCode','expectedVersion','campaign_code','r4-followup-window'])
    assert(script.includes(marker),marker);
  assert.match(script,/csvCell/);
  assert.doesNotMatch(script,/GoogleAnalytics|gtag\(|localStorage|sessionStorage|innerHTML\s*=\s*item\./i);
  assert.match(read('assets/stories/manager.css'),/@media\(max-width:650px\)/);
});
test('CINEMA R4 public capture keeps privacy-first fallback and attributes only approved campaigns',()=>{
  const js=read('assets/stories/cinema-r3.js');
  assert.match(js,/utm_campaign/);
  assert.match(js,/campaignCode/);
  assert.match(js,/^[\s\S]*Idempotency-Key/);
  assert.match(js,/r3-email-fallback/);
  assert.match(js,/consent:true/);
  assert.doesNotMatch(js,/localStorage|sessionStorage|document\.cookie|tracker\.js/);
});
test('R4 privacy retention cannot start without manual opt-in and uses existing RLS',()=>{
  const cli=read('services/industry-api/scripts/cinema-retention.mjs');
  const worker=read('services/industry-api/src/cinema-retention.mjs');
  const compose=read('services/industry-api/compose.yml');
  const unit=read('services/industry-api/ops/systemd/osmanx-cinema-retention.service');
  const timer=read('services/industry-api/ops/systemd/osmanx-cinema-retention.timer');
  assert(cli.includes("CINEMA_RETENTION_ENABLED!=='true'"));
  assert(!cli.includes("CINEMA_PUBLIC_WRITE_ENABLED!=='true'"));
  assert(worker.includes("withTenant(pool,tenant"));
  assert(worker.includes("pg_try_advisory_xact_lock"));
  for(const retention of ["interval '90 days'","interval '180 days'","interval '48 hours'"])
    assert(worker.includes(retention),retention);
  assert(compose.includes('profiles: ["cinema-retention"]'));
  assert(unit.includes('Type=oneshot'));
  assert(timer.includes('OnCalendar='));
  assert(existsSync(join(dir,'services/industry-api/ops/CINEMA_R4_RETENTION.md')));
});
