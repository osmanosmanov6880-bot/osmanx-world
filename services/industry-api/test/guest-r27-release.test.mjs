import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateR27Chain,R26_PR,R27_CHAIN_SCHEMA}
  from '../scripts/r27-release-plan.mjs';
function fixture(){
  const r26={
    number:R26_PR.number,head:{ref:R26_PR.head,sha:R26_PR.sha},
    base:{ref:R26_PR.base},state:'open',merged:false,draft:true
  };
  const checks=R26_PR.checks.map(name=>({
    name,head_sha:R26_PR.sha,status:'completed',conclusion:'success'
  }));
  return {previous:{},r26,checks,
    compare:{base:R26_PR.parent,head:R26_PR.sha,status:'ahead'},
    mainComparison:{mainSha:'a'.repeat(40),
      headSha:R26_PR.sha,status:'ahead'}};
}
test('R27 exactly enumerates 13 manual PR steps and never pretends source CI means merged',()=>{
  const report=evaluateR27Chain(fixture());
  assert.equal(report.schema,R27_CHAIN_SCHEMA);
  assert.equal(report.pinnedSourceCount,13);
  assert.deepEqual(report.manualPlan.map(x=>x.pr),
    [47,48,49,51,52,53,54,55,56,57,58,59,60]);
  assert.ok(report.manualPlan.every((x,i)=>
    x.order===i+1&&x.automaticMergeAllowed===false));
  assert.equal(report.manualPlan[12].sourceSha,R26_PR.sha);
  assert.equal(report.dependencies[12].ciPassed,true);
  assert.equal(report.dependencies[12].parentCommitAncestor,true);
  assert.equal(report.allMerged,false);
  assert.equal(report.automaticMergeAllowed,false);
  assert.equal(report.deployAllowed,false);
  assert.equal(report.changedMain,false);
  assert.equal(report.productionAuthorized,false);
});
test('R27 rejects altered PR source commit, missing CI, ancestry drift and draft stage',()=>{
  const p=fixture();
  assert.ok(evaluateR27Chain(p).blockers.includes('R26_NOT_MERGED'));
  assert.ok(evaluateR27Chain(p).blockers.includes('R26_DRAFT_REQUIRES_REVIEW'));
  p.r26.head.sha='0'.repeat(40);
  assert.ok(evaluateR27Chain(p).blockers.includes('R26_HEAD_SHA_OR_BASE_CHANGED'));
  p.r26=fixture().r26;p.checks.pop();
  assert.ok(evaluateR27Chain(p).blockers.includes('R26_REQUIRED_NAMED_CI_MISSING'));
  p.checks=fixture().checks;p.compare.status='diverged';
  assert.ok(evaluateR27Chain(p).blockers.includes('R26_PARENT_ANCESTRY_CHANGED'));
  p.compare=fixture().compare;p.mainComparison.mainSha='0'.repeat(40);
  assert.ok(evaluateR27Chain(p).blockers.includes('MAIN_TIP_NOT_PINNED_FOR_R27'));
});
