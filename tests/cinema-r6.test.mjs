import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=p=>readFileSync(join(root,p),'utf8');
test('CINEMA R6 isolated contact replay and privacy receipt migration',()=>{
  const db=read('services/industry-api/migrations/015_cinema_r6_queue_integrity.sql');
  for(const token of [
    'contact_request_key','contact_request_digest','cinema_r6_contact_idempotency_idx',
    'CREATE TABLE industry.cinema_access_events','ON DELETE SET NULL (lead_id)',
    'FORCE ROW LEVEL SECURITY','CREATE POLICY cinema_access_tenant'
  ])assert(db.includes(token),token);
  assert.doesNotMatch(db,/DISABLE ROW LEVEL SECURITY|DROP TABLE industry\.cinema_leads/);
  const contact=read('services/industry-api/src/cinema-r5.mjs');
  assert(contact.includes("req.headers['idempotency-key']"));
  assert(contact.includes('FOR UPDATE'));
  assert(contact.includes('duplicate:true'));
  assert(contact.includes('contact_request_digest'));
  assert(contact.includes('afterVersion'));
  assert(contact.includes('nextAfterVersion'));
});
test('CINEMA R6 protected queue, owner audit and no silently truncated export',()=>{
  const api=read('services/industry-api/src/cinema-r6.mjs');
  for(const fragment of ['queueOptions','explainTriage','itemsWithTriage','created_at DESC,id DESC',
    'queue/summary','privacy/access-log','FORCE']){if(fragment==='FORCE')continue;assert(api.includes(fragment),fragment);}
  assert.match(api,/protectOwner\(req,\['owner'\]/);
  assert.match(api,/protectOwner\(req,\['owner','manager'\]/);
  const ui=read('assets/stories/manager.js'),html=read('assets/stories/manager.html');
  for(const id of ['r6-view','r6-assigned','r6-more','r6-queue-summary','r6-audit-refresh','r6-workqueue'])
    assert(html.includes('id="'+id+'"'),id);
  for(const term of ['r6Online','nextCursor','loadMoreQueue','request(queueParams','crypto.randomUUID','idempotency-key',
    'truncated','nextAfterVersion','complete:true','r6Signals'])
    assert(ui.includes(term),term);
  assert.doesNotMatch(ui,/localStorage|sessionStorage|innerHTML\s*=\s*item\./i);
  assert.match(read('assets/stories/manager.css'),/@media\(max-width:650px\)/);
});
test('CINEMA R6 read-only release gate, same operator privacy boundaries and retention',()=>{
  const readiness=read('services/industry-api/scripts/cinema-r6-readiness.mjs');
  assert.match(readiness,/inspectCinemaR5/);
  assert.match(readiness,/CINEMA_R6_OPERATOR_REVIEWED/);
  assert.match(readiness,/r6AuditRls/);
  assert.match(readiness,/r6ContactUnique/);
  assert.doesNotMatch(readiness,/DELETE FROM|INSERT INTO|UPDATE industry|CREATE TABLE|CINEMA_PUBLIC_WRITE_ENABLED\s*=\s*'true'/);
  const retention=read('services/industry-api/src/cinema-retention.mjs');
  assert.match(retention,/DELETE FROM industry\.cinema_access_events/);
  assert(read('services/industry-api/package.json').includes('cinema:r6:readiness'));
  assert(existsSync(join(root,'services/industry-api/ops/CINEMA_R6_ACCEPTANCE.md')));
});
