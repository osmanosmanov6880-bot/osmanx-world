/**
 * R32 stacked source genealogy: exact immutable R31 #66 and five named CI jobs.
 * Read-only provenance. All prior human code review remains mandatory.
 */
import {R31_CHAIN_SCHEMA} from './guest-r31-chain.mjs';
export const R32_SOURCE_SCHEMA='osmanx.guest.r32.eighteen-pr-review.v1';
export const R31_PIN=Object.freeze({
  pr:66,head:'feat/guest-r31-operator-staging-evidence-20261119',
  base:'feat/guest-r30-independent-evidence-review-20261119',
  sha:'0e39e243162dd48c84eb790539d97439e969a65a',
  parent:'d70adf1de34e3a0f313abd6eced19edc10dcac9c',
  jobs:Object.freeze(['r31-offline','r31-postgres','r31-encrypted-dr',
    'r31-reproducible','r31-release-graph'])
});
const SHA=/^[a-f0-9]{40}$/;
export function evaluateR32Source({prior,pr,checks=[],ancestry,releaseCommit,
  mainCommit}={}){
  const blockers=[];
  const validPrior=prior?.schema===R31_CHAIN_SCHEMA&&
    prior.sourcePrsRequired===17&&prior.observedPrs===17&&
    Array.isArray(prior.humanSequence)&&prior.humanSequence.length===17&&
    prior.humanSequence.every((e,i)=>e?.order===i+1&&
      Number.isInteger(e?.pr)&&SHA.test(e?.sourceSha||''))&&
    prior.humanSequence.at(-1).pr===65&&
    prior.humanSequence.at(-1).sourceSha===
      '658bc5ac937e088d7a9d50b7946426d2b82b92f4';
  if(!validPrior)blockers.push('R31_PREDECESSOR_UNVERIFIED');
  const pinned=pr?.number===R31_PIN.pr&&pr?.head?.ref===R31_PIN.head&&
    pr?.head?.sha===R31_PIN.sha&&pr?.base?.ref===R31_PIN.base;
  if(!pinned)blockers.push('R31_PR_HEAD_CHANGED');
  const passed=R31_PIN.jobs.every(name=>Array.isArray(checks)&&
    checks.some(e=>e?.name===name&&e?.head_sha===R31_PIN.sha&&
      e?.status==='completed'&&e?.conclusion==='success'));
  if(!passed)blockers.push('R31_NAMED_CI_INCOMPLETE');
  const ancestor=ancestry?.base===R31_PIN.parent&&
    ancestry?.head===R31_PIN.sha&&ancestry?.status==='ahead';
  if(!ancestor)blockers.push('R31_ANCESTRY_CHANGED');
  const sourceTree=releaseCommit?.sha===R31_PIN.sha&&
    SHA.test(releaseCommit?.tree?.sha||'')?releaseCommit.tree.sha:null;
  if(!sourceTree)blockers.push('R31_TREE_MISSING');
  const mainSha=prior?.mainSha;
  const mainTree=SHA.test(mainSha||'')&&mainCommit?.sha===mainSha&&
    SHA.test(mainCommit?.tree?.sha||'')?mainCommit.tree.sha:null;
  if(!mainTree)blockers.push('MAIN_TREE_UNVERIFIED');
  const merged=pr?.merged===true&&pr?.state==='closed'&&
    pr?.draft===false&&Number.isFinite(Date.parse(pr?.merged_at||''));
  if(!merged)blockers.push('R31_NOT_HUMAN_MERGED');
  if(prior?.allMerged!==true)blockers.push('R1_R30_NOT_ALL_MERGED');
  if(!sourceTree||!mainTree||mainTree!==sourceTree)
    blockers.push('MERGED_MAIN_NOT_SAME_TREE');
  blockers.push('POST_MERGE_MAIN_CI_MISSING');
  const sequence=[...(validPrior?prior.humanSequence.map(e=>({
    order:e.order,pr:e.pr,sourceSha:e.sourceSha,
    reviewedAndMerged:e.reviewedAndMerged===true
  })):[]),{order:18,pr:66,sourceSha:R31_PIN.sha,
    reviewedAndMerged:merged}];
  return {schema:R32_SOURCE_SCHEMA,sourcePrsRequired:18,
    observedPrs:sequence.length,releaseSha:R31_PIN.sha,sourceTreeSha:sourceTree,
    mainSha:SHA.test(mainSha||'')?mainSha:null,mainTreeSha:mainTree,
    sourceCiPassed:passed,ancestryVerified:ancestor,
    humanSequence:sequence,firstPendingPr:
      sequence.find(e=>!e.reviewedAndMerged)?.pr||null,
    allHumanMerged:Boolean(prior?.allMerged&&merged),
    postMergeMainCiPassed:false,sourceTreeMatchesMain:
      Boolean(sourceTree&&mainTree&&sourceTree===mainTree),
    blockers:[...new Set(blockers)],automaticMergeAllowed:false,
    productionAuthorized:false,deployAllowed:false,
    stopLifted:false,changedMain:false,changedProduction:false};
}
