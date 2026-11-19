import test from 'node:test';
import assert from 'node:assert/strict';
import {RELEASE_CHAIN} from '../scripts/r20-release-chain.mjs';
import {R20_PR} from '../scripts/r21-release-chain.mjs';
import {R21_PR,evaluateR22Chain,fetchR22Chain,assessBranchPolicy,
  CHAIN_SCHEMA} from '../scripts/r22-release-chain.mjs';

const policy={mainSha:'a'.repeat(40),protected:true,
  requiredReviews:true,allowForcePushes:false,allowDeletions:false,
  source:'github-read-only'};
function fixture(){
  const pulls={},checks={},ancestry={};
  for(let i=0;i<RELEASE_CHAIN.length;i++){
    const x=RELEASE_CHAIN[i],parent=RELEASE_CHAIN[i-1];
    pulls[x.number]={number:x.number,base:{ref:x.base},
      head:{ref:x.head,sha:x.sha},state:'open',merged:false};
    checks[x.number]=x.checks.map(name=>({name,status:'completed',
      conclusion:'success',head_sha:x.sha}));
    if(parent)ancestry[parent.number+'>'+x.number]={
      base:parent.sha,head:x.sha,status:'ahead'};
  }
  const r20={number:R20_PR.number,base:{ref:R20_PR.base},
    head:{ref:R20_PR.head,sha:R20_PR.sha},state:'open',merged:false};
  const r21={number:R21_PR.number,base:{ref:R21_PR.base},
    head:{ref:R21_PR.head,sha:R21_PR.sha},state:'open',merged:false};
  const input={
    prior:{prior:{pulls,checks,ancestry},r20,
      checks:R20_PR.checks.map(name=>({
        name,status:'completed',conclusion:'success',head_sha:R20_PR.sha
      })),
      compare:{base:RELEASE_CHAIN.at(-1).sha,head:R20_PR.sha,status:'ahead'}},
    r21,
    checks:R21_PR.checks.map(name=>({
      name,status:'completed',conclusion:'success',head_sha:R21_PR.sha
    })),
    compare:{base:R20_PR.sha,head:R21_PR.sha,status:'ahead'},
    branchPolicy:{...policy}
  };
  return input;
}
test('R22 pins eight source PRs, actual named R21 checks and main protection',()=>{
  const r=evaluateR22Chain(fixture());
  assert.equal(r.schema,CHAIN_SCHEMA);
  assert.deepEqual(r.dependencies.map(p=>p.pr),[47,48,49,51,52,53,54,55]);
  assert.equal(r.stagedCodeVerified,true);
  assert.equal(r.branchProtectionVerified,true);
  assert.equal(r.allDependenciesMerged,false);
  assert.equal(r.productionAuthorized,false);
  assert.equal(r.automaticCustomerGo,false);
  assert.ok(r.blockers.includes('r21_not_merged'));
});
test('R22 detects one missing check, changed PR SHA, broken ancestry and unknown protection',()=>{
  const r=fixture();
  r.checks.pop();
  assert.ok(evaluateR22Chain(r).blockers.includes('r21_named_checks_missing'));
  r.checks=fixture().checks;
  r.r21.head.sha='b'.repeat(40);
  assert.ok(evaluateR22Chain(r).blockers.includes('r21_pr_changed'));
  r.r21=fixture().r21;
  r.compare.status='diverged';
  assert.ok(evaluateR22Chain(r).blockers.includes('r21_ancestry_changed'));
  r.compare=fixture().compare;
  r.branchPolicy={mainSha:'0'.repeat(40),protected:false,
    requiredReviews:false,allowForcePushes:true,allowDeletions:true};
  assert.equal(evaluateR22Chain(r).branchProtectionVerified,false);
  assert.ok(evaluateR22Chain(r).blockers.some(b=>b==='main_policy_protected'));
});
test('R22 all-merged, protected and fully green still does not authorize production',()=>{
  const r=fixture();
  for(const p of Object.values(r.prior.prior.pulls)){
    p.state='closed';p.merged=true;p.merged_at='2026-11-19T17:00:00.000Z';
  }
  for(const p of [r.prior.r20,r.r21]){
    p.state='closed';p.merged=true;p.merged_at='2026-11-19T17:00:00.000Z';
  }
  r.prior.prior.approvals=Object.fromEntries([
    'independentCodeReview','legalBasisSignedOff','contractVerified',
    'offsiteWormReceiptVerified','twoKeyDrRestoreVerified',
    'rollbackExerciseWitnessed','operationalChangeWindowApproved'
  ].map(x=>[x,true]));
  const report=evaluateR22Chain(r);
  assert.equal(report.blockers.length,0);
  assert.equal(report.allDependenciesMerged,true);
  assert.equal(report.productionActivated,false);
  assert.equal(report.productionAuthorized,false);
  assert.equal(report.changedProduction,false);
});
test('R22 GET collector handles hidden branch protection as explicitly unverified',async()=>{
  const f=fixture(),urls=[];
  const fetcher=async(url,args)=>{
    urls.push({url,args});
    assert.equal(args.method,'GET');assert.equal(args.redirect,'error');
    const n=Number(url.match(/\/pulls\/(\d+)$/)?.[1]);
    if(n){
      const p=n===55?f.r21:n===54?f.prior.r20:f.prior.prior.pulls[n];
      return {ok:true,json:async()=>p};
    }
    const sha=url.match(/\/commits\/([0-9a-f]{40})\/check-runs/)?.[1];
    if(sha){
      const j=sha===R21_PR.sha?f.checks:sha===R20_PR.sha?f.prior.checks:
        f.prior.prior.checks[RELEASE_CHAIN.find(x=>x.sha===sha).number];
      return {ok:true,json:async()=>({check_runs:j})};
    }
    if(url.includes('/compare/'))
      return {ok:true,json:async()=>({status:'ahead'})};
    if(url.endsWith('/branches/main'))
      return {ok:true,json:async()=>({commit:{sha:'a'.repeat(40)},protected:true})};
    if(url.endsWith('/branches/main/protection'))
      return {ok:false,status:403};
    return {ok:false};
  };
  const snapshot=await fetchR22Chain({fetcher,token:'synthetic'});
  const result=evaluateR22Chain(snapshot);
  assert.equal(urls.length,25);
  assert.equal(result.dependencies.length,8);
  assert.equal(result.stagedCodeVerified,true);
  assert.equal(result.branchProtectionVerified,false);
  assert.ok(result.blockers.includes('main_policy_requiredReviews'));
  assert.equal(result.productionAuthorized,false);
});
