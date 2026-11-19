/**
 * R26 read-only twelve-source-PR release review.
 * Staged source checks are separate from manual merge and live GO.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateR25Chain,fetchR25Chain,SOURCE_PRS}
  from './r25-release-chain.mjs';
export const R26_CHAIN_SCHEMA='osmanx.guest.r26.twelve-stage-release.v1';
export const R25_PR=Object.freeze({
  number:59,head:'feat/guest-r25-operational-barriers-20261119',
  base:'feat/guest-r24-decision-intelligence-20261119',
  sha:'12c616f28f11e030687462cb92b28535e1bfe5a6',
  parent:SOURCE_PRS.at(-1).sha,
  checks:['r25-offline','r25-postgres','r25-encrypted-dr',
    'r25-reproducible','r25-release-graph']
});
const SHA=/^[a-f0-9]{40}$/;
export function evaluateR26Chain({previous={},r25=null,checks=[],
  comparison=null,mainComparison=null}={}){
  const prior=evaluateR25Chain(previous);
  const p=R25_PR;
  const pinned=r25?.number===p.number&&
    r25?.head?.ref===p.head&&r25?.head?.sha===p.sha&&
    r25?.base?.ref===p.base;
  const ci=p.checks.every(name=>Array.isArray(checks)&&checks.some(j=>
    j.name===name&&j.status==='completed'&&j.conclusion==='success'&&
    j.head_sha===p.sha));
  const parent=comparison?.base===p.parent&&
    comparison?.head===p.sha&&
    ['ahead','identical'].includes(comparison?.status);
  const merged=r25?.merged===true&&r25?.state==='closed'&&
    typeof r25?.merged_at==='string'&&Number.isFinite(Date.parse(r25.merged_at));
  const mainSha=previous?.mainComparison?.mainSha;
  const mainStable=SHA.test(mainSha||'')&&
    mainComparison?.mainSha===mainSha&&
    mainComparison?.headSha===p.sha&&
    ['ahead','identical'].includes(mainComparison?.status);
  const blockers=[...prior.blockers];
  if(!pinned)blockers.push('r25_pr_changed');
  if(!ci)blockers.push('r25_named_ci_missing');
  if(!parent)blockers.push('r25_parent_changed');
  if(!merged)blockers.push('r25_not_merged');
  if(!mainStable)blockers.push('main_tip_or_r25_ancestry_changed');
  const dependencies=[...prior.dependencies,{
    pr:p.number,sourceSha:p.sha,headPinned:pinned,
    ciPassed:ci,parentCommitAncestor:parent,merged
  }];
  return {schema:R26_CHAIN_SCHEMA,dependencies,
    stagedCodeVerified:prior.stagedCodeVerified&&pinned&&ci&&parent,
    mainProtected:prior.mainProtected,mainTipStable:mainStable,
    allMerged:prior.allMerged&&merged,blockers:[...new Set(blockers)],
    exactSourceSha:p.sha,independentReviewOutstanding:true,
    automaticMergeAllowed:false,deployAllowed:false,
    productionAuthorized:false,customerGo:false,
    changedMain:false,changedProduction:false};
}
export async function fetchR26Chain({
  repository='osmanosmanov6880-bot/osmanx-world',
  fetcher=fetch,token=process.env.GITHUB_TOKEN}={}){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Invalid repository');
  const previous=await fetchR25Chain({repository,fetcher,token});
  const base='https://api.github.com/repos/'+repository;
  const get=async path=>{
    const r=await fetcher(base+path,{method:'GET',redirect:'error',
      headers:{Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(token?{Authorization:'Bearer '+token}:{})}});
    if(!r.ok)throw new Error('R26 GitHub immutable metadata unavailable');
    return r.json();
  };
  const [r25,runs,compare]=await Promise.all([
    get('/pulls/'+R25_PR.number),
    get('/commits/'+R25_PR.sha+'/check-runs?per_page=100'),
    get('/compare/'+R25_PR.parent+'...'+R25_PR.sha)
  ]);
  const mainSha=previous?.mainComparison?.mainSha;
  const main=SHA.test(mainSha||'')?
    await get('/compare/'+mainSha+'...'+R25_PR.sha):
    {status:'unknown'};
  return {previous,r25,checks:(runs.check_runs||[]).map(j=>({
    name:j.name,status:j.status,conclusion:j.conclusion,head_sha:j.head_sha
  })),comparison:{base:R25_PR.parent,head:R25_PR.sha,status:compare.status},
  mainComparison:{mainSha,headSha:R25_PR.sha,status:main.status}};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw new Error('Use --github');
    process.stdout.write(JSON.stringify(
      evaluateR26Chain(await fetchR26Chain()))+'\n');
  }catch{
    process.stdout.write(JSON.stringify({
      schema:R26_CHAIN_SCHEMA,stagedCodeVerified:false,allMerged:false,
      blockers:['github_release_chain_unavailable'],
      automaticMergeAllowed:false,deployAllowed:false,
      productionAuthorized:false,customerGo:false,
      changedMain:false,changedProduction:false})+'\n');
    process.exitCode=2;
  }
}
