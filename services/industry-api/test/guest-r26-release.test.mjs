import test from 'node:test';
import assert from 'node:assert/strict';
import {R25_PR,R26_CHAIN_SCHEMA,evaluateR26Chain}
  from '../scripts/r26-release-chain.mjs';
function sample(){
  const source={},r25={
    number:R25_PR.number,head:{ref:R25_PR.head,sha:R25_PR.sha},
    base:{ref:R25_PR.base},state:'open',merged:false,draft:true
  };
  const checks=R25_PR.checks.map(name=>({
    name,status:'completed',conclusion:'success',head_sha:R25_PR.sha
  }));
  const comparison={base:R25_PR.parent,head:R25_PR.sha,status:'ahead'};
  return {previous:{},r25,checks,comparison,
    mainComparison:{mainSha:'a'.repeat(40),headSha:R25_PR.sha,status:'ahead'}};
}
test('R26 tracks 12 exact source PRs, no merge or customer production authorization',()=>{
  const report=evaluateR26Chain(sample());
  assert.equal(report.schema,R26_CHAIN_SCHEMA);
  assert.deepEqual(report.dependencies.map(x=>x.pr),
    [47,48,49,51,52,53,54,55,56,57,58,59]);
  assert.equal(report.dependencies[11].headPinned,true);
  assert.equal(report.dependencies[11].ciPassed,true);
  assert.equal(report.dependencies[11].parentCommitAncestor,true);
  assert.equal(report.allMerged,false);
  assert.equal(report.automaticMergeAllowed,false);
  assert.equal(report.productionAuthorized,false);
  assert.equal(report.changedMain,false);
});
test('R26 rejects tampered source SHA, missing required job and wrong ancestor',()=>{
  const x=sample();
  x.r25.head.sha='f'.repeat(40);
  assert.ok(evaluateR26Chain(x).blockers.includes('r25_pr_changed'));
  x.r25=sample().r25;
  x.checks.pop();
  assert.ok(evaluateR26Chain(x).blockers.includes('r25_named_ci_missing'));
  x.checks=sample().checks;
  x.comparison.status='diverged';
  assert.ok(evaluateR26Chain(x).blockers.includes('r25_parent_changed'));
});
