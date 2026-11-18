import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseAggregates,RECOMMENDATIONS,ACTION_CODES} from '../src/guest-diagnostics.mjs';
import {parseAggregateCsv,validateBatchWindow,batchDigest,summarizeBatch} from '../src/guest-bulk.mjs';

const pilot={
  target_per_group:300,phase:'running',
  protocol:{startDate:'2026-11-01',endDate:'2026-11-16',
    outcomeWindowDays:1,allocation:'matched',source:'manual'},
  protocol_registered_at:'2026-11-18T00:00:00.000Z'
};
const rows=[
  {date:'2026-11-09',control:100,controlReturn:20,offer:70,offerReturn:10},
  {date:'2026-11-10',control:80,controlReturn:16,offer:120,offerReturn:40}
];
const CSV='date,control,controlReturn,offer,offerReturn\n'+
  '2026-11-10,80,16,120,40\n2026-11-09,100,20,70,10\n';

test('R9 diagnostics are reproducible, list verifiable risks, never assert causation',()=>{
  const a=diagnoseAggregates({pilot,observations:rows}),b=diagnoseAggregates({pilot,observations:rows});
  assert.deepEqual(a,b);
  assert.equal(a.schema,'osmanx.guest.diagnostic.v1');
  assert.equal(a.sample.control,180);assert.equal(a.sample.offer,190);
  assert.equal(a.sample.enough,false);assert.equal(a.rates.controlPct,20);
  assert.equal(a.rates.offerPct,26.32);
  assert.ok(a.recommendations.some(r=>r.code==='RECRUIT_MORE_GUESTS'));
  assert.ok(a.recommendations.some(r=>r.code==='VERIFY_GROUP_ASSIGNMENT'));
  assert.ok(a.recommendations.some(r=>r.code==='REGISTER_FUTURE_PROTOCOL'));
  assert.ok(a.recommendations.some(r=>r.code==='VALIDATE_SOURCE'));
  assert.equal(a.disposition,'INSUFFICIENT_SAMPLE');
  assert.match(a.disclaimer,/не поиск доказанных причин/);
  assert.ok(ACTION_CODES.length>=8);
  assert.ok(ACTION_CODES.every(code=>RECOMMENDATIONS[code].title));
});
test('R9 diagnostic empty and imbalanced groups explicitly warn instead of inventing outcomes',()=>{
  const empty=diagnoseAggregates({pilot,observations:[]});
  assert.equal(empty.rates.differencePp,null);
  assert.equal(empty.disposition,'NO_DATA');
  assert.ok(empty.recommendations.some(r=>r.code==='COLLECT_OBSERVATIONS'));
  const unbalanced=diagnoseAggregates({pilot,observations:[{
    date:'2026-11-09',control:500,controlReturn:100,offer:100,offerReturn:10
  }]});
  assert.ok(unbalanced.recommendations.some(r=>r.code==='CHECK_GROUP_BALANCE'));
  assert.ok(unbalanced.recommendations.some(r=>r.code==='INVESTIGATE_GUEST_JOURNEY'));
});
test('R9 recommended follow-up is discussion only even with enough sample',()=>{
  const data=diagnoseAggregates({pilot:{...pilot,target_per_group:150},observations:rows});
  assert.equal(data.sample.enough,true);
  assert.ok(data.recommendations.some(r=>r.code==='REVIEW_CONTROLLED_FOLLOWUP'));
  assert.equal(data.disposition,'REVIEW_RECOMMENDED');
  assert.match(data.disclaimer,/не расчёт реальной выручки/);
});
test('R9 CSV canonical sort, parse and SHA preview are deterministic',()=>{
  const parsed=parseAggregateCsv(CSV);
  assert.equal(parsed.length,2);
  assert.equal(parsed[0].date,'2026-11-09');
  assert.equal(parsed[1].date,'2026-11-10');
  assert.deepEqual(validateBatchWindow(parsed,pilot.protocol,new Date('2026-11-18T10:00:00Z')),parsed);
  const s=summarizeBatch(parsed);
  assert.equal(s.totals.control,180);assert.equal(s.totals.offerReturn,50);
  const one=batchDigest('x',3,parsed);
  assert.match(one,/^[0-9a-f]{64}$/);
  assert.equal(one,batchDigest('x',3,parseAggregateCsv(CSV)));
  assert.notEqual(one,batchDigest('x',4,parsed));
  assert.notEqual(one,batchDigest('other',3,parsed));
});
test('R9 CSV rejects formula injection, identifiers, duplicates, bad dates and overflows',()=>{
  const invalid=[
    CSV.replace('100,20,70,10','=1+1,20,70,10'),
    CSV.replace('100,20,70,10','100,20,70,caller@example.com'),
    CSV.replace('2026-11-10','2026-11-09'),
    CSV.replace('2026-11-10','2026-02-30'),
    CSV.replace('100,20,70,10','100,101,70,10'),
    CSV.replace('100,20,70,10','100,20,0,0'),
    CSV.replace('100,20,70,10','100,20,10000001,0'),
    CSV.replace('100,20,70,10','100.5,20,70,10'),
    CSV.replace('2026-11-09,100','+2026-11-09,100'),
    CSV.replace('date,control','user,control'),
    'date,control,controlReturn,offer,offerReturn\n',
    CSV+'2030-01-01,1,0,1,0\n'.repeat(12),
    CSV.padEnd(5000,'a')
  ];
  for(const v of invalid)assert.throws(()=>parseAggregateCsv(v),undefined,v.slice(0,60));
  assert.throws(()=>validateBatchWindow(parseAggregateCsv(CSV),pilot.protocol,
    new Date('2026-11-09T00:00:00Z')));
  const outOfWindow=parseAggregateCsv(
    'date,control,controlReturn,offer,offerReturn\n2026-11-20,1,0,1,0\n');
  assert.throws(()=>validateBatchWindow(outOfWindow,pilot.protocol,new Date('2026-11-30T00:00:00Z')));
});
