import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const read=file=>readFileSync(join(ROOT,file),'utf8');
const files=['assets/stories/cinema-r3.js','assets/stories/cinema-r3.css',
  'assets/stories/manager.html','assets/stories/manager.css','assets/stories/manager.js',
  'assets/stories/privacy.html'];
test('R3: customer and staff interfaces are self-contained and linked',()=>{
  for(const file of files)assert(existsSync(join(ROOT,file)),file);
  const page=read('assets/stories/cinema.html');
  assert.match(page,/cinema-r3\.css/);
  assert.match(page,/cinema-r3\.js/);
  assert.match(page,/25 000 ₽/);
  assert.match(page,/guest\/order\.html\?plan=pilot/);
  assert.match(read('assets/stories/cinema-r2.js'),/osmanx:cinema-r2-ready/);
  const manager=read('assets/stories/manager.html');
  assert.match(manager,/noindex,nofollow/);
  assert.match(manager,/manager\.js/);
  assert.match(manager,/id="workspace" hidden/);
  assert.match(manager,/id="login-form"/);
});
test('R3: consent is required, server return is validated and email fallback remains',()=>{
  const js=read('assets/stories/cinema-r3.js');
  assert.match(js,/r3-consent/);
  assert.match(js,/consent:true/);
  assert.match(js,/answer\.accepted!==true/);
  assert.match(js,/Idempotency-Key/);
  assert.match(js,/r3-email-fallback/);
  assert.match(js,/intakeEnabled===true/);
  assert.match(js,/aggregateEventsEnabled===true/);
  assert.match(js,/requestKey=crypto\.randomUUID\(\)/);
  assert.doesNotMatch(js,/localStorage|sessionStorage|window\.location\s*=\s*https?:\/\//i);
  assert.doesNotMatch(js,/_jwt=|cloudfront\.net|fonts\.googleapis\.com/i);
});
test('R3: admin UI uses cookies, CSRF and escapes user content into text nodes',()=>{
  const js=read('assets/stories/manager.js');
  assert.match(js,/x-csrf-token/);
  assert.match(js,/credentials:'same-origin'/);
  assert.match(js,/expectedVersion:item\.version/);
  assert.match(js,/confirm\(/);
  assert.match(js,/csvCell/);
  assert.match(js,/CSRF|csrf/);
  assert.doesNotMatch(js,/localStorage|sessionStorage|innerHTML\s*=\s*item\./i);
});
test('R3: privacy text states limits, no automatic payment or guaranteed lead flow',()=>{
  const text=read('assets/stories/privacy.html');
  assert.match(text,/90 дней/);
  assert.match(text,/Согласие/);
  assert.match(text,/не отправляются автоматически/);
  assert.match(text,/расписание/);
  assert.match(text,/юридическое лицо/);
});
test('R3: backend route is operator-gated and RLS is enforced',()=>{
  const sql=read('services/industry-api/migrations/012_cinema_commercial.sql');
  for(const name of ['cinema_leads','cinema_lead_events','cinema_rate_limits','cinema_daily_events']){
    assert.match(sql,new RegExp('ALTER TABLE industry\\.'+name+' FORCE ROW LEVEL SECURITY;'));
  }
  const backend=read('services/industry-api/src/cinema.mjs');
  assert.match(backend,/CINEMA_PUBLIC_WRITE_ENABLED/);
  assert.match(backend,/CINEMA_RATE_SECRET/);
  assert.match(backend,/Idempotency-Key|idempotency-key/);
  assert.match(backend,/withTenant\(/);
  assert.match(backend,/permittedTransition/);
  assert.match(backend,/delete base|\+\'\/retention\'/);
  assert.doesNotMatch(backend,/console\.log\(/);
});
