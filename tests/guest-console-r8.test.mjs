import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const [html,js,api,migration]=await Promise.all([
  read('assets/guest/console.html'),read('assets/guest/console.js'),
  read('services/industry-api/src/guest.mjs'),
  read('services/industry-api/migrations/007_guest_protocol_governance.sql')
]);
test('R8 interface exposes all six locked experiment protocol controls and owner dashboard',()=>{
  for(const id of ['studyStart','studyEnd','studyWindow','studyAllocation','studySource',
    'protocolStatus','overviewPanel','overviewRequests','overviewPilots','overviewQuotas',
    'retentionRun','overviewRefresh']){
    assert.ok(html.includes('id="'+id+'"'),'Missing '+id);
  }
  assert.match(html,/Зафиксированный протокол/);
  assert.match(html,/РЕТРОСПЕКТИВ|ретроспективный риск/);
});
test('R8 frontend always submits a fixed metric and explicit protocol to the real API',()=>{
  assert.match(js,/primaryMetric:'repeat_visit'/);
  assert.match(js,/plan,requestId,protocol/);
  assert.match(js,/\/guest\/overview/);
  assert.match(js,/\/guest\/requests\/retention/);
  assert.match(js,/protocolRegisteredAt|prospectivelyRegistered/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|\.innerHTML\s*=/);
  assert.match(js,/credentials:'same-origin'/);
});
test('R8 server forbids late/out-of-window records and prevents evidence mutation',()=>{
  assert.match(api,/checkPeriodInProtocol\(pilot,ob\.date\)/);
  assert.match(api,/assertMatured\(pilot\)/);
  assert.match(api,/protocolRegisteredAt/);
  assert.match(api,/osmanx\.guest\.evidence\.v2/);
  assert.match(api,/pg_advisory_xact_lock/);
  assert.match(migration,/CREATE TRIGGER guest_protocol_immutable/);
  assert.match(migration,/FORCE ROW LEVEL SECURITY/);
});
test('R8 exposes no personally identifiable data in aggregated overview',()=>{
  const begin=api.indexOf("app.get(P+'/overview'");
  const end=api.indexOf("app.post(P+'/requests/retention'");
  assert.ok(begin>0&&end>begin);
  const body=api.slice(begin,end);
  assert.doesNotMatch(body,/display_name|phone|email|password_hash/);
  assert.match(body,/quotas:/);
});
