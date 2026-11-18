import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {riskForPilot,createOperationsOverview,createOperationsExport} from '../src/guest-operations.mjs';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const NOW=new Date('2026-11-18T12:00:00Z');
const basic={id:'pilot-1',title:'Synthetic service',phase:'running',version:3,
  updated_at:'2026-11-01T00:00:00Z',period_count:0,open_actions:2,overdue_actions:1,
  protocol:{endDate:'2026-11-10',outcomeWindowDays:3}};
test('R11 risk rules identify overdue, stale collection and expired protocol independently',()=>{
  const alerts=riskForPilot(basic,{now:NOW});
  assert.deepEqual(alerts.map(a=>a.code),
    ['OVERDUE_ACTIONS','WINDOW_ENDED','NO_OBSERVATIONS']);
  assert.equal(alerts[0].severity,'high');
  assert.ok(alerts.every(x=>x.nextStep.length>10));
  assert.deepEqual(riskForPilot({...basic,phase:'draft',overdue_actions:0},{now:NOW}),[]);
});
test('R11 workflow signals do not claim causal outcomes',()=>{
  const review=riskForPilot({...basic,phase:'in_review',overdue_actions:0},{now:NOW});
  assert.deepEqual(review.map(a=>a.code),['REVIEW_STALLED']);
  const returned=riskForPilot({...basic,phase:'returned',overdue_actions:0},{now:NOW});
  assert.deepEqual(returned.map(a=>a.code),['RETURN_STALLED']);
  assert.deepEqual(riskForPilot({...basic,phase:'in_review',updated_at:'2026-11-17T00:00:00Z',
    overdue_actions:0},{now:NOW}),[]);
});
test('R11 operations queue orders real risks before normal entries, reports limits',()=>{
  const rows=[
    {...basic,id:'healthy',title:'Normal',phase:'draft',updated_at:'2026-11-16T00:00:00Z',
      overdue_actions:0,period_count:0},
    {...basic,id:'urgent',title:'Urgent'},
    {...basic,id:'pending',title:'Pending review',phase:'in_review',overdue_actions:0}
  ];
  const report=createOperationsOverview(rows,{now:NOW,limit:2});
  assert.equal(report.items.length,2);
  assert.equal(report.items[0].id,'urgent');
  assert.equal(report.truncated,true);
  assert.equal(report.totals.atRisk,2);
  assert.match(report.disclaimer,/не подтверждают прибыль/);
  assert.throws(()=>createOperationsOverview(rows,{limit:1000}),TypeError);
});
test('R11 auditor packet verifies original Guest evidence and exact canonical checksum',()=>{
  const evidence={schema:'osmanx.guest.evidence.v2',
    plan:{fee:25000},protocol:{source:'pos'},observations:[{date:'2026-11-10',control:20,
      controlReturn:4,offer:20,offerReturn:6}]};
  const pilot={id:'pilot-1',title:'Synthetic',version:5,phase:'archived',
    protocol:{source:'pos'},protocol_registered_at:'2026-11-01T00:00:00Z',
    archived_at:'2026-11-18T00:00:00Z'};
  const action={id:'a1',code:'COLLECT_OBSERVATIONS',status:'done'};
  const history=[{action_id:'a1',action_version:2,event_type:'status'},
    {action_id:'a1',action_version:1,event_type:'created'}];
  const inputs={pilot,evidence,evidenceDigest:sha(evidence),actions:[action],
    history,imports:[{id:'i1',created_at:'2026-11-09T00:00:00Z'}],
    review:{decision:'accept_for_discussion'}};
  const a=createOperationsExport(inputs),b=createOperationsExport(inputs);
  assert.deepEqual(a,b);
  assert.equal(a.format,'osmanx.guest.operations.export.v1');
  assert.equal(a.sha256,sha(a.snapshot));
  assert.equal(a.snapshot.evidenceSha256,sha(evidence));
  assert.deepEqual(a.snapshot.actionHistory.map(x=>x.action_version),[1,2]);
  assert.match(a.disclaimer,/НЕ является цифровой подписью/);
  assert.throws(()=>createOperationsExport({...inputs,evidence:{...evidence,plan:{fee:1}}}),
    /Evidence has changed/);
  assert.throws(()=>createOperationsExport({...inputs,history:Array(501).fill(history[0])}),
    /safe bound/);
});
