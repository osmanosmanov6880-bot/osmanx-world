/**
 * R22 eight-stage R14-R21 release genealogy, PR #55 pinned to five exact
 * completed checks and immutable R20->R21 commit ancestry.
 *
 * Main branch policy is inspected but no automated release action exists.
 * A GitHub 403/404 or missing policy produces a release BLOCKER, never a
 * silent fallback to draft CI checks. No secrets/CI token are returned.
 */
import {evaluateR21Chain,fetchR21Chain,R20_PR} from './r21-release-chain.mjs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const R21_PR=Object.freeze({
  number:55,
  head:'feat/guest-r21-production-readiness-evidence-20261119',
  base:'feat/guest-r20-release-control-dr-20261119',
  sha:'de63f85daa27fb8dc362c9cd02d1272c192db5ee',
  checks:['r21-offline','r21-postgres','r21-encrypted-dr',
    'r21-reproducible','r21-release-graph']
});
export const CHAIN_SCHEMA='osmanx.guest.r22.eight-stage-release.v1';
const checkName=(obj,name,sha)=>obj?.name===name&&
  obj?.status==='completed'&&obj?.conclusion==='success'&&
  obj?.head_sha===sha;
export function assessBranchPolicy(snapshot){
  const checks={
    mainResolved:/^[0-9a-f]{40}$/.test(snapshot?.mainSha||''),
    protected:snapshot?.protected===true,
    requiredReviews:snapshot?.requiredReviews===true,
    forcePushDisabled:snapshot?.allowForcePushes===false,
    deletionsDisabled:snapshot?.allowDeletions===false,
    resolvedFromGitHub:snapshot?.source==='github-read-only'
  };
  const blockers=Object.entries(checks).filter(([,v])=>v!==true)
    .map(([name])=>'main_policy_'+name);
  return {checks,blockers,verified:blockers.length===0,
    mainSha:checks.mainResolved?snapshot.mainSha:null,
    policyChanged:false,productionAuthorized:false};
}
export function evaluateR22Chain({prior={},r21=null,checks=[],
  compare=null,branchPolicy=null}={}){
  const base=evaluateR21Chain(prior);
  const blockers=[...base.blockers];
  const x=R21_PR;
  const refsValid=r21?.number===x.number&&r21?.head?.ref===x.head&&
    r21?.head?.sha===x.sha&&r21?.base?.ref===x.base;
  const jobsValid=Array.isArray(checks)&&x.checks.every(name=>
    checks.some(job=>checkName(job,name,x.sha)));
  const ancestorValid=compare?.base===R20_PR.sha&&
    compare?.head===x.sha&&['ahead','identical'].includes(compare?.status);
  const merged=r21?.merged===true&&r21?.state==='closed'&&
    typeof r21?.merged_at==='string'&&Number.isFinite(Date.parse(r21.merged_at));
  if(!refsValid)blockers.push('r21_pr_changed');
  if(!jobsValid)blockers.push('r21_named_checks_missing');
  if(!ancestorValid)blockers.push('r21_ancestry_changed');
  if(!merged)blockers.push('r21_not_merged');
  const branch=assessBranchPolicy(branchPolicy);
  blockers.push(...branch.blockers);
  const dependencies=[...base.dependencies,{
    pr:x.number,headPinned:refsValid,ciPassed:jobsValid,
    parentCommitAncestor:ancestorValid,merged,requiredJobCount:x.checks.length
  }];
  return {
    schema:CHAIN_SCHEMA,dependencies,branch,
    stagedCodeVerified:base.stagedCodeVerified&&refsValid&&jobsValid&&ancestorValid,
    allDependenciesMerged:base.allDependenciesMerged&&merged,
    branchProtectionVerified:branch.verified,
    manualChecklistComplete:base.manualChecklistComplete,
    blockers:[...new Set(blockers)],
    automaticCustomerGo:false,productionAuthorized:false,
    productionActivated:false,changedProduction:false,
    manualReviewStillRequired:true
  };
}
export async function fetchR22Chain({repository='osmanosmanov6880-bot/osmanx-world',
  fetcher=fetch,token=process.env.GITHUB_TOKEN}={}){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository))throw Error('Invalid repository');
  const prior=await fetchR21Chain({repository,fetcher,token});
  const base='https://api.github.com/repos/'+repository;
  async function get(path,{optional=false}={}){
    try{
      const res=await fetcher(base+path,{method:'GET',redirect:'error',
        headers:{Accept:'application/vnd.github+json',
          'X-GitHub-Api-Version':'2022-11-28',
          ...(token?{Authorization:'Bearer '+token}:{})}});
      if(!res.ok)throw Error('Read-only GitHub resource not available');
      return await res.json();
    }catch(e){if(optional)return null;throw e;}
  }
  const [r21,jobResponse,ancestry,main,protection]=await Promise.all([
    get('/pulls/'+R21_PR.number),
    get('/commits/'+R21_PR.sha+'/check-runs?per_page=100'),
    get('/compare/'+R20_PR.sha+'...'+R21_PR.sha),
    get('/branches/main'),
    get('/branches/main/protection',{optional:true})
  ]);
  return {
    prior,r21,
    checks:(jobResponse.check_runs||[]).map(j=>({
      name:j.name,status:j.status,conclusion:j.conclusion,
      head_sha:j.head_sha
    })),
    compare:{base:R20_PR.sha,head:R21_PR.sha,status:ancestry.status},
    branchPolicy:{
      mainSha:main?.commit?.sha||null,
      protected:main?.protected===true,
      requiredReviews:!!protection?.required_pull_request_reviews&&
        Number(protection.required_pull_request_reviews.required_approving_review_count)>=1,
      allowForcePushes:protection?.allow_force_pushes?.enabled??null,
      allowDeletions:protection?.allow_deletions?.enabled??null,
      source:'github-read-only'
    }
  };
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('R22 only accepts --github');
    const report=evaluateR22Chain(await fetchR22Chain());
    process.stdout.write(JSON.stringify(report)+'\n');
  }catch{
    process.stdout.write(JSON.stringify({
      schema:CHAIN_SCHEMA,stagedCodeVerified:false,
      allDependenciesMerged:false,branchProtectionVerified:false,
      automaticCustomerGo:false,productionAuthorized:false,
      productionActivated:false,changedProduction:false,
      blockers:['github_chain_or_policy_unavailable']})+'\n');
    process.exitCode=2;
  }
}
