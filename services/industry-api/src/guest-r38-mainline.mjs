/**
 * R38 replaces brittle equality of main/source Git trees with verifiable
 * ancestry plus fresh CI on the exact main HEAD. New unrelated main commits
 * are allowed, but squash/rebase without source ancestry remains NO-GO.
 */
import {createHash} from 'node:crypto';
import {R37_SOURCE_SCHEMA} from './guest-r37-postmerge.mjs';
export const R38_SOURCE_SCHEMA='osmanx.guest.r38.twenty-four-pr-source.v1';
export const R37_PIN=Object.freeze({
  pr:72,sha:'a9f6cb0b7a9c6af6d005b5a634a1c277b42e8d5f',
  parent:'8da6192969ec8a5d1d1523a6a605ba04d5299718',
  head:'feat/guest-r37-canary-restore-image-postmerge-20261120',
  base:'feat/guest-r36-first-human-review-staging-dr-20261120',
  jobs:Object.freeze(['r37-offline','r37-postgres','r37-encrypted-dr',
    'r37-reproducible','r37-release-graph'])
});
const HEX=/^[a-f0-9]{40}$/;
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function evaluateR38Source({prior,pr,checks,comparison,commit}={}){
  const errors=[];
  const prev=prior?.schema===R37_SOURCE_SCHEMA&&
    prior?.sourcePrsRequired===23&&prior?.observedPrs===23&&
    prior?.blockers?.length===0&&
    Array.isArray(prior?.ordered)&&prior.ordered.length===23&&
    prior.ordered.every((x,i)=>x?.order===i+1&&
      Number.isInteger(x.pr)&&HEX.test(x.sourceSha||''))&&
    prior.ordered.at(-1)?.pr===71&&
    prior.ordered.at(-1)?.sourceSha===
      '8da6192969ec8a5d1d1523a6a605ba04d5299718';
  if(!prev)errors.push('PREVIOUS_23_PR_CHAIN_INVALID');
  if(pr?.number!==R37_PIN.pr||pr?.head?.ref!==R37_PIN.head||
    pr?.head?.sha!==R37_PIN.sha||pr?.base?.ref!==R37_PIN.base)
    errors.push('PR72_HEAD_OR_BASE_DRIFT');
  const passed=R37_PIN.jobs.every(name=>(Array.isArray(checks)?checks:[])
    .some(x=>x?.name===name&&x?.head_sha===R37_PIN.sha&&
      x?.status==='completed'&&x?.conclusion==='success'));
  if(!passed)errors.push('PINNED_R37_CI_NOT_GREEN');
  if(comparison?.base!==R37_PIN.parent||
    comparison?.head!==R37_PIN.sha||
    comparison?.status!=='ahead')
    errors.push('R37_PARENT_OR_ANCESTRY_MISMATCH');
  const sourceTree=commit?.sha===R37_PIN.sha&&
    HEX.test(commit?.tree?.sha||'')?commit.tree.sha:null;
  if(!sourceTree)errors.push('R37_SOURCE_TREE_UNKNOWN');
  const ordered=[
    ...(prev?prior.ordered.map(e=>({...e})):[]),
    {order:24,pr:R37_PIN.pr,sourceSha:R37_PIN.sha}
  ];
  return {schema:R38_SOURCE_SCHEMA,sourcePrsRequired:24,
    observedPrs:ordered.length,ordered,
    pinnedR37SourceSha:R37_PIN.sha,sourceTree,
    r37CiPassed:passed,
    mainChanged:false,productionChanged:false,
    automaticMergeAllowed:false,
    customerGo:false,productionAuthorized:false,
    blockers:errors};
}
export function evaluateR38MainAncestry({source,prs,mainBefore,mainAfter,
  mainCommit,ancestry,checks,checksComplete=false,now=new Date()}={}){
  const blockers=[];
  const orders=source?.ordered||[];
  if(source?.schema!==R38_SOURCE_SCHEMA||
    source?.sourcePrsRequired!==24||
    source?.observedPrs!==24||
    source?.blockers?.length!==0||orders.length!==24)
    blockers.push('SOURCE_24_PR_PIN_INVALID');
  if(!Array.isArray(prs)||prs.length!==24)
    blockers.push('INCOMPLETE_PR_MERGE_HISTORY');
  const index=new Map();
  if(Array.isArray(prs))for(const p of prs){
    if(index.has(p?.number))blockers.push('DUPLICATE_PR');
    index.set(p?.number,p);
  }
  let last=0,previous=0;
  for(const entry of orders){
    const p=index.get(entry.pr),when=Date.parse(p?.merged_at||'');
    if(p?.number!==entry.pr||p?.head?.sha!==entry.sourceSha||
      p?.state!=='closed'||p?.merged!==true||
      p?.draft!==false||!Number.isFinite(when))
      blockers.push('PR_'+entry.pr+'_REQUIRES_MANUAL_MERGE');
    else{
      if(when<previous)blockers.push('OUT_OF_ORDER_MANUAL_MERGES');
      previous=when;last=Math.max(last,when);
    }
  }
  const head=mainBefore?.ref==='refs/heads/main'&&
    HEX.test(mainBefore?.object?.sha||'')?mainBefore.object.sha:null;
  if(mainAfter?.ref!=='refs/heads/main'||mainAfter?.object?.sha!==head)
    blockers.push('MAIN_MOVED_DURING_AUDIT');
  if(!head||mainCommit?.sha!==head||
    !HEX.test(mainCommit?.tree?.sha||''))
    blockers.push('MAIN_HEAD_NOT_VERIFIED');
  // This must be a real compare of SOURCE_SHA...MAIN_SHA, not a tree
  // equality check: unrelated CINEMA / website commits on main are fine.
  const ancestorsOk=ancestry?.base===source?.pinnedR37SourceSha&&
    ancestry?.head===head&&
    ['ahead','identical'].includes(ancestry?.status)&&
    ancestry?.mergeBaseSha===source?.pinnedR37SourceSha;
  if(!ancestorsOk)blockers.push('PINNED_SOURCE_NOT_ANCESTOR_OF_MAIN');
  if(checksComplete!==true||!Array.isArray(checks))
    blockers.push('MAIN_CHECK_RUNS_INCOMPLETE');
  for(const name of R37_PIN.jobs){
    if(!(Array.isArray(checks)?checks:[]).some(x=>
      x?.name===name&&x.head_sha===head&&
      x.status==='completed'&&x.conclusion==='success'&&
      Number.isFinite(Date.parse(x.completed_at||''))&&
      Date.parse(x.completed_at)>=last&&last>0))
      blockers.push('POSTMERGE_MAIN_CI_MISSING_'+name);
  }
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    last>now.getTime())
    blockers.push('INVALID_REVIEW_CLOCK');
  const valid=blockers.length===0;
  const firstPending=orders.find(x=>!index.get(x.pr)?.merged);
  const record={schema:'osmanx.guest.r38.main-ancestry-evidence.v1',
    sourcePrsRequired:24,firstPendingPr:firstPending?.pr??null,
    sourceCommit:source?.pinnedR37SourceSha||null,
    verifiedMainSha:head,
    unrelatedMainCommitsAreAllowed:true,
    mergeCommitAncestryVerified:valid,
    postMergeMainCiVerified:valid,
    independentlyReviewedLegalBasis:false,
    remoteStagingAttested:false,offsiteRestoreWitnessed:false,
    automaticMergeAllowed:false,productionAuthorized:false,
    customerGo:false,mainChangedByThisProcess:false,
    blockers:[...new Set(blockers)]};
  return {...record,sha256:sha(JSON.stringify(record))};
}
