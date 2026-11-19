import test from 'node:test';
import assert from 'node:assert/strict';
import {RELEASE_CHAIN} from '../scripts/r20-release-chain.mjs';
import {R20_PR} from '../scripts/r21-release-chain.mjs';
import {R21_PR} from '../scripts/r22-release-chain.mjs';
import {R22_PR,MERGE_SCHEMA,evaluateR23MergePlan,
  fetchR23MergePlan} from '../scripts/r23-merge-plan.mjs';
const sha='a'.repeat(40);
function fixture(){
  const pulls={},checks={},ancestry={};
  for(let i=0;i<RELEASE_CHAIN.length;i++){
    const x=RELEASE_CHAIN[i],p=RELEASE_CHAIN[i-1];
    pulls[x.number]={number:x.number,head:{ref:x.head,sha:x.sha},
      base:{ref:x.base},state:'open',merged:false};
    checks[x.number]=x.checks.map(name=>({name,
      head_sha:x.sha,status:'completed',conclusion:'success'}));
    if(p)ancestry[p.number+'>'+x.number]={
      base:p.sha,head:x.sha,status:'ahead'
    };
  }
  const prior={
    prior:{
      prior:{pulls,checks,ancestry},
      r20:{number:R20_PR.number,head:{ref:R20_PR.head,sha:R20_PR.sha},
        base:{ref:R20_PR.base},state:'open',merged:false},
      checks:R20_PR.checks.map(name=>({
        name,head_sha:R20_PR.sha,status:'completed',conclusion:'success'
      })),
      compare:{base:RELEASE_CHAIN.at(-1).sha,head:R20_PR.sha,status:'ahead'}
    },
    r21:{number:R21_PR.number,head:{ref:R21_PR.head,sha:R21_PR.sha},
      base:{ref:R21_PR.base},state:'open',merged:false},
    checks:R21_PR.checks.map(name=>({
      name,head_sha:R21_PR.sha,status:'completed',conclusion:'success'
    })),
    compare:{base:R20_PR.sha,head:R21_PR.sha,status:'ahead'},
    branchPolicy:{mainSha:sha,protected:true,requiredReviews:true,
      allowForcePushes:false,allowDeletions:false,source:'github-read-only'}
  };
  const r22={number:R22_PR.number,head:{ref:R22_PR.head,sha:R22_PR.sha},
    base:{ref:R22_PR.base},state:'open',merged:false,
    draft:true,mergeable:true,mergeable_state:'clean'};
  return {prior,r22,
    checks:R22_PR.requiredJobs.map(name=>({
      name,head_sha:R22_PR.sha,status:'completed',conclusion:'success'
    })),
    compare:{base:R21_PR.sha,head:R22_PR.sha,status:'ahead'},
    mainComparison:{mainSha:sha,headSha:R22_PR.sha,status:'ahead'}};
}
test('R23 reviews nine immutable release PRs and never emits automatic merge commands',()=>{
  const r=evaluateR23MergePlan(fixture());
  assert.equal(r.schema,MERGE_SCHEMA);
  assert.deepEqual(r.orderedPlan.map(p=>p.pr),
    [47,48,49,51,52,53,54,55,56]);
  assert.equal(r.stagedCodeVerified,true);
  assert.equal(r.mainTipStable,true);
  assert.equal(r.allMerged,false);
  assert.equal(r.automaticMergeAllowed,false);
  assert.equal(r.changedMain,false);
  assert.equal(r.deployAllowed,false);
  assert.ok(r.blockers.includes('r22_not_merged'));
  assert.ok(r.blockers.includes('r22_draft_requires_independent_review'));
});
test('R23 detects drift, missing one job, divergence or forged base',()=>{
  const f=fixture();
  f.checks.pop();
  assert.ok(evaluateR23MergePlan(f).blockers.includes('r22_required_jobs_missing'));
  f.checks=fixture().checks;
  f.r22.head.sha='1'.repeat(40);
  assert.ok(evaluateR23MergePlan(f).blockers.includes('r22_pr_ref_changed'));
  f.r22=fixture().r22;
  f.mainComparison.mainSha='f'.repeat(40);
  assert.ok(evaluateR23MergePlan(f).blockers.includes('main_tip_or_ancestry_unknown'));
  f.mainComparison=fixture().mainComparison;
  f.compare.status='diverged';
  assert.ok(evaluateR23MergePlan(f).blockers.includes('r22_parent_commit_changed'));
});
test('R23 collector never performs a write, merge or deployment action',async()=>{
  const f=fixture(),urls=[];
  const fetcher=async(url,args)=>{
    urls.push(url);
    assert.equal(args.method,'GET');
    assert.equal(args.redirect,'error');
    const n=Number(url.match(/\/pulls\/(\d+)$/)?.[1]);
    if(n)return {ok:true,json:async()=>n===56?f.r22:n===55?f.prior.r21:
      n===54?f.prior.prior.r20:f.prior.prior.prior.pulls[n]};
    const head=url.match(/\/commits\/([a-f0-9]{40})\/check-runs/)?.[1];
    if(head){
      const jobs=head===R22_PR.sha?f.checks:
        head===R21_PR.sha?f.prior.checks:
        head===R20_PR.sha?f.prior.prior.checks:
        f.prior.prior.prior.checks[RELEASE_CHAIN.find(p=>p.sha===head).number];
      return {ok:true,json:async()=>({check_runs:jobs})};
    }
    if(url.includes('/compare/'))return {ok:true,json:async()=>({status:'ahead'})};
    if(url.endsWith('/branches/main'))
      return {ok:true,json:async()=>({commit:{sha},protected:true})};
    if(url.endsWith('/branches/main/protection'))
      return {ok:true,json:async()=>({
        required_pull_request_reviews:{required_approving_review_count:1},
        allow_force_pushes:{enabled:false},allow_deletions:{enabled:false}
      })};
    return {ok:false};
  };
  const snapshot=await fetchR23MergePlan({fetcher,token:'synthetic'});
  const report=evaluateR23MergePlan(snapshot);
  assert.equal(report.orderedPlan.length,9);
  assert.equal(report.stagedCodeVerified,true);
  assert.equal(report.automaticMergeAllowed,false);
  assert.ok(urls.every(u=>u.startsWith(
    'https://api.github.com/repos/osmanosmanov6880-bot/osmanx-world/')));
});
