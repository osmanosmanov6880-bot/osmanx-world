/**
 * R25 pinned, read-only eleven-PR R14-R24 staged release genealogy.
 * Source-CI success is NOT proof of reviewed merges or production clearance.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR23MergePlan,evaluateR23MergePlan,R22_PR}
  from './r23-merge-plan.mjs';
export const R25_CHAIN_SCHEMA='osmanx.guest.r25.eleven-stage-release.v1';
export const SOURCE_PRS=Object.freeze([
  {number:57,base:'feat/guest-r22-independent-readiness-20261119',
    head:'feat/guest-r23-controlled-merge-staging-20261119',
    sha:'504f176ff5929e2a37bd799bd1c39f24225665be',
    parent:R22_PR.sha,
    checks:['r23-offline','r23-postgres','r23-encrypted-dr',
      'r23-reproducible','r23-release-graph']},
  {number:58,base:'feat/guest-r23-controlled-merge-staging-20261119',
    head:'feat/guest-r24-decision-intelligence-20261119',
    sha:'8c6b061de4f692432d385aa3d8365334b0ec7201',
    parent:'504f176ff5929e2a37bd799bd1c39f24225665be',
    checks:['r24-offline','r24-postgres','r24-encrypted-dr',
      'r24-reproducible','r24-release-graph']}
]);
const sha=/^[a-f0-9]{40}$/;
function evaluateOne(spec,entry={}){
  const pr=entry.pr;
  const pinned=pr?.number===spec.number&&pr?.base?.ref===spec.base&&
    pr?.head?.ref===spec.head&&pr?.head?.sha===spec.sha;
  const namedCi=spec.checks.every(name=>Array.isArray(entry.checks)&&
    entry.checks.some(job=>job.name===name&&
      job.status==='completed'&&job.conclusion==='success'&&
      job.head_sha===spec.sha));
  const ancestor=entry.compare?.base===spec.parent&&
    entry.compare?.head===spec.sha&&
    ['ahead','identical'].includes(entry.compare?.status);
  const merged=pr?.merged===true&&pr?.state==='closed'&&
    typeof pr?.merged_at==='string'&&Number.isFinite(Date.parse(pr.merged_at));
  const blockers=[];
  if(!pinned)blockers.push('pr_'+spec.number+'_changed');
  if(!namedCi)blockers.push('pr_'+spec.number+'_ci_missing');
  if(!ancestor)blockers.push('pr_'+spec.number+'_parent_changed');
  if(!merged)blockers.push('pr_'+spec.number+'_not_merged');
  return {pr:spec.number,sourceSha:spec.sha,headPinned:pinned,
    ciPassed:namedCi,parentCommitAncestor:ancestor,merged,
    requiredJobCount:spec.checks.length,blockers};
}
export function evaluateR25Chain({prior={},source={},mainComparison={}}={}){
  const old=evaluateR23MergePlan(prior);
  const tail=SOURCE_PRS.map(spec=>evaluateOne(spec,source[spec.number]));
  const all=old.orderedPlan.map(item=>({
    pr:item.pr,sourceSha:item.sourceSha,headPinned:item.headPinned,
    ciPassed:item.checksPassed,parentCommitAncestor:item.parentCommitAncestor,
    merged:item.alreadyMerged
  })).concat(tail.map(({blockers,requiredJobCount,...rest})=>rest));
  const mainTip=old.mainSha;
  const mainStable=sha.test(mainTip||'')&&
    mainComparison?.mainSha===mainTip&&
    mainComparison?.headSha===SOURCE_PRS.at(-1).sha&&
    ['ahead','identical'].includes(mainComparison.status);
  const blockers=[...old.blockers,...tail.flatMap(x=>x.blockers)];
  if(!mainStable)blockers.push('r25_main_tip_not_verified');
  const staged=old.stagedCodeVerified&&
    tail.every(x=>x.headPinned&&x.ciPassed&&x.parentCommitAncestor);
  return {schema:R25_CHAIN_SCHEMA,
    dependencies:all,
    stagedCodeVerified:staged,
    mainProtected:old.mainProtected,
    mainTipStable:mainStable,
    allMerged:old.allMerged&&tail.every(x=>x.merged),
    blockers:[...new Set(blockers)],
    exactSourceSha:SOURCE_PRS.at(-1).sha,
    independentHumanReviewOutstanding:true,
    automaticMergeAllowed:false,deployAllowed:false,
    productionAuthorized:false,customerGo:false,
    changedMain:false,changedProduction:false};
}
export async function fetchR25Chain({
  repository='osmanosmanov6880-bot/osmanx-world',
  fetcher=fetch,token=process.env.GITHUB_TOKEN
}={}){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Invalid repository');
  const prior=await fetchR23MergePlan({repository,fetcher,token});
  const base='https://api.github.com/repos/'+repository;
  const get=async path=>{
    const response=await fetcher(base+path,{method:'GET',redirect:'error',
      headers:{Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(token?{Authorization:'Bearer '+token}:{})}});
    if(!response.ok)throw new Error('GitHub release metadata inaccessible');
    return response.json();
  };
  const source={};
  for(const spec of SOURCE_PRS){
    const [pr,runs,compare]=await Promise.all([
      get('/pulls/'+spec.number),
      get('/commits/'+spec.sha+'/check-runs?per_page=100'),
      get('/compare/'+spec.parent+'...'+spec.sha)
    ]);
    source[spec.number]={pr,checks:(runs.check_runs||[]).map(job=>({
      name:job.name,status:job.status,
      conclusion:job.conclusion,head_sha:job.head_sha
    })),compare:{base:spec.parent,head:spec.sha,status:compare.status}};
  }
  const mainSha=prior.prior?.branchPolicy?.mainSha;
  const result=sha.test(mainSha||'')?
    await get('/compare/'+mainSha+'...'+SOURCE_PRS.at(-1).sha):
    {status:'unknown'};
  return {prior,source,mainComparison:{
    mainSha,headSha:SOURCE_PRS.at(-1).sha,status:result.status
  }};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw new Error('Use --github');
    process.stdout.write(JSON.stringify(
      evaluateR25Chain(await fetchR25Chain()))+'\n');
  }catch{
    process.stdout.write(JSON.stringify({
      schema:R25_CHAIN_SCHEMA,stagedCodeVerified:false,
      mainProtected:false,mainTipStable:false,allMerged:false,
      blockers:['read_only_chain_unavailable'],
      automaticMergeAllowed:false,productionAuthorized:false,
      customerGo:false,changedMain:false,changedProduction:false})+'\n');
    process.exitCode=2;
  }
}
