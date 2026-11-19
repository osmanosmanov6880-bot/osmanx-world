/**
 * R29 exact git TREE and manual-release chain read-only. A matching tree proves
 * file identity, NOT that a commit has been merged or independently reviewed.
 * No GitHub mutations and no VPS access.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateR28Integration,fetchR28Integration,R27_PR}
  from './r28-release-plan.mjs';
export const R29_CHAIN_SCHEMA='osmanx.guest.r29.fifteen-source-tree-review.v1';
export const R28_PR=Object.freeze({
  number:62,head:'feat/guest-r28-independent-release-review-20261119',
  base:'feat/guest-r27-first-client-rehearsal-20261119',
  sha:'f9f73acbef0ba63f7f2706f87a1b0ee8b4cfdc7d',
  parent:R27_PR.sha,
  requiredJobs:['r28-offline','r28-postgres','r28-encrypted-dr',
    'r28-reproducible','r28-release-graph']
});
const SHA=/^[a-f0-9]{40}$/;
export function evaluateR29SourceTree({previous={},r28,checks=[],
  compare,sourceCommit,mainCommit,mainComparison}={}){
  const prior=evaluateR28Integration(previous),p=R28_PR;
  const pinned=r28?.number===p.number&&
    r28?.head?.ref===p.head&&r28.head.sha===p.sha&&
    r28.base?.ref===p.base;
  const ci=p.requiredJobs.every(name=>checks.some(j=>
    j.name===name&&j.head_sha===p.sha&&
    j.status==='completed'&&j.conclusion==='success'));
  const ancestry=compare?.base===p.parent&&compare?.head===p.sha&&
    ['ahead','identical'].includes(compare.status);
  const sourceTree=sourceCommit?.sha===p.sha&&
    SHA.test(sourceCommit?.tree?.sha||'')?sourceCommit.tree.sha:null;
  const mainSha=prior.mainSha;
  const mainCurrent=SHA.test(mainSha||'')&&mainCommit?.sha===mainSha&&
    SHA.test(mainCommit?.tree?.sha||'')&&
    mainComparison?.base===mainSha&&mainComparison?.head===p.sha&&
    ['ahead','identical'].includes(mainComparison.status);
  const treeMatchesMain=Boolean(sourceTree&&mainCurrent&&
    sourceTree===mainCommit.tree.sha);
  const merged=r28?.merged===true&&r28.state==='closed'&&
    typeof r28.merged_at==='string'&&Number.isFinite(Date.parse(r28.merged_at));
  const blockers=[...prior.blockers];
  if(!pinned)blockers.push('R28_PR_HEAD_CHANGED');
  if(!ci)blockers.push('R28_REQUIRED_NAMED_CI_MISSING');
  if(!ancestry)blockers.push('R28_PARENT_ANCESTRY_CHANGED');
  if(!sourceTree)blockers.push('R28_TREE_SHA_UNAVAILABLE');
  if(!mainCurrent)blockers.push('MAIN_COMMIT_CHANGED_OR_UNAVAILABLE');
  if(!treeMatchesMain)blockers.push('MERGED_MAIN_TREE_NOT_EQUAL_TO_SOURCE');
  if(!merged)blockers.push('R28_NOT_MERGED');
  if(r28?.draft===true&&!merged)blockers.push('R28_DRAFT_REVIEW_REQUIRED');
  if(prior.dependencies?.length!==14)blockers.push('PR_CHAIN_INCOMPLETE');
  const dependencies=[...(prior.dependencies||[]),{
    pr:p.number,sourceSha:p.sha,treeSha:sourceTree,
    headPinned:pinned,ciPassed:ci,parentCommitAncestor:ancestry,merged
  }];
  return {
    schema:R29_CHAIN_SCHEMA,sourceHeadSha:p.sha,
    sourceTreeSha:sourceTree,mainTreeSha:mainCommit?.tree?.sha||null,
    mainSha:mainSha||null,
    dependencies,sourcePrCount:dependencies.length,
    humanMergeSequence:dependencies.map((x,i)=>({
      order:i+1,pr:x.pr,sourceSha:x.sourceSha,
      humanCodeReviewRequired:true,merged:x.merged===true,
      freshMainCiRequired:true
    })),
    stagedSourceVerified:prior.verifiedStagedSource&&pinned&&ci&&ancestry,
    allMerged:prior.allMerged&&merged,
    mainCommitCurrent:mainCurrent,sourceTreeEqualsMain:treeMatchesMain,
    freshMainCiPassed:false,actualStagingHostProbed:false,
    customerGo:false,productionAuthorized:false,
    automaticMergeAllowed:false,deployAllowed:false,
    blockers:[...new Set(blockers)],
    changedMain:false,changedProduction:false
  };
}
export async function fetchR29SourceTree({
  repository='osmanosmanov6880-bot/osmanx-world',
  fetcher=fetch,token=process.env.GITHUB_TOKEN
}={}){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw Error('Invalid repository');
  const previous=await fetchR28Integration({repository,fetcher,token});
  const base='https://api.github.com/repos/'+repository;
  const get=async path=>{
    const response=await fetcher(base+path,{method:'GET',redirect:'error',
      headers:{Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(token?{Authorization:'Bearer '+token}:{})}});
    if(!response.ok)throw Error('R29 GitHub source unavailable');
    return response.json();
  };
  const mainSha=previous?.mainComparison?.mainSha;
  const [r28,run,ancestry,sourceCommit,mainCommit,mainCompare]=
    await Promise.all([
      get('/pulls/'+R28_PR.number),
      get('/commits/'+R28_PR.sha+'/check-runs?per_page=100'),
      get('/compare/'+R28_PR.parent+'...'+R28_PR.sha),
      get('/git/commits/'+R28_PR.sha),
      SHA.test(mainSha||'')?get('/git/commits/'+mainSha):Promise.resolve(null),
      SHA.test(mainSha||'')?
        get('/compare/'+mainSha+'...'+R28_PR.sha):
        Promise.resolve({status:'unknown'})
    ]);
  return {previous,r28,checks:(run.check_runs||[]).map(x=>({
    name:x.name,status:x.status,conclusion:x.conclusion,head_sha:x.head_sha
  })),compare:{base:R28_PR.parent,head:R28_PR.sha,status:ancestry.status},
  sourceCommit:{sha:R28_PR.sha,tree:sourceCommit.tree},
  mainCommit:mainCommit?{sha:mainSha,tree:mainCommit.tree}:null,
  mainComparison:{base:mainSha,head:R28_PR.sha,status:mainCompare.status}};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Usage: --github');
    process.stdout.write(JSON.stringify(
      evaluateR29SourceTree(await fetchR29SourceTree()))+'\n');
  }catch{
    process.stdout.write(JSON.stringify({
      schema:R29_CHAIN_SCHEMA,sourcePrCount:0,
      blockers:['SOURCE_OR_MAIN_TREE_UNAVAILABLE'],
      sourceTreeEqualsMain:false,freshMainCiPassed:false,
      automaticMergeAllowed:false,deployAllowed:false,
      customerGo:false,productionAuthorized:false,
      changedMain:false,changedProduction:false})+'\n');
    process.exitCode=2;
  }
}
