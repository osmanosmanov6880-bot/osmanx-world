import test from 'node:test';
import assert from 'node:assert/strict';
import {RELEASE_CHAIN} from '../scripts/r20-release-chain.mjs';
import {R20_PR,R21_CHAIN_SCHEMA,evaluateR21Chain,
  fetchR21Chain} from '../scripts/r21-release-chain.mjs';

function fixture(){
  const pulls={},checks={},ancestry={};
  for(let i=0;i<RELEASE_CHAIN.length;i++){
    const x=RELEASE_CHAIN[i],parent=RELEASE_CHAIN[i-1];
    pulls[x.number]={number:x.number,base:{ref:x.base},
      head:{ref:x.head,sha:x.sha},merged:false,state:'open'};
    checks[x.number]=x.checks.map(name=>({name,
      status:'completed',conclusion:'success',head_sha:x.sha}));
    if(parent)ancestry[parent.number+'>'+x.number]={
      base:parent.sha,head:x.sha,status:'ahead'};
  }
  const r20={number:R20_PR.number,base:{ref:R20_PR.base},
    head:{ref:R20_PR.head,sha:R20_PR.sha},merged:false,state:'open'};
  const jobs=R20_PR.checks.map(name=>({
    name,status:'completed',conclusion:'success',head_sha:R20_PR.sha}));
  return {prior:{pulls,checks,ancestry},r20,checks:jobs,
    compare:{base:RELEASE_CHAIN.at(-1).sha,head:R20_PR.sha,status:'ahead'}};
}
test('R21 verifies the seven actual stacked PRs and five precise R20 CI jobs',()=>{
  const f=fixture(),r=evaluateR21Chain(f);
  assert.equal(r.schema,R21_CHAIN_SCHEMA);
  assert.deepEqual(r.dependencies.map(x=>x.pr),[47,48,49,51,52,53,54]);
  assert.equal(r.stagedCodeVerified,true);
  assert.equal(r.allDependenciesMerged,false);
  assert.equal(r.automaticCustomerGo,false);
  assert.equal(r.automaticProductionApproval,false);
  assert.ok(r.blockers.includes('r20_not_merged'));
  assert.equal(r.dependencies.at(-1).requiredJobCount,5);
});
test('R21 rejects changed SHA, a single missing job, another base and broken ancestry',()=>{
  const f=fixture();
  f.r20.head.sha='0'.repeat(40);
  assert.ok(evaluateR21Chain(f).blockers.includes('r20_pr_changed'));
  f.r20.head.sha=R20_PR.sha;
  f.checks=f.checks.filter(j=>j.name!=='r20-postgres');
  assert.ok(evaluateR21Chain(f).blockers.includes('r20_named_ci_missing'));
  f.checks=fixture().checks;
  f.r20.base.ref='main';
  assert.ok(evaluateR21Chain(f).blockers.includes('r20_pr_changed'));
  f.r20.base.ref=R20_PR.base;
  f.compare.status='diverged';
  assert.ok(evaluateR21Chain(f).blockers.includes('r20_parent_ancestry_changed'));
});
test('R21 all manually declared approvals NEVER automatically deploy to production',()=>{
  const f=fixture();
  for(const p of Object.values(f.prior.pulls)){
    p.state='closed';p.merged=true;p.merged_at='2026-11-19T14:00:00.000Z';
  }
  f.prior.approvals=Object.fromEntries([
    'independentCodeReview','legalBasisSignedOff','contractVerified',
    'offsiteWormReceiptVerified','twoKeyDrRestoreVerified',
    'rollbackExerciseWitnessed','operationalChangeWindowApproved'
  ].map(k=>[k,true]));
  f.r20.state='closed';f.r20.merged=true;
  f.r20.merged_at='2026-11-19T14:00:00.000Z';
  const r=evaluateR21Chain(f);
  assert.equal(r.allDependenciesMerged,true);
  assert.equal(r.blockers.length,0);
  assert.equal(r.automaticCustomerGo,false);
  assert.equal(r.automaticProductionApproval,false);
  assert.equal(r.changedProduction,false);
});
test('R21 GitHub collector only performs GETs for exact pinned metadata',async()=>{
  const f=fixture(),urls=[];
  const fetcher=async(url,args)=>{
    urls.push(url);
    assert.equal(args.method,'GET');assert.equal(args.redirect,'error');
    const n=Number(url.match(/\/pulls\/(\d+)$/)?.[1]);
    if(n)return {ok:true,json:async()=>n===54?f.r20:f.prior.pulls[n]};
    const sha=url.match(/\/commits\/([0-9a-f]{40})\/check-runs/)?.[1];
    if(sha){
      const jobs=sha===R20_PR.sha?f.checks:
        f.prior.checks[RELEASE_CHAIN.find(x=>x.sha===sha).number];
      return {ok:true,json:async()=>({check_runs:jobs})};
    }
    if(url.includes('/compare/'))return {ok:true,json:async()=>({status:'ahead'})};
    return {ok:false};
  };
  const data=await fetchR21Chain({fetcher,token:'synthetic'});
  assert.equal(evaluateR21Chain(data).stagedCodeVerified,true);
  assert.equal(urls.length,20);
  assert.ok(urls.every(x=>x.startsWith(
    'https://api.github.com/repos/osmanosmanov6880-bot/osmanx-world/')));
});
