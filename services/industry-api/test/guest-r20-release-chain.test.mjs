import test from 'node:test';
import assert from 'node:assert/strict';
import {RELEASE_CHAIN,evaluateR20Chain,fetchR20GitHub} from '../scripts/r20-release-chain.mjs';

function good(){
  const pulls={},checks={},ancestry={};
  for(let i=0;i<RELEASE_CHAIN.length;i++){
    const x=RELEASE_CHAIN[i],p=RELEASE_CHAIN[i-1];
    pulls[x.number]={number:x.number,head:{ref:x.head,sha:x.sha},
      base:{ref:x.base},merged:false,state:'open',merged_at:null};
    checks[x.number]=x.checks.map(name=>({name,status:'completed',
      conclusion:'success',head_sha:x.sha}));
    if(p)ancestry[p.number+'>'+x.number]={
      base:p.sha,head:x.sha,status:'ahead'
    };
  }
  return {pulls,checks,ancestry};
}
test('R20 audits all six exact stacked PRs and their actual named CI checks',()=>{
  assert.deepEqual(RELEASE_CHAIN.map(x=>x.number),[47,48,49,51,52,53]);
  const obj=good(),r=evaluateR20Chain(obj);
  assert.equal(r.stagedCodeVerified,true);
  assert.equal(r.allDependenciesMerged,false);
  assert.equal(r.dependencies.length,6);
  assert.equal(r.automatedCustomerGo,false);
  assert.equal(r.productionActivated,false);
  assert.equal(r.documentaryChecklistComplete,false);
  assert.ok(r.blockers.includes('unmerged_53'));
  assert.ok(r.blockers.includes('manual_independentCodeReview_missing'));
});
test('R20 rejects one missing job, one wrong SHA, a changed PR base and broken ancestry',()=>{
  const x=good();
  x.checks[53].find(j=>j.name==='r19-postgres').conclusion='failure';
  assert.equal(evaluateR20Chain(x).stagedCodeVerified,false);
  assert.ok(evaluateR20Chain(x).blockers.includes('required_checks_missing_53'));
  x.checks[53]=good().checks[53];
  x.checks[52][0].head_sha='f'.repeat(40);
  assert.equal(evaluateR20Chain(x).stagedCodeVerified,false);
  x.checks[52]=good().checks[52];
  x.pulls[48].base.ref='main';
  assert.ok(evaluateR20Chain(x).blockers.includes('pr_changed_48'));
  x.pulls[48]=good().pulls[48];
  x.ancestry['49>51'].status='behind';
  assert.ok(evaluateR20Chain(x).blockers.includes('stack_ancestry_invalid_51'));
});
test('R20 cannot turn a forged all-green release checklist into production authorization',()=>{
  const x=good();
  for(const p of Object.values(x.pulls)){
    p.merged=true;p.merged_at='2026-11-19T14:00:00.000Z';p.state='closed';
  }
  const approvals=Object.fromEntries([
    'independentCodeReview','legalBasisSignedOff','contractVerified',
    'offsiteWormReceiptVerified','twoKeyDrRestoreVerified',
    'rollbackExerciseWitnessed','operationalChangeWindowApproved'
  ].map(k=>[k,true]));
  const result=evaluateR20Chain({...x,approvals});
  assert.equal(result.stagedCodeVerified,true);
  assert.equal(result.allDependenciesMerged,true);
  assert.equal(result.documentaryChecklistComplete,true);
  assert.equal(result.blockers.length,0);
  assert.equal(result.automatedCustomerGo,false);
  assert.equal(result.productionActivated,false);
  assert.equal(result.changesMade,false);
});
test('R20 fetches only GET GitHub PR, check-runs and immutable ancestry',async()=>{
  const expected=good(),urls=[];
  const mock=async(url,args)=>{
    urls.push(url);
    assert.equal(args.method,'GET');
    assert.equal(args.redirect,'error');
    const pr=Number(url.match(/\/pulls\/(\d+)$/)?.[1]);
    if(pr)return {ok:true,json:async()=>expected.pulls[pr]};
    const sha=url.match(/\/commits\/([a-f0-9]{40})\/check-runs/)?.[1];
    if(sha)return {ok:true,json:async()=>({check_runs:
      expected.checks[RELEASE_CHAIN.find(x=>x.sha===sha).number]})};
    const ancestor=url.match(/\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})/) ;
    if(ancestor)return {ok:true,json:async()=>({status:'ahead'})};
    return {ok:false};
  };
  const data=await fetchR20GitHub({fetcher:mock,token:'synthetic-ci-token'});
  assert.equal(urls.length,RELEASE_CHAIN.length*2+RELEASE_CHAIN.length-1);
  assert.equal(evaluateR20Chain(data).stagedCodeVerified,true);
  assert.ok(urls.every(x=>x.startsWith(
    'https://api.github.com/repos/osmanosmanov6880-bot/osmanx-world/')));
});
