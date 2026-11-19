import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateR29Review,R28_PR,R29_CHAIN_SCHEMA
} from '../scripts/r29-release-review.mjs';
import {
  runR29VirtualMerge,R29_MERGE_SCHEMA
} from '../scripts/r29-merge-tree.mjs';
const main='a'.repeat(40),head='b'.repeat(40),tree='c'.repeat(40);
function fixture(){
  return {
    previous:{mainComparison:{mainSha:main}},
    r28:{number:R28_PR.number,
      head:{ref:R28_PR.head,sha:R28_PR.sha},
      base:{ref:R28_PR.base},state:'open',draft:true,merged:false},
    checks:R28_PR.jobs.map(name=>({
      name,status:'completed',conclusion:'success',head_sha:R28_PR.sha
    })),
    compare:{base:R28_PR.parent,head:R28_PR.sha,status:'ahead'},
    mainComparison:{mainSha:main,headSha:R28_PR.sha,status:'ahead'}
  };
}
test('R29 enumerates 15 immutable source PRs and selects #47 for FIRST manual review',()=>{
  const r=evaluateR29Review(fixture());
  assert.equal(r.schema,R29_CHAIN_SCHEMA);
  assert.equal(r.sourcePrCount,15);
  assert.deepEqual(r.steps.map(x=>x.pr),
    [47,48,49,51,52,53,54,55,56,57,58,59,60,61,62]);
  assert.equal(r.firstHumanReview.pr,47);
  assert.equal(r.steps.at(-1).sourceSha,R28_PR.sha);
  assert.equal(r.steps.at(-1).pinned,true);
  assert.equal(r.steps.at(-1).namedCiPassed,true);
  assert.equal(r.steps.at(-1).parentCommitAncestor,true);
  assert.equal(r.allMerged,false);
  assert.equal(r.postMergeMainCiPassed,false);
  assert.equal(r.virtualMergeTested,false);
  assert.equal(r.automaticMergeAllowed,false);
  assert.equal(r.productionAuthorized,false);
  assert.ok(r.steps.every(x=>x.manualMergeOnly&&x.retestMergedMain));
});
test('R29 rejects wrong R28 base/SHA, missing job, wrong ancestry or drifted main',()=>{
  const f=fixture();
  f.r28.head.sha='0'.repeat(40);
  assert.ok(evaluateR29Review(f).blockers.includes('R28_HEAD_BASE_OR_SHA_CHANGED'));
  f.r28=fixture().r28;f.checks.pop();
  assert.ok(evaluateR29Review(f).blockers.includes('R28_REQUIRED_CI_MISSING'));
  f.checks=fixture().checks;f.compare.status='diverged';
  assert.ok(evaluateR29Review(f).blockers.includes('R28_PARENT_ANCESTRY_CHANGED'));
  f.compare=fixture().compare;f.mainComparison.mainSha='0'.repeat(40);
  assert.ok(evaluateR29Review(f).blockers.includes(
    'MAIN_TIP_CHANGED_OR_NOT_VERIFIED'));
});
function fakeGit({conflict=false,diverged=false}={}){
  const calls=[];
  const command=(bin,args)=>{
    calls.push([bin,...args]);
    const op=args.slice(2);
    if(op[0]==='status')return '';
    if(op[0]==='rev-parse'&&op[2]==='refs/remotes/origin/main')
      return main+'\n';
    if(op[0]==='rev-parse'&&op[2]===head+'^{commit}')
      return head+'\n';
    if(op[0]==='rev-parse'&&op[2]===head+'^{tree}')
      return tree+'\n';
    if(op[0]==='merge-base'&&op[1]==='--is-ancestor'){
      if(diverged)throw Object.assign(new Error('not ancestor'),{status:1});
      return '';
    }
    if(op[0]==='merge-base'&&op.length===3)return main+'\n';
    if(op[0]==='diff')return 'services/industry-api/src/guest.mjs\n';
    if(op[0]==='merge-tree'){
      if(conflict)throw Object.assign(new Error('merge conflict'),{status:1});
      return tree+'\n';
    }
    throw Error('Unexpected git command '+JSON.stringify(op));
  };
  return {command,calls};
}
test('R29 virtual merge uses only local git read commands plus ephemeral merge-tree, does NOT alter refs',()=>{
  const f=fakeGit();
  const r=runR29VirtualMerge({targetSha:head,repoRoot:'/tmp/r29-synthetic',
    command:f.command});
  assert.equal(r.schema,R29_MERGE_SCHEMA);
  assert.equal(r.mainSha,main);
  assert.equal(r.sourceSha,head);
  assert.equal(r.virtualTreeSha,tree);
  assert.equal(r.conflictsAbsent,true);
  assert.equal(r.virtualTreeMatchesSource,true);
  assert.equal(r.mainIsAncestor,true);
  assert.equal(r.realMergePerformed,false);
  assert.equal(r.mainRefUnchanged,true);
  assert.equal(r.trackedWorkspaceUnchanged,true);
  assert.equal(r.postMergeMainCiPassed,false);
  assert.equal(r.productionAuthorized,false);
  assert.ok(f.calls.some(x=>x.includes('merge-tree')));
  assert.ok(f.calls.every(x=>!x.includes('push')&&!x.includes('checkout')&&
    !x.includes('reset')&&!x.includes('update-ref')&&!x.includes('merge')));
});
test('R29 virtual merge conflicts and non-ancestor sources are NO-GO',()=>{
  const conflicts=runR29VirtualMerge({targetSha:head,repoRoot:'/tmp/r29',
    command:fakeGit({conflict:true}).command});
  assert.equal(conflicts.conflictsAbsent,false);
  assert.ok(conflicts.blockers.includes('VIRTUAL_GIT_MERGE_CONFLICT'));
  const drift=runR29VirtualMerge({targetSha:head,repoRoot:'/tmp/r29',
    command:fakeGit({diverged:true}).command});
  assert.equal(drift.mainIsAncestor,false);
  assert.ok(drift.blockers.includes('MAIN_IS_NOT_ANCESTOR_OF_SOURCE'));
  assert.throws(()=>runR29VirtualMerge({targetSha:'oops'}));
});
