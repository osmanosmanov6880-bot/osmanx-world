/**
 * R34: exact 20 PR release review and deterministic manual merge queue.
 * Source CI cannot substitute post-merge main CI; no mutations.
 */
import {R33_SOURCE_SCHEMA} from './guest-r33-source.mjs';
export const R34_SOURCE_SCHEMA='osmanx.guest.r34.twenty-pr-review.v1';
export const R33_PIN=Object.freeze({
  pr:68,head:'feat/guest-r33-verified-staging-rollback-privacy-20261119',
  base:'feat/guest-r32-human-cutover-preflight-20261119',
  sha:'9957b916a3e72fbf7aba73d0e9da0f176013a037',
  parent:'546f3fface0fc2bc44e72cee2c2d93bf912fe9e0',
  jobs:Object.freeze(['r33-offline','r33-postgres','r33-encrypted-dr',
    'r33-reproducible','r33-release-graph'])
});
const SHA=/^[a-f0-9]{40}$/;
export function evaluateR34Source({prior,pr,checks=[],ancestry,releaseCommit,
  mainCommit}={}){
  const blockers=[];
  const priorValid=prior?.schema===R33_SOURCE_SCHEMA&&
    prior?.sourcePrsRequired===19&&prior?.observedPrs===19&&
    Array.isArray(prior?.humanSequence)&&prior.humanSequence.length===19&&
    prior.humanSequence.every((e,i)=>e?.order===i+1&&
      Number.isInteger(e?.pr)&&SHA.test(e?.sourceSha||''))&&
    prior.humanSequence.at(-1)?.pr===67&&
    prior.humanSequence.at(-1)?.sourceSha===
      '1c1c7047cd1d197fea0289857b2bacee141baaea';
  if(!priorValid)blockers.push('R33_PREDECESSOR_CHAIN_INVALID');
  const pinned=pr?.number===R33_PIN.pr&&
    pr?.head?.ref===R33_PIN.head&&pr?.head?.sha===R33_PIN.sha&&
    pr?.base?.ref===R33_PIN.base;
  if(!pinned)blockers.push('R33_PR_HEAD_MOVED');
  const sourceCi=R33_PIN.jobs.every(name=>Array.isArray(checks)&&
    checks.some(e=>e?.name===name&&e?.head_sha===R33_PIN.sha&&
      e?.status==='completed'&&e?.conclusion==='success'));
  if(!sourceCi)blockers.push('R33_REQUIRED_JOBS_NOT_GREEN');
  const ancestor=ancestry?.base===R33_PIN.parent&&
    ancestry?.head===R33_PIN.sha&&ancestry?.status==='ahead';
  if(!ancestor)blockers.push('R33_ANCESTRY_MISMATCH');
  const sourceTree=releaseCommit?.sha===R33_PIN.sha&&
    SHA.test(releaseCommit?.tree?.sha||'')?releaseCommit.tree.sha:null;
  if(!sourceTree)blockers.push('R33_SOURCE_TREE_MISSING');
  const mainSha=SHA.test(prior?.mainSha||'')?prior.mainSha:null;
  const mainTree=mainSha&&mainCommit?.sha===mainSha&&
    SHA.test(mainCommit?.tree?.sha||'')?mainCommit.tree.sha:null;
  if(!mainTree)blockers.push('MAIN_TREE_UNVERIFIED');
  const merged=pr?.merged===true&&pr?.state==='closed'&&
    pr?.draft===false&&Number.isFinite(Date.parse(pr?.merged_at||''));
  if(!merged)blockers.push('PR68_REQUIRES_HUMAN_MERGE');
  if(prior?.allHumanMerged!==true)
    blockers.push('PREDECESSOR_MERGES_NOT_COMPLETE');
  if(!sourceTree||!mainTree||sourceTree!==mainTree)
    blockers.push('MAIN_TREE_NOT_SAME_AS_SOURCE');
  blockers.push('FINAL_POST_MERGE_MAIN_CI_REQUIRED');
  const sequence=[...(priorValid?prior.humanSequence.map(e=>({
    order:e.order,pr:e.pr,sourceSha:e.sourceSha,
    reviewedAndMerged:e.reviewedAndMerged===true
  })):[]),{order:20,pr:R33_PIN.pr,sourceSha:R33_PIN.sha,
    reviewedAndMerged:merged}];
  const firstPending=sequence.find(e=>!e.reviewedAndMerged);
  return {schema:R34_SOURCE_SCHEMA,sourcePrsRequired:20,
    observedPrs:sequence.length,sourceHeadSha:R33_PIN.sha,
    sourceTreeSha:sourceTree,mainSha,mainTreeSha:mainTree,
    sourceCiPassed:sourceCi,ancestryVerified:ancestor,
    humanSequence:sequence,
    nextManualAction:firstPending?{
      action:'REVIEW_AND_MERGE_ONE_PR',pr:firstPending.pr,
      expectedHead:firstPending.sourceSha,order:firstPending.order
    }:{action:'VERIFY_FINAL_MAIN_CI',pr:null,expectedHead:null,order:null},
    allHumanMerged:Boolean(prior?.allHumanMerged&&merged),
    postMergeMainCiPassed:false,
    blockers:[...new Set(blockers)],
    automaticMergeAllowed:false,deployAllowed:false,
    productionAuthorized:false,stopLifted:false,
    mainChanged:false,productionChanged:false};
}
