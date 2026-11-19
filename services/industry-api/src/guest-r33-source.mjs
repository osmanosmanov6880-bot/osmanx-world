/**
 * R33 checks the nineteenth *source* PR, not a release on merged main.
 * All inputs are GitHub GET snapshots and untrusted until pinned & verified.
 */
import {R32_SOURCE_SCHEMA} from './guest-r32-source.mjs';
export const R33_SOURCE_SCHEMA='osmanx.guest.r33.nineteen-pr-evidence.v1';
export const R32_PIN=Object.freeze({
  pr:67,head:'feat/guest-r32-human-cutover-preflight-20261119',
  base:'feat/guest-r31-operator-staging-evidence-20261119',
  sha:'1c1c7047cd1d197fea0289857b2bacee141baaea',
  parent:'52cc895d7a23eff793b688befc7a3cd8a3191aa1',
  jobs:Object.freeze(['r32-offline','r32-postgres','r32-encrypted-dr',
    'r32-reproducible','r32-release-graph'])
});
const SHA=/^[a-f0-9]{40}$/;
export function evaluateR33Source({prior,pr,checks=[],ancestry,
  releaseCommit,mainCommit}={}){
  const errors=[];
  const priorValid=prior?.schema===R32_SOURCE_SCHEMA&&
    prior?.sourcePrsRequired===18&&prior?.observedPrs===18&&
    Array.isArray(prior?.humanSequence)&&
    prior.humanSequence.length===18&&
    prior.humanSequence.every((x,i)=>x?.order===i+1&&
      Number.isInteger(x?.pr)&&SHA.test(x?.sourceSha||''))&&
    prior.humanSequence.at(-1)?.pr===66&&
    prior.humanSequence.at(-1)?.sourceSha===
      '0e39e243162dd48c84eb790539d97439e969a65a';
  if(!priorValid)errors.push('R32_GRAPH_INVALID');
  const exactPr=pr?.number===R32_PIN.pr&&
    pr?.head?.ref===R32_PIN.head&&
    pr?.head?.sha===R32_PIN.sha&&
    pr?.base?.ref===R32_PIN.base;
  if(!exactPr)errors.push('PR67_SOURCE_DRIFT');
  const sourceCi=R32_PIN.jobs.every(name=>Array.isArray(checks)&&
    checks.some(x=>x?.name===name&&x?.head_sha===R32_PIN.sha&&
      x?.status==='completed'&&x?.conclusion==='success'));
  if(!sourceCi)errors.push('R32_NAMED_CHECKS_MISSING');
  const ancestryValid=ancestry?.base===R32_PIN.parent&&
    ancestry?.head===R32_PIN.sha&&ancestry?.status==='ahead';
  if(!ancestryValid)errors.push('R32_ANCESTRY_CHANGED');
  const tree=releaseCommit?.sha===R32_PIN.sha&&
    SHA.test(releaseCommit?.tree?.sha||'')?releaseCommit.tree.sha:null;
  if(!tree)errors.push('R32_SOURCE_TREE_MISSING');
  const mainSha=SHA.test(prior?.mainSha||'')?prior.mainSha:null;
  const mainTree=mainSha&&mainCommit?.sha===mainSha&&
    SHA.test(mainCommit?.tree?.sha||'')?mainCommit.tree.sha:null;
  if(!mainTree)errors.push('MAIN_TREE_NOT_VERIFIED');
  const merged=pr?.merged===true&&pr?.state==='closed'&&
    pr?.draft===false&&Number.isFinite(Date.parse(pr?.merged_at||''));
  if(!merged)errors.push('PR67_REQUIRES_MANUAL_MERGE');
  if(prior?.allHumanMerged!==true)
    errors.push('PREVIOUS_PR_CHAIN_NOT_MERGED');
  if(!tree||!mainTree||tree!==mainTree)
    errors.push('FINAL_MAIN_TREE_DIFFERS');
  errors.push('FRESH_POST_MERGE_MAIN_CI_NOT_ATTESTED');
  const sequence=[...(priorValid?prior.humanSequence.map(x=>({
    order:x.order,pr:x.pr,sourceSha:x.sourceSha,
    reviewedAndMerged:x.reviewedAndMerged===true
  })):[]),{order:19,pr:67,sourceSha:R32_PIN.sha,
    reviewedAndMerged:merged}];
  return {schema:R33_SOURCE_SCHEMA,sourcePrsRequired:19,
    observedPrs:sequence.length,sourceHeadSha:R32_PIN.sha,
    sourceTreeSha:tree,mainSha,mainTreeSha:mainTree,
    sourceCiPassed:sourceCi,ancestryVerified:ancestryValid,
    humanSequence:sequence,firstUnmergedPr:
      sequence.find(x=>!x.reviewedAndMerged)?.pr??null,
    allHumanMerged:Boolean(prior?.allHumanMerged&&merged),
    postMergeMainCiPassed:false,mainTreeMatches:
      Boolean(tree&&mainTree&&tree===mainTree),
    blockers:[...new Set(errors)],automaticMergeAllowed:false,
    stopLifted:false,productionAuthorized:false,deployAllowed:false,
    mainChanged:false,productionChanged:false};
}
