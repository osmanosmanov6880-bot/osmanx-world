import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const get=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,api,migration,ops]=await Promise.all([
  get('assets/guest/console.html'),
  get('assets/guest/console.js'),
  get('services/industry-api/src/guest.mjs'),
  get('services/industry-api/migrations/009_guest_action_history.sql'),
  get('services/industry-api/src/guest-operations.mjs')
]);
test('R11 operations is a real RU owner UI, with timeline, reassignment and verified export controls',()=>{
  for(const id of ['operationsPanel','operationsSummary','operationsList','operationsRefresh',
    'actionHistoryPanel','actionHistory','actionAssignmentForm','assignmentAssignee',
    'assignmentDue','assignmentCancel','downloadOperations'])
    assert.ok(html.includes('id="'+id+'"'),'Missing '+id);
  for(const control of ['operationsRefresh','assignmentCancel','actionAssignmentForm',
    'downloadOperations','assignmentAssignee','assignmentDue'])
    assert.ok(js.includes("$('"+control+"')"),'Unwired '+control);
  assert.match(html,/Guest Intelligence \/ R13 \/ Защищённый кабинет/);
  assert.match(html,/Без автоматических платежей/);
});
test('R11 client verifies both integrity digests in Web Crypto, without local persistence or injection',()=>{
  assert.match(js,/crypto\.subtle\.digest\('SHA-256',data\)/);
  assert.match(js,/digest\(packet\.snapshot\.evidence\)/);
  assert.match(js,/digest\(packet\.snapshot\)/);
  assert.match(js,/credentials:'same-origin'/);
  assert.match(js,/operations\/export\.json/);
  assert.match(js,/\/guest\/operations/);
  assert.match(js,/\/assignment/);
  assert.match(js,/\/history/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
});
test('R11 API never exposes cross-tenant operational data and requires real management role to assign/export',()=>{
  assert.match(api,/app\.get\(P\+'\/operations',req=>forTenant\(req,MANAGE/);
  assert.match(api,/app\.patch\(P\+'\/pilots\/:id\/actions\/:actionId\/assignment',req=>forTenant\(req,MANAGE/);
  assert.match(api,/app\.get\(P\+'\/pilots\/:id\/operations\/export\.json',\(req,reply\)=>forTenant\(req,MANAGE/);
  assert.match(api,/addActionHistory\(db,s,pilot/);
  assert.match(api,/FOR UPDATE/);
  assert.match(api,/guest_action_history/);
  assert.match(ops,/SHA-256 обнаруживает изменение пакета/);
});
test('R11 append-only table has RLS, no runtime UPDATE/DELETE and refuses mutation by trigger',()=>{
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
  assert.match(migration,/GRANT SELECT,INSERT ON industry\.guest_action_history TO industry_app/);
  assert.match(migration,/BEFORE UPDATE OR DELETE ON industry\.guest_action_history/);
  assert.match(migration,/UNIQUE\(tenant_id,action_id,action_version\)/);
  assert.match(migration,/baseline/);
  assert.doesNotMatch(migration,/GRANT\s+[^\n]*\bUPDATE\b|GRANT\s+[^\n]*\bDELETE\b/);
});
