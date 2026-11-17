import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {READINESS_KEYS,MAX_WEEKS,R3_SCHEMA,readiness,planSampleSize,weeklyLedger,
  createBundle,readBundle,evaluate,reportCsv} from '../assets/guest/pilot-model.js';

const ready=Object.fromEntries(READINESS_KEYS.map(k=>[k,true]));
const blocked={...ready,contactConsent:false,independentGroups:false};
const plan={baselinePct:20,liftPp:10,margin:250,discount:10,fixed:300,fee:25000};
const periods=[
  {date:'2026-11-02',control:100,controlReturn:20,offer:100,offerReturn:30},
  {date:'2026-11-09',control:120,controlReturn:24,offer:120,offerReturn:36}
];
const sample={plan,readiness:ready,rows:periods,finalized:true};
const approx=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<eps,String(a)+' should be near '+String(b));

test('R3.1 readiness gate never claims go without all six checks',()=>{
  const a=readiness(ready);assert.equal(a.passed,6);assert.equal(a.ready,true);
  const b=readiness(blocked);assert.equal(b.passed,4);assert.equal(b.ready,false);
  assert.ok(b.blocking.some(x=>x.includes('согласия')));
  assert.throws(()=>readiness({...ready,company:'secret'}));
  assert.throws(()=>readiness({...ready,contactConsent:'yes'}));
});
test('R3.2 approximate independent proportions sample sizes scale correctly',()=>{
  const a=planSampleSize(20,10),b=planSampleSize(20,5);
  assert.ok(a.perGroup>=250 && a.perGroup<500);
  assert.ok(b.perGroup>a.perGroup);
  assert.equal(a.total,a.perGroup*2);
  assert.equal(a.power,.8);assert.equal(a.alpha,.05);
  approx(a.baseline,.2);approx(a.target,.3);
});
test('R3.2 sample planning blocks invalid effects and unrealistic baselines',()=>{
  for(const [b,d] of [[0,10],[99,10],[20,0],[20,.1],[20,-3],[98,2],[20,'1e3']]){
    assert.throws(()=>planSampleSize(b,d));
  }
});
test('R3.3 aggregate weekly results by counts and chronologically sort periods',()=>{
  const data=weeklyLedger([...periods].reverse());
  assert.equal(data.weeks.length,2);
  assert.equal(data.weeks[0].date,'2026-11-02');
  assert.equal(data.aggregate.control,220);
  assert.equal(data.aggregate.offerReturn,66);
  approx(data.c.controlRate,.2);approx(data.c.offerRate,.3);approx(data.c.difference,.1);
  assert.match(data.warning,/непересекающимся/);
});
test('R3.3 rejects missing/extra fields, out-of-bounds counts, invalid and duplicate dates',()=>{
  assert.throws(()=>weeklyLedger([]));
  assert.throws(()=>weeklyLedger(periods.concat(periods[0])));
  assert.throws(()=>weeklyLedger(Array(MAX_WEEKS+1).fill(periods[0])));
  for(const row of [
    {...periods[0],date:'2026-02-29'},
    {...periods[0],offerReturn:101},
    {...periods[0],control:0},
    {...periods[0],controlReturn:-1},
    {...periods[0],control:'1.4'},
    {...periods[0],phone:'89990000000'}
  ])assert.throws(()=>weeklyLedger([row]));
});
test('R3.4 interim results never approved based on interim significance',()=>{
  const base=evaluate({...sample,finalized:false});
  assert.equal(base.assessment.status,'ПРОМЕЖУТОЧНО');
  assert.ok(base.assessment.warnings.some(x=>x.includes('промежуточные')));
  assert.equal(base.assessment.associationOnly,true);
});
test('R3.4 finalized but underpowered or missing consent cannot claim verified lift',()=>{
  const low=evaluate({...sample,readiness:blocked});
  assert.equal(low.assessment.status,'НЕДОСТАТОЧНО ОСНОВАНИЙ');
  assert.equal(low.assessment.enough,false);
  assert.match(low.report,/ОГРАНИЧЕНИЯ/);
  assert.match(low.report,/НЕТ ГАРАНТИРОВАННОЙ ПРИБЫЛИ/);
});
test('R3.4 cost model subtracts proposal costs and one fee once, not weekly',()=>{
  const output=evaluate(sample);
  approx(output.assessment.financial.incrementalVisits,22);
  approx(output.assessment.financial.costs,27500);
  approx(output.assessment.financial.net,-22000);
  assert.ok(output.assessment.financial.rangeNet[0]<=output.assessment.financial.net);
});
test('R3.4 review requires final, readiness AND enough cohort size',()=>{
  const ps=planSampleSize(20,10);
  const row={date:'2026-11-09',control:ps.perGroup,controlReturn:Math.floor(ps.perGroup*.2),
    offer:ps.perGroup,offerReturn:Math.floor(ps.perGroup*.3)};
  const r=evaluate({...sample,rows:[row]});
  assert.equal(r.assessment.enough,true);
  assert.equal(r.assessment.status,'ГОТОВО К ЭКСПЕРТНОМУ РАЗБОРУ');
  assert.match(r.report,/не подтверждение выручки/);
});
test('R3.5 snapshot allowlist roundtrip with strict schema, no side effects',()=>{
  const blob=createBundle(sample);
  assert.equal(blob.schema,R3_SCHEMA);
  assert.deepEqual(readBundle(JSON.stringify(blob)),blob);
  assert.deepEqual(createBundle(sample),blob);
});
test('R3.5 rejects personal data in any nested field and future unknown schema',()=>{
  const blob=createBundle(sample);
  const candidates=[
    {...blob,email:'someone@example.com'},
    {...blob,readiness:{...blob.readiness,fullName:'Person'}},
    {...blob,plan:{...blob.plan,phone:'12345'}},
    {...blob,rows:[{...blob.rows[0],guest:'Name'}]},
    {...blob,schema:'osmanx.guest.pilot.future'}
  ];
  for(const c of candidates)assert.throws(()=>readBundle(JSON.stringify(c)));
  assert.throws(()=>readBundle('not json'));
  assert.throws(()=>readBundle('z'.repeat(32769)));
  assert.throws(()=>createBundle({...sample,finalized:'true'}));
});
test('R3.5 CSV is exportable and no user identities are embedded',()=>{
  const result=evaluate(sample);
  const doc=reportCsv(result);
  assert.ok(doc.startsWith('\uFEFF'));
  assert.match(doc,/Итого/);
  assert.match(result.report,/220/);
  assert.doesNotMatch(doc,/customerName|phone|email/);
});
test('R3.5 public UI declares local operation and contains full control suite',async()=>{
  const html=await readFile(new URL('../assets/guest/pilot.html',import.meta.url),'utf8');
  const js=await readFile(new URL('../assets/guest/pilot.js',import.meta.url),'utf8');
  assert.match(html,/connect-src 'none'/);
  assert.match(html,/data-ready="contactConsent"/);
  assert.match(html,/script type="module" src="\.\/pilot\.js"/);
  assert.match(html,/не сохраняется в localStorage/);
  for(const key of ['baselinePct','liftPp','margin','discount','fixed','fee','weeks','addWeek','downloadCSV','downloadJSON','copyReport']){
    assert.ok(html.includes('id="'+key+'"'),'UI missing '+key);
  }
  assert.doesNotMatch(js,/\bfetch\s*\(|localStorage|sessionStorage|sendBeacon/);
  assert.doesNotMatch(js, /\.innerHTML\s*=/);
});
