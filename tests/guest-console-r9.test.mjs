import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const [html,js,api,migration,diagnostic,bulk]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/migrations/008_guest_actions_and_imports.sql'),
  read('services/industry-api/src/guest-diagnostics.mjs'),
  read('services/industry-api/src/guest-bulk.mjs')
]);
test('R9 all operator controls have accessible stable IDs and real event handlers',()=>{
  for(const id of ['diagnosticsPanel','diagnosticSummary','diagnosticFindings','refreshDiagnostics',
    'actionForm','actionCode','actionAssignee','actionDue','actionList',
    'bulkPanel','bulkFile','bulkCsv','bulkPreview','bulkCommit','bulkResult']){
    assert.ok(html.includes('id="'+id+'"'),id);
    assert.ok(js.includes("$('"+id+"')")||id==='diagnosticsPanel'||id==='bulkPanel',id);
  }
  assert.match(html,/R13 \/ Защищённый кабинет/);
  assert.match(html,/Без автоматических платежей/);
});
test('R9 browser respects role gates, preview-before-commit and no local persistence',()=>{
  assert.match(js,/bulkPreview'\)\.addEventListener/);
  assert.match(js,/bulkCommit'\)\.addEventListener/);
  assert.match(js,/preview\.csv!==\$\('bulkCsv'\)\.value/);
  assert.match(js,/model\.bulkPreview=null/);
  assert.match(js,/model\.me\.account/);
  assert.match(js,/if\(!manage\(\)\)/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.match(js,/credentials:'same-origin'/);
});
test('R9 server does not accept free-text or arbitrary tasks and preserves atomic import',()=>{
  assert.match(api,/Object\.hasOwn\(RECOMMENDATIONS,b\.code\)/);
  assert.match(api,/recommendations\.some\(r=>r\.code===b\.code\)/);
  assert.match(api,/pg_advisory_xact_lock|FOR UPDATE/);
  assert.match(api,/observations\.batch_imported/);
  assert.match(api,/validatedCsv\(b\.csv,pilot,version\)/);
  assert.match(api,/if\(old\.rowCount\)/);
  assert.match(bulk,/formula|формулы/);
  assert.match(diagnostic,/NOT causal|не поиск доказанных причин/);
});
test('R9 new PostgreSQL tables have enforced RLS and no privileged runtime deletion',()=>{
  for(const table of ['industry.guest_actions','industry.guest_bulk_imports'])
    assert.ok(migration.includes('ALTER TABLE '+table+' FORCE ROW LEVEL SECURITY'));
  assert.match(migration,/UNIQUE\(tenant_id,pilot_id,idempotency_key\)/);
  assert.doesNotMatch(migration,/GRANT\s+.*DELETE|DROP TABLE|TRUNCATE TABLE/);
});
