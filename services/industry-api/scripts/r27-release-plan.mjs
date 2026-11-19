/**
 * R27 read-only, exact-SHA human merge/runbook planner for all R14–R26 PRs.
 * Never calls GitHub write endpoints, git merge, push, workflow_dispatch,
 * VPS, database or any deploy action.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateR26Chain,fetchR26Chain,R25_PR}
  from './r26-release-chain.mjs';
export const R27_CHAIN_SCHEMA='osmanx.guest.r27.thirteen-pr-human-merge-plan.v1';
export const R26_PR=Object.freeze({
  number:60,head:'feat/guest-r26-source-reliability-20261119',
  base:'feat/guest-r25-operational-barriers-20261119',
  sha:'d87bb630f8de3c7ef2d71ffe1804cc2fdecf2b76',
  parent:R25_PR.sha,
  checks:['r26-offline','r26-postgres','r26-encrypted-dr',
    'r26-reproducible','r26-release-graph']
});
const sha=/^[a-f0-9]{40}$/;
export function evaluateR27Chain({
  previous={},r26=null,checks=[],compare=null,mainComparison=null
}={}){
  const prior=evaluateR26Chain(previous),p=R26_PR;
  const headPinned=r26?.number===p.number&&r26?.head?.ref===p.head&&
    r26?.head?.sha===p.sha&&r26?.base?.ref===p.base;
  const namedCI=p.checks.every(name=>Array.isArray(checks)&&
    checks.some(c=>c.name===name&&c.head_sha===p.sha&&
      c.status==='completed'&&c.conclusion==='success'));
  const ancestry=compare?.base===p.parent&&compare?.head===p.sha&&
    ['ahead','identical'].includes(compare?.status);
  const merged=r26?.merged===true&&r26?.state==='closed'&&
    typeof r26?.merged_at==='string'&&Number.isFinite(Date.parse(r26.merged_at));
  const mainSha=previous?.mainComparison?.mainSha;
  const stable=sha.test(mainSha||'')&&
    mainComparison?.mainSha===mainSha&&
    mainComparison?.headSha===p.sha&&
    ['ahead','identical'].includes(mainComparison?.status);
  const blockers=[...prior.blockers];
  if(!headPinned)blockers.push('R26_HEAD_SHA_OR_BASE_CHANGED');
  if(!namedCI)blockers.push('R26_REQUIRED_NAMED_CI_MISSING');
  if(!ancestry)blockers.push('R26_PARENT_ANCESTRY_CHANGED');
  if(!merged)blockers.push('R26_NOT_MERGED');
  if(!stable)blockers.push('MAIN_TIP_NOT_PINNED_FOR_R27');
  if(r26?.draft===true&&!merged)blockers.push('R26_DRAFT_REQUIRES_REVIEW');
  const dependencies=[...prior.dependencies,{
    pr:p.number,sourceSha:p.sha,headPinned,
    ciPassed:namedCI,parentCommitAncestor:ancestry,merged
  }];
  const manualPlan=dependencies.map((item,i)=>({
    order:i+1,pr:item.pr,sourceSha:item.sourceSha,
    requiresIndependentHumanReview:true,
    requiresFreshPostMergeCi:true,
    status:item.merged?'MERGED':'MANUAL_REVIEW_AND_MERGE_PENDING',
    automaticMergeAllowed:false
  }));
  return {schema:R27_CHAIN_SCHEMA,
    pinnedSourceCount:dependencies.length,dependencies,manualPlan,
    stagedSourceVerified:prior.stagedCodeVerified&&headPinned&&namedCI&&ancestry,
    mainProtected:prior.mainProtected,mainTipStable:stable,
    allMerged:prior.allMerged&&merged,blockers:[...new Set(blockers)],
    sourceHeadSha:p.sha,
    finalMainPostMergeCiNotChecked:true,
    realVpsEvidenceNotChecked:true,
    signedCustomerAgreementNotChecked:true,
    humanReviewOutstanding:true,
    automaticMergeAllowed:false,deployAllowed:false,
    customerGo:false,productionAuthorized:false,
    changedMain:false,changedProduction:false
  };
}
export async function fetchR27Chain({
  repository='osmanosmanov6880-bot/osmanx-world',
  fetcher=fetch,token=process.env.GITHUB_TOKEN
}={}){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Repository format invalid');
  const previous=await fetchR26Chain({repository,fetcher,token});
  const root='https://api.github.com/repos/'+repository;
  const get=async path=>{
    const res=await fetcher(root+path,{method:'GET',redirect:'error',
      headers:{Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(token?{Authorization:'Bearer '+token}:{})}});
    if(!res.ok)throw new Error('Cannot inspect pinned GitHub metadata');
    return res.json();
  };
  const [r26,runs,compare]=await Promise.all([
    get('/pulls/'+R26_PR.number),
    get('/commits/'+R26_PR.sha+'/check-runs?per_page=100'),
    get('/compare/'+R26_PR.parent+'...'+R26_PR.sha)
  ]);
  const mainSha=previous?.mainComparison?.mainSha;
  const main=sha.test(mainSha||'')?
    await get('/compare/'+mainSha+'...'+R26_PR.sha):
    {status:'unknown'};
  return {previous,r26,checks:(runs.check_runs||[]).map(c=>({
    name:c.name,status:c.status,conclusion:c.conclusion,head_sha:c.head_sha
  })),compare:{base:R26_PR.parent,head:R26_PR.sha,status:compare.status},
  mainComparison:{mainSha,headSha:R26_PR.sha,status:main.status}};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw new TypeError('Use --github');
    process.stdout.write(JSON.stringify(evaluateR27Chain(await fetchR27Chain()))+'\n');
  }catch{
    process.stdout.write(JSON.stringify({
      schema:R27_CHAIN_SCHEMA,stagedSourceVerified:false,
      allMerged:false,blockers:['R27_RELEASE_CHAIN_UNAVAILABLE'],
      automaticMergeAllowed:false,deployAllowed:false,
      customerGo:false,productionAuthorized:false,
      changedMain:false,changedProduction:false})+'\n');
    process.exitCode=2;
  }
}
