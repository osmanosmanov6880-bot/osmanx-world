/**
 * R31: review exact 17 PR source graph. No branch, PR or deploy mutation.
 * Source-branch checks cannot establish main's post-merge CI.
 */
import {R30_SOURCE_SCHEMA} from './guest-r30-source-review.mjs';
export const R31_CHAIN_SCHEMA='osmanx.guest.r31.seventeen-source-review.v1';
export const R30_PIN=Object.freeze({
  number:65,head:'feat/guest-r30-independent-evidence-review-20261119',
  base:'feat/guest-r29-merge-staging-acceptance-20261119',
  sha:'658bc5ac937e088d7a9d50b7946426d2b82b92f4',
  parent:'7b2e9a60765a08b0662b332378958147431783ab',
  requiredJobs:Object.freeze(['r30-offline','r30-postgres',
    'r30-encrypted-dr','r30-reproducible','r30-release-graph'])
});
const COMMIT=/^[a-f0-9]{40}$/;
export function evaluateR31Chain({previous,r30,checks=[],compare,
  releaseCommit,mainCommit}={}){
  const blockers=[];
  const priorValid=previous?.schema===R30_SOURCE_SCHEMA&&
    previous.sourcePrsRequired===16&&previous.sourcePrsObserved===16&&
    Array.isArray(previous.humanMergeSequence)&&
    previous.humanMergeSequence.length===16&&
    previous.humanMergeSequence.every((x,i)=>x.order===i+1&&
      Number.isInteger(x.pr)&&COMMIT.test(x.sourceSha||''))&&
    previous.humanMergeSequence.at(-1)?.pr===64&&
    previous.humanMergeSequence.at(-1)?.sourceSha===
      '7b2e9a60765a08b0662b332378958147431783ab';
  if(!priorValid)blockers.push('R30_PREDECESSOR_GRAPH_UNVERIFIED');
  const exactPr=r30?.number===R30_PIN.number&&
    r30?.head?.ref===R30_PIN.head&&r30.head.sha===R30_PIN.sha&&
    r30?.base?.ref===R30_PIN.base;
  if(!exactPr)blockers.push('R30_SOURCE_HEAD_DRIFT');
  const completeCi=R30_PIN.requiredJobs.every(name=>
    Array.isArray(checks)&&checks.some(x=>x?.name===name&&
      x?.head_sha===R30_PIN.sha&&x?.status==='completed'&&
      x?.conclusion==='success'));
  if(!completeCi)blockers.push('R30_NAMED_SOURCE_CI_NOT_GREEN');
  const ancestorsVerified=compare?.base===R30_PIN.parent&&
    compare?.head===R30_PIN.sha&&compare?.status==='ahead';
  if(!ancestorsVerified)blockers.push('R30_ANCESTRY_DRIFT');
  const sourceTree=releaseCommit?.sha===R30_PIN.sha&&
    COMMIT.test(releaseCommit?.tree?.sha||'')?
      releaseCommit.tree.sha:null;
  if(!sourceTree)blockers.push('R30_RELEASE_TREE_NOT_PINNED');
  const mainSha=previous?.mainSha;
  const mainTree=COMMIT.test(mainSha||'')&&
    mainCommit?.sha===mainSha&&
    COMMIT.test(mainCommit?.tree?.sha||'')?
      mainCommit.tree.sha:null;
  if(!mainTree)blockers.push('CURRENT_MAIN_TREE_NOT_ATTESTED');
  const merged=r30?.merged===true&&r30?.state==='closed'&&
    r30?.draft===false&&typeof r30?.merged_at==='string'&&
    Number.isFinite(Date.parse(r30.merged_at));
  if(!merged)blockers.push('R30_REQUIRES_HUMAN_MERGE');
  if(previous?.allSourcePrsMerged!==true)
    blockers.push('PREDECESSOR_PRS_NOT_ALL_MERGED');
  if(!sourceTree||sourceTree!==mainTree)
    blockers.push('MAIN_TREE_DIFFERS_FROM_RELEASE');
  blockers.push('POST_MERGE_MAIN_CI_UNVERIFIED');
  const sequence=[
    ...(priorValid?previous.humanMergeSequence.map(x=>({
      order:x.order,pr:x.pr,sourceSha:x.sourceSha,
      reviewedAndMerged:x.reviewedAndMerged===true
    })):[]),
    {order:17,pr:R30_PIN.number,sourceSha:R30_PIN.sha,
      reviewedAndMerged:merged}
  ];
  const firstPending=sequence.find(x=>!x.reviewedAndMerged)?.pr??null;
  return {
    schema:R31_CHAIN_SCHEMA,sourcePrsRequired:17,
    observedPrs:sequence.length,releaseCommitSha:R30_PIN.sha,
    sourceTreeSha:sourceTree,mainSha:COMMIT.test(mainSha||'')?mainSha:null,
    mainTreeSha:mainTree,sourceCiPassed:completeCi,
    ancestryVerified:ancestorsVerified,predecessorValid:priorValid,
    allMerged:Boolean(previous?.allSourcePrsMerged&&merged),
    sourceTreeMatchesMain:Boolean(sourceTree&&mainTree&&sourceTree===mainTree),
    firstHumanReviewPr:firstPending,humanSequence:sequence,
    postMergeMainCiVerified:false,
    blockers:[...new Set(blockers)],
    autoMergeAllowed:false,deployAllowed:false,productionAuthorized:false,
    customerGo:false,changedMain:false,changedProduction:false
  };
}
