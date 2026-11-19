/**
 * R23: non-activating, exact-SHA release integration plan.
 * Reviews R14..R22 as a STACK; never runs merge, update-ref, rebase,
 * Actions dispatch, workflow approval, deployment or any HTTP mutation.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateR22Chain,fetchR22Chain,R21_PR} from './r22-release-chain.mjs';
import {RELEASE_CHAIN} from './r20-release-chain.mjs';
import {R20_PR} from './r21-release-chain.mjs';
export const R22_PR=Object.freeze({
  number:56,head:'feat/guest-r22-independent-readiness-20261119',
  base:'feat/guest-r21-production-readiness-evidence-20261119',
  sha:'0bf8212fefc7a8fda969a34230866dd1cbee133c',
  requiredJobs:['r22-offline','r22-postgres','r22-encrypted-dr',
    'r22-reproducible','r22-release-graph']
});
export const MERGE_SCHEMA='osmanx.guest.r23.manual-merge-plan.v1';
const sha=/^[0-9a-f]{40}$/;
function checkSuccess(jobs,name,commit){
  return Array.isArray(jobs)&&jobs.some(j=>j?.name===name&&
    j?.status==='completed'&&j?.conclusion==='success'&&j?.head_sha===commit);
}
export function evaluateR23MergePlan({
  prior={},r22=null,checks=[],compare=null,mainComparison=null
}={}){
  const earlier=evaluateR22Chain(prior),x=R22_PR;
  const identity=r22?.number===x.number&&r22?.head?.ref===x.head&&
    r22?.head?.sha===x.sha&&r22?.base?.ref===x.base;
  const ci=x.requiredJobs.every(name=>checkSuccess(checks,name,x.sha));
  const ancestry=compare?.base===R21_PR.sha&&compare?.head===x.sha&&
    ['ahead','identical'].includes(compare?.status);
  const merged=r22?.merged===true&&r22?.state==='closed'&&
    typeof r22?.merged_at==='string'&&Number.isFinite(Date.parse(r22.merged_at));
  const mergeable=r22?.mergeable===true&&
    ['clean','unstable'].includes(r22?.mergeable_state);
  const mainSha=earlier.branch?.mainSha||null;
  // Detect a new main commit since the policy review, not just branch names.
  const mainPinned=sha.test(mainSha||'')&&
    mainComparison?.mainSha===mainSha&&
    mainComparison?.headSha===x.sha&&
    ['ahead','identical'].includes(mainComparison?.status);
  const blockers=[...earlier.blockers];
  if(!identity)blockers.push('r22_pr_ref_changed');
  if(!ci)blockers.push('r22_required_jobs_missing');
  if(!ancestry)blockers.push('r22_parent_commit_changed');
  if(!mergeable&&!merged)blockers.push('r22_mergeability_not_confirmed');
  if(!mainPinned)blockers.push('main_tip_or_ancestry_unknown');
  if(r22?.draft===true&&!merged)blockers.push('r22_draft_requires_independent_review');
  if(!merged)blockers.push('r22_not_merged');
  const dependencies=[...earlier.dependencies,{
    pr:x.number,headPinned:identity,ciPassed:ci,
    parentCommitAncestor:ancestry,merged,requiredJobCount:x.requiredJobs.length
  }];
  const exactSources=[...RELEASE_CHAIN.map(p=>p.sha),
    R20_PR.sha,R21_PR.sha,R22_PR.sha];
  const sequence=dependencies.map((dep,index)=>({
    order:index+1,pr:dep.pr,sourceSha:exactSources[index],
    checksPassed:dep.ciPassed,headPinned:dep.headPinned,
    parentCommitAncestor:dep.parentCommitAncestor,alreadyMerged:dep.merged,
    action:'human_review_then_sequential_merge_only',
    requiresFreshMainCi:true
  }));
  return {schema:MERGE_SCHEMA,mainSha:sha.test(mainSha||'')?mainSha:null,
    sourceHeadSha:x.sha,orderedPlan:sequence,
    stagedCodeVerified:earlier.stagedCodeVerified&&identity&&ci&&ancestry,
    mainTipStable:mainPinned,mainProtected:earlier.branchProtectionVerified,
    allMerged:earlier.allDependenciesMerged&&merged,
    mergeabilityDocumented:mergeable,
    blockers:[...new Set(blockers)],
    mergeCommandIncluded:false,automaticMergeAllowed:false,
    deployAllowed:false,customerGo:false,changedMain:false,
    changedProduction:false,legalApprovalGranted:false};
}
export async function fetchR23MergePlan({repository='osmanosmanov6880-bot/osmanx-world',
  fetcher=fetch,token=process.env.GITHUB_TOKEN}={}){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository))throw Error('Invalid repository');
  const prior=await fetchR22Chain({repository,fetcher,token});
  const api='https://api.github.com/repos/'+repository;
  const get=async path=>{
    const response=await fetcher(api+path,{method:'GET',redirect:'error',
      headers:{Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(token?{Authorization:'Bearer '+token}:{})}});
    if(!response.ok)throw Error('R23 GitHub metadata unavailable');
    return response.json();
  };
  const mainSha=prior?.branchPolicy?.mainSha;
  const [r22,run,anc,mainCompare]=await Promise.all([
    get('/pulls/'+R22_PR.number),
    get('/commits/'+R22_PR.sha+'/check-runs?per_page=100'),
    get('/compare/'+R21_PR.sha+'...'+R22_PR.sha),
    sha.test(mainSha||'')?get('/compare/'+mainSha+'...'+R22_PR.sha):
      Promise.resolve({status:'unknown'})
  ]);
  return {prior,r22,
    checks:(run.check_runs||[]).map(j=>({
      name:j.name,status:j.status,conclusion:j.conclusion,head_sha:j.head_sha
    })),
    compare:{base:R21_PR.sha,head:R22_PR.sha,status:anc.status},
    mainComparison:{mainSha,headSha:R22_PR.sha,status:mainCompare.status}};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Use --github');
    const report=evaluateR23MergePlan(await fetchR23MergePlan());
    process.stdout.write(JSON.stringify(report)+'\n');
  }catch{
    process.stdout.write(JSON.stringify({schema:MERGE_SCHEMA,
      stagedCodeVerified:false,automaticMergeAllowed:false,
      deployAllowed:false,customerGo:false,changedMain:false,
      changedProduction:false,blockers:['github_stack_not_verifiable']})+'\n');
    process.exitCode=2;
  }
}
