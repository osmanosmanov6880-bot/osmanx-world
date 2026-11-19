import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateR28Integration,R27_PR,
  R28_CHAIN_SCHEMA} from '../scripts/r28-release-plan.mjs';
function fixture(){
  return {
    previous:{mainComparison:{mainSha:'a'.repeat(40)}},
    r27:{number:R27_PR.number,
      head:{ref:R27_PR.head,sha:R27_PR.sha},
      base:{ref:R27_PR.base},state:'open',draft:true,merged:false},
    checks:R27_PR.requiredJobs.map(name=>({
      name,head_sha:R27_PR.sha,status:'completed',conclusion:'success'
    })),
    compare:{base:R27_PR.parent,head:R27_PR.sha,status:'ahead'},
    mainComparison:{mainSha:'a'.repeat(40),
      headSha:R27_PR.sha,status:'ahead'}
  };
}
test('R28 checks EXACT 14 stacked source PRs, does not merge any draft automatically',()=>{
  const r=evaluateR28Integration(fixture());
  assert.equal(r.schema,R28_CHAIN_SCHEMA);
  assert.equal(r.sourcePrCount,14);
  assert.deepEqual(r.manualSteps.map(x=>x.pr),
    [47,48,49,51,52,53,54,55,56,57,58,59,60,61]);
  assert.equal(r.dependencies.at(-1).sourceSha,R27_PR.sha);
  assert.equal(r.dependencies.at(-1).headPinned,true);
  assert.equal(r.dependencies.at(-1).ciPassed,true);
  assert.equal(r.dependencies.at(-1).parentCommitAncestor,true);
  assert.equal(r.allMerged,false);
  assert.equal(r.postMergeMainTested,false);
  assert.equal(r.verifiedActualVps,false);
  assert.equal(r.automaticMergeAllowed,false);
  assert.equal(r.productionAuthorized,false);
  assert.ok(r.manualSteps.every(x=>x.independentReviewRequired===true&&
    x.requireFreshMainCi===true&&x.automaticMergeAllowed===false));
});
test('R28 source mismatch, missing one exact named CI, wrong base or main drift block',()=>{
  const x=fixture();
  x.r27.head.sha='0'.repeat(40);
  assert.ok(evaluateR28Integration(x).blockers.includes(
    'R27_SOURCE_SHA_OR_BASE_CHANGED'));
  x.r27=fixture().r27;x.checks.pop();
  assert.ok(evaluateR28Integration(x).blockers.includes(
    'R27_REQUIRED_NAMED_CI_MISSING'));
  x.checks=fixture().checks;
  x.compare.status='diverged';
  assert.ok(evaluateR28Integration(x).blockers.includes(
    'R27_PARENT_ANCESTRY_CHANGED'));
  x.compare=fixture().compare;
  x.mainComparison.mainSha='f'.repeat(40);
  assert.ok(evaluateR28Integration(x).blockers.includes(
    'MAIN_TIP_CHANGED_OR_UNVERIFIED'));
  assert.ok(evaluateR28Integration(fixture()).blockers.includes(
    'R27_DRAFT_REQUIRES_REVIEW'));
});
