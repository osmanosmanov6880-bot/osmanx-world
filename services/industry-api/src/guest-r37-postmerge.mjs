/**
 * R37 exact 23-PR manual merge and fresh-main CI gate. All evidence is
 * read-only GitHub metadata; NO-GO in the absence of real merges.
 */
import {createHash} from 'node:crypto';
import {R36_SOURCE_SCHEMA} from './guest-r36-source.mjs';
export const R37_SOURCE_SCHEMA='osmanx.guest.r37.twenty-three-pr-postmerge.v1';
export const R36_PIN=Object.freeze({
  pr:71,head:'feat/guest-r36-first-human-review-staging-dr-20261120',
  base:'feat/guest-r35-manual-merge-verified-host-evidence-20261120',
  sha:'8da6192969ec8a5d1d1523a6a605ba04d5299718',
  parent:'9a73686127436b9e6ca0d97cb153e9cd6c92b1d0',
  jobs:Object.freeze(['r36-offline','r36-postgres','r36-encrypted-dr',
    'r36-reproducible','r36-release-graph'])
});
// R36 was the last pinned PR in the 23-PR chain; its jobs must run on
// the final main SHA AFTER the manual merge, not only on its PR branch.
export const R37_MAIN_CI=Object.freeze([
  'r36-offline','r36-postgres','r36-encrypted-dr',
  'r36-reproducible','r36-release-graph'
]);
const HEX=/^[a-f0-9]{40}$/;
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function evaluateR37ReleaseChain({prior,pr,ci,compare,
  releaseCommit}={}){
  const errors=[];
  const prev=prior?.schema===R36_SOURCE_SCHEMA&&
    prior?.sourcePrsRequired===22&&prior?.observedPrs===22&&
    Array.isArray(prior?.humanSequence)&&
    prior.humanSequence.length===22&&
    prior.humanSequence.every((x,i)=>x?.order===i+1&&
      Number.isInteger(x?.pr)&&HEX.test(x.sourceSha||''))&&
    prior.humanSequence.at(-1)?.pr===70&&
    prior.humanSequence.at(-1)?.sourceSha===
      '3e4d0609950fbc315947481cf4e431a0afe87e67';
  if(!prev)errors.push('PREVIOUS_22_PR_CHAIN_INVALID');
  const pinned=pr?.number===R36_PIN.pr&&
    pr?.head?.ref===R36_PIN.head&&pr?.head?.sha===R36_PIN.sha&&
    pr?.base?.ref===R36_PIN.base;
  if(!pinned)errors.push('PR71_HEAD_OR_BASE_CHANGED');
  const checks=Array.isArray(ci)?ci:[];
  const passed=R36_PIN.jobs.every(name=>checks.some(x=>
    x?.name===name&&x?.head_sha===R36_PIN.sha&&
    x?.status==='completed'&&x?.conclusion==='success'));
  if(!passed)errors.push('R36_HEAD_CI_INCOMPLETE');
  if(compare?.status!=='ahead'||
    compare?.base!==R36_PIN.parent||compare?.head!==R36_PIN.sha)
    errors.push('R36_PARENT_DRIFT');
  const tree=releaseCommit?.sha===R36_PIN.sha&&
    HEX.test(releaseCommit?.tree?.sha||'')?
      releaseCommit.tree.sha:null;
  if(!tree)errors.push('R36_TREE_UNKNOWN');
  const ordered=[
    ...(prev?prior.humanSequence.map(x=>({
      order:x.order,pr:x.pr,sourceSha:x.sourceSha})):[]),
    {order:23,pr:R36_PIN.pr,sourceSha:R36_PIN.sha}
  ];
  const body={schema:R37_SOURCE_SCHEMA,sourcePrsRequired:23,
    observedPrs:ordered.length,ordered,
    pinnedR36SourceHead:R36_PIN.sha,r36SourceTree:tree,
    previousChainValid:prev,r36CiPassed:passed,
    manualMergePerformedByThisProcess:false,
    mainChanged:false,productionChanged:false,
    customerGo:false,productionAuthorized:false,
    blockers:errors};
  return {...body,sha256:sha(body)};
}
export function evaluateR37PostMerge({source,prs,mainRef,mainCommit,
  mainChecks=[],checksComplete=false,now=new Date()}={}){
  const problems=[],required=source?.ordered||[];
  if(source?.schema!==R37_SOURCE_SCHEMA||
    source?.sourcePrsRequired!==23||source?.blockers?.length!==0||
    required.length!==23)
    problems.push('SOURCE_CHAIN_NOT_READY');
  if(!Array.isArray(prs)||prs.length!==required.length)
    problems.push('MERGE_HISTORY_INCOMPLETE');
  const indexed=new Map();
  if(Array.isArray(prs))for(const p of prs){
    if(indexed.has(p?.number))problems.push('DUPLICATE_PR');
    indexed.set(p?.number,p);
  }
  let latestMergeTime=0;
  for(const req of required){
    const p=indexed.get(req.pr),time=Date.parse(p?.merged_at||'');
    const yes=p?.number===req.pr&&p?.head?.sha===req.sourceSha&&
      p?.state==='closed'&&p?.merged===true&&p?.draft===false&&
      Number.isFinite(time);
    if(!yes)problems.push('PR_'+req.pr+'_NOT_MANUALLY_MERGED_AT_EXPECTED_HEAD');
    else latestMergeTime=Math.max(latestMergeTime,time);
  }
  const mainSha=mainRef?.ref==='refs/heads/main'&&
    HEX.test(mainRef?.object?.sha||'')?mainRef.object.sha:null;
  const actualTree=mainCommit?.sha===mainSha&&
    HEX.test(mainCommit?.tree?.sha||'')?mainCommit.tree.sha:null;
  if(!mainSha||!actualTree||actualTree!==source?.r36SourceTree)
    problems.push('FINAL_MAIN_TREE_NOT_EQUAL_TO_PINNED_SOURCE');
  if(checksComplete!==true||!Array.isArray(mainChecks))
    problems.push('MAIN_CI_PAGINATION_INCOMPLETE');
  const checks=Array.isArray(mainChecks)?mainChecks:[];
  for(const job of R37_MAIN_CI){
    const ok=checks.some(x=>x?.name===job&&x?.head_sha===mainSha&&
      x?.status==='completed'&&x?.conclusion==='success'&&
      Number.isFinite(Date.parse(x?.completed_at||''))&&
      Date.parse(x.completed_at)>=latestMergeTime&&
      latestMergeTime>0);
    if(!ok)problems.push('MAIN_CI_'+job+'_MISSING_AFTER_MERGE');
  }
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    latestMergeTime>now.getTime())
    problems.push('INVALID_POSTMERGE_CLOCK');
  const all=problems.length===0;
  const body={schema:'osmanx.guest.r37.postmerge-human-gate.v1',
    requiredPrs:23,latestMergeObservedAt:latestMergeTime?
      new Date(latestMergeTime).toISOString():null,
    mainCommitSha:mainSha,mainTreeSha:actualTree,
    exactSourcesMergedWithFreshMainCi:all,
    finalMainCiVerified:all,
    missingPrerequisites:[...new Set(problems)],
    stagingIndependentlyWitnessed:false,
    actualOffsiteRestoreIndependentlyWitnessed:false,
    legalAuthorityIndependentlyApproved:false,
    operatorFinalChangeApprovalGranted:false,
    automaticMergeAllowed:false,
    deployAllowed:false,
    guestWritesEnabled:false,
    customerGo:false,productionAuthorized:false};
  return {...body,sha256:sha(body)};
}
