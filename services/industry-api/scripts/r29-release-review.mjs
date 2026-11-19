/**
 * R29: exact-SHA, READ-ONLY release integration and human review queue.
 * The 15 source PRs R14-R28 remain distinct Draft review units.
 * This action NEVER calls GitHub mutations, git merge/push or the VPS.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateR28Integration,fetchR28Integration,R27_PR}
  from './r28-release-plan.mjs';
export const R29_CHAIN_SCHEMA='osmanx.guest.r29.fifteen-source-review.v1';
export const R28_PR=Object.freeze({
  number:62,head:'feat/guest-r28-independent-release-review-20261119',
  base:'feat/guest-r27-first-client-rehearsal-20261119',
  sha:'f9f73acbef0ba63f7f2706f87a1b0ee8b4cfdc7d',
  parent:R27_PR.sha,
  jobs:['r28-offline','r28-postgres','r28-encrypted-dr',
    'r28-reproducible','r28-release-graph']
});
const SHA=/^[0-9a-f]{40}$/;
export function evaluateR29Review({previous={},r28=null,
  checks=[],compare=null,mainComparison=null}={}){
  const old=evaluateR28Integration(previous),spec=R28_PR;
  const headPinned=r28?.number===spec.number&&
    r28?.head?.ref===spec.head&&r28?.head?.sha===spec.sha&&
    r28?.base?.ref===spec.base;
  const ciPassed=spec.jobs.every(name=>Array.isArray(checks)&&
    checks.some(j=>j?.name===name&&j?.head_sha===spec.sha&&
      j?.status==='completed'&&j?.conclusion==='success'));
  const parentCommitAncestor=compare?.base===spec.parent&&
    compare?.head===spec.sha&&['ahead','identical'].includes(compare.status);
  const merged=r28?.merged===true&&r28?.state==='closed'&&
    typeof r28?.merged_at==='string'&&Number.isFinite(Date.parse(r28.merged_at));
  const mainSha=previous?.mainComparison?.mainSha;
  const mainTipPinned=SHA.test(mainSha||'')&&
    mainComparison?.mainSha===mainSha&&
    mainComparison?.headSha===spec.sha&&
    ['ahead','identical'].includes(mainComparison.status);
  const blockers=[...(old.blockers||[])];
  if(!headPinned)blockers.push('R28_HEAD_BASE_OR_SHA_CHANGED');
  if(!ciPassed)blockers.push('R28_REQUIRED_CI_MISSING');
  if(!parentCommitAncestor)blockers.push('R28_PARENT_ANCESTRY_CHANGED');
  if(!mainTipPinned)blockers.push('MAIN_TIP_CHANGED_OR_NOT_VERIFIED');
  if(r28?.draft===true&&!merged)blockers.push('R28_REQUIRES_INDEPENDENT_DRAFT_REVIEW');
  if(!merged)blockers.push('R28_NOT_MERGED');
  if(old.sourcePrCount!==14)blockers.push('INCOMPLETE_OLDER_CHAIN');
  const dependencies=[...(old.dependencies||[]),{
    pr:spec.number,sourceSha:spec.sha,headPinned,ciPassed,
    parentCommitAncestor,merged,draft:r28?.draft===true
  }];
  const steps=dependencies.map((item,i)=>({
    order:i+1,pr:item.pr,sourceSha:item.sourceSha,
    pinned:item.headPinned===true,
    namedCiPassed:item.ciPassed===true,
    parentCommitAncestor:item.parentCommitAncestor===true,
    merged:item.merged===true,
    reviewState:item.merged===true?'MERGED':
      item.headPinned&&item.ciPassed&&item.parentCommitAncestor?
        'HUMAN_REVIEW_PENDING':'SOURCE_RECHECK_REQUIRED',
    manualMergeOnly:true,retestMergedMain:true
  }));
  const firstPending=steps.find(s=>!s.merged)||null;
  const allSourceChecks=steps.length===15&&steps.every(s=>
    s.pinned&&s.namedCiPassed&&s.parentCommitAncestor);
  const verifiedSourceTree=old.verifiedStagedSource===true&&
    headPinned&&ciPassed&&parentCommitAncestor&&mainTipPinned;
  return {
    schema:R29_CHAIN_SCHEMA,mainSha:SHA.test(mainSha||'')?mainSha:null,
    sourceHeadSha:spec.sha,sourcePrCount:steps.length,
    steps,firstHumanReview: firstPending?{
      pr:firstPending.pr,sourceSha:firstPending.sourceSha,
      order:firstPending.order,state:firstPending.reviewState,
      task:'Independent code/security review, then manual merge using approved GitHub controls'
    }:null,
    verifiedSourceTree,allSourceChecks,mainTipPinned,
    allMerged:old.allMerged===true&&merged,
    countMerged:steps.filter(s=>s.merged).length,
    countNeedsHumanReview:steps.filter(s=>!s.merged).length,
    blockers:[...new Set(blockers)],
    postMergeMainCiPassed:false,
    virtualMergeTested:false,stagingHttpTested:false,
    realVpsInspected:false,realOffsiteRestoreWitnessed:false,
    independentLegalApproval:false,
    automaticMergeAllowed:false,deployAllowed:false,
    productionAuthorized:false,customerGo:false,
    changedMain:false,changedProduction:false
  };
}
export async function fetchR29Review({
  repository='osmanosmanov6880-bot/osmanx-world',
  fetcher=fetch,token=process.env.GITHUB_TOKEN
}={}){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new TypeError('Invalid repository path');
  const previous=await fetchR28Integration({repository,fetcher,token});
  const api='https://api.github.com/repos/'+repository;
  const get=async path=>{
    const res=await fetcher(api+path,{method:'GET',redirect:'error',
      headers:{Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(token?{Authorization:'Bearer '+token}:{})}});
    if(!res.ok)throw Error('Cannot verify source PR evidence');
    return res.json();
  };
  const spec=R28_PR,mainSha=previous?.mainComparison?.mainSha;
  const [r28,runs,cmp,main]=await Promise.all([
    get('/pulls/'+spec.number),
    get('/commits/'+spec.sha+'/check-runs?per_page=100'),
    get('/compare/'+spec.parent+'...'+spec.sha),
    SHA.test(mainSha||'')?get('/compare/'+mainSha+'...'+spec.sha):
      Promise.resolve({status:'unknown'})
  ]);
  return {previous,r28,checks:(runs.check_runs||[]).map(j=>({
    name:j.name,head_sha:j.head_sha,
    status:j.status,conclusion:j.conclusion
  })),compare:{base:spec.parent,head:spec.sha,status:cmp.status},
  mainComparison:{mainSha,headSha:spec.sha,status:main.status}};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Run read-only --github');
    process.stdout.write(JSON.stringify(
      evaluateR29Review(await fetchR29Review()))+'\n');
  }catch{
    process.stdout.write(JSON.stringify({
      schema:R29_CHAIN_SCHEMA,sourcePrCount:0,
      verifiedSourceTree:false,allMerged:false,
      blockers:['GITHUB_CHAIN_UNAVAILABLE'],
      automaticMergeAllowed:false,deployAllowed:false,
      customerGo:false,productionAuthorized:false,
      changedMain:false,changedProduction:false})+'\n');
    process.exitCode=2;
  }
}
