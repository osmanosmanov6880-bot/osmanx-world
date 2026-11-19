/**
 * R28 manual 14-PR integration review, READ ONLY.
 * Never calls GitHub write/merge/dispatch endpoints or a real host.
 * Source CI does NOT equal post-merge CI or legal production approval.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateR27Chain,fetchR27Chain,R26_PR} from './r27-release-plan.mjs';
export const R28_CHAIN_SCHEMA='osmanx.guest.r28.fourteen-source-integration.v1';
export const R27_PR=Object.freeze({
  number:61,
  head:'feat/guest-r27-first-client-rehearsal-20261119',
  base:'feat/guest-r26-source-reliability-20261119',
  sha:'b9cec9ac37fc3dd655fcb19ba3abbe33a5827d54',
  parent:R26_PR.sha,
  requiredJobs:['r27-offline','r27-postgres','r27-encrypted-dr',
    'r27-reproducible','r27-release-graph']
});
const SHA=/^[a-f0-9]{40}$/;
const jobOK=(jobs,name,sha)=>Array.isArray(jobs)&&jobs.some(j=>
  j?.name===name&&j?.head_sha===sha&&j?.status==='completed'&&
  j?.conclusion==='success');
export function evaluateR28Integration({previous={},r27=null,checks=[],
  compare=null,mainComparison=null}={}){
  const earlier=evaluateR27Chain(previous),spec=R27_PR;
  const headPinned=r27?.number===spec.number&&
    r27?.head?.ref===spec.head&&r27?.head?.sha===spec.sha&&
    r27?.base?.ref===spec.base;
  const ciPassed=spec.requiredJobs.every(name=>jobOK(checks,name,spec.sha));
  const ancestor=compare?.base===spec.parent&&compare?.head===spec.sha&&
    ['ahead','identical'].includes(compare.status);
  const merged=r27?.merged===true&&r27?.state==='closed'&&
    typeof r27?.merged_at==='string'&&Number.isFinite(Date.parse(r27.merged_at));
  const mainSha=previous?.mainComparison?.mainSha;
  const mainTipPinned=SHA.test(mainSha||'')&&
    mainComparison?.mainSha===mainSha&&
    mainComparison?.headSha===spec.sha&&
    ['ahead','identical'].includes(mainComparison.status);
  const blockers=[...earlier.blockers];
  if(!headPinned)blockers.push('R27_SOURCE_SHA_OR_BASE_CHANGED');
  if(!ciPassed)blockers.push('R27_REQUIRED_NAMED_CI_MISSING');
  if(!ancestor)blockers.push('R27_PARENT_ANCESTRY_CHANGED');
  if(!mainTipPinned)blockers.push('MAIN_TIP_CHANGED_OR_UNVERIFIED');
  if(r27?.draft===true&&!merged)blockers.push('R27_DRAFT_REQUIRES_REVIEW');
  if(!merged)blockers.push('R27_NOT_MERGED');
  // Explicitly enforce existence of all dependency PRs, no optimistic GO.
  const previousCount=earlier.dependencies?.length||0;
  if(previousCount!==13)blockers.push('PR_CHAIN_INCOMPLETE');
  const dependencies=[...(earlier.dependencies||[]),{
    pr:spec.number,sourceSha:spec.sha,headPinned,ciPassed,
    parentCommitAncestor:ancestor,merged
  }];
  const manualSteps=dependencies.map((x,i)=>({
    order:i+1,pr:x.pr,sourceSha:x.sourceSha,
    currentState:x.merged?'MERGED':'MANUAL_REVIEW_REQUIRED',
    independentReviewRequired:true,requireFreshMainCi:true,
    requireExactSourceAudit:true,automaticMergeAllowed:false
  }));
  const verifiedStagedSource=earlier.stagedSourceVerified&&
    headPinned&&ciPassed&&ancestor&&mainTipPinned;
  return {
    schema:R28_CHAIN_SCHEMA,mainSha:SHA.test(mainSha||'')?mainSha:null,
    sourceHeadSha:spec.sha,sourcePrCount:dependencies.length,
    dependencies,manualSteps,
    verifiedStagedSource,mainTipPinned,
    allMerged:earlier.allMerged&&merged,
    allSourceJobsPassed:earlier.stagedSourceVerified&&ciPassed,
    postMergeMainTested:false,verifiedActualVps:false,
    codeReviewApproved:false,legalClientConsentConfirmed:false,
    rollbackWindowApproved:false,
    blockers:[...new Set(blockers)],
    automaticMergeAllowed:false,deployAllowed:false,
    commercialPilotAllowed:false,productionAuthorized:false,
    changedMain:false,changedProduction:false
  };
}
export async function fetchR28Integration({
  repository='osmanosmanov6880-bot/osmanx-world',
  fetcher=fetch,token=process.env.GITHUB_TOKEN}={}){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Invalid repository');
  const previous=await fetchR27Chain({repository,fetcher,token});
  const root='https://api.github.com/repos/'+repository;
  const get=async path=>{
    const res=await fetcher(root+path,{method:'GET',redirect:'error',
      headers:{Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(token?{Authorization:'Bearer '+token}:{})}});
    if(!res.ok)throw new Error('Missing actual GitHub PR metadata');
    return res.json();
  };
  const spec=R27_PR,mainSha=previous?.mainComparison?.mainSha;
  const [r27,runs,ancestry,mainCompare]=await Promise.all([
    get('/pulls/'+spec.number),
    get('/commits/'+spec.sha+'/check-runs?per_page=100'),
    get('/compare/'+spec.parent+'...'+spec.sha),
    SHA.test(mainSha||'')?
      get('/compare/'+mainSha+'...'+spec.sha):Promise.resolve({status:'unknown'})
  ]);
  return {previous,r27,checks:(runs.check_runs||[]).map(x=>({
    name:x.name,status:x.status,conclusion:x.conclusion,head_sha:x.head_sha
  })),compare:{base:spec.parent,head:spec.sha,status:ancestry.status},
  mainComparison:{mainSha,headSha:spec.sha,status:mainCompare.status}};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Read-only usage: --github');
    process.stdout.write(JSON.stringify(
      evaluateR28Integration(await fetchR28Integration()))+'\n');
  }catch{
    process.stdout.write(JSON.stringify({
      schema:R28_CHAIN_SCHEMA,verifiedStagedSource:false,
      mainTipPinned:false,sourcePrCount:0,allMerged:false,
      blockers:['GITHUB_CHAIN_UNAVAILABLE'],automaticMergeAllowed:false,
      deployAllowed:false,commercialPilotAllowed:false,
      productionAuthorized:false,changedMain:false,
      changedProduction:false})+'\n');
    process.exitCode=2;
  }
}
