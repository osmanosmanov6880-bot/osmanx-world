import test from 'node:test';
import assert from 'node:assert/strict';
import {SOURCE_PRS,R25_CHAIN_SCHEMA,evaluateR25Chain}
  from '../scripts/r25-release-chain.mjs';
function fixture(){
  const source={};
  for(const spec of SOURCE_PRS)source[spec.number]={
    pr:{number:spec.number,
      head:{ref:spec.head,sha:spec.sha},base:{ref:spec.base},
      state:'open',merged:false},
    checks:spec.checks.map(name=>({
      name,head_sha:spec.sha,status:'completed',conclusion:'success'
    })),
    compare:{base:spec.parent,head:spec.sha,status:'ahead'}
  };
  return {prior:{},source,mainComparison:{}};
}
test('R25 tracks eleven pinned source PRs and distinguishes green staged CI from actual merges',()=>{
  const report=evaluateR25Chain(fixture());
  assert.equal(report.schema,R25_CHAIN_SCHEMA);
  assert.deepEqual(report.dependencies.map(x=>x.pr),
    [47,48,49,51,52,53,54,55,56,57,58]);
  assert.equal(report.dependencies[9].headPinned,true);
  assert.equal(report.dependencies[10].headPinned,true);
  assert.equal(report.dependencies[9].ciPassed,true);
  assert.equal(report.dependencies[10].ciPassed,true);
  assert.equal(report.dependencies[9].parentCommitAncestor,true);
  assert.equal(report.dependencies[10].parentCommitAncestor,true);
  assert.equal(report.allMerged,false);
  assert.equal(report.customerGo,false);
  assert.equal(report.automaticMergeAllowed,false);
  assert.equal(report.changedMain,false);
});
test('R25 independently rejects R23/R24 changed SHA, wrong ancestry and missing named jobs',()=>{
  const input=fixture();
  input.source[57].pr.head.sha='0'.repeat(40);
  assert.ok(evaluateR25Chain(input).blockers.includes('pr_57_changed'));
  input.source[57]=fixture().source[57];
  input.source[58].checks.pop();
  assert.ok(evaluateR25Chain(input).blockers.includes('pr_58_ci_missing'));
  input.source[58].checks=fixture().source[58].checks;
  input.source[58].compare.status='diverged';
  assert.ok(evaluateR25Chain(input).blockers.includes('pr_58_parent_changed'));
});
