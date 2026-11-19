/**
 * R30 independently evaluated source graph. Review-only: a green source CI
 * never turns into a green main build or an authorized deployment.
 */
import {R29_CHAIN_SCHEMA} from '../scripts/r29-source-tree.mjs';
export const R30_SOURCE_SCHEMA='osmanx.guest.r30.sixteen-pr-source-review.v1';
export const R29_PIN=Object.freeze({
  number:64,
  head:'feat/guest-r29-merge-staging-acceptance-20261119',
  base:'feat/guest-r28-independent-release-review-20261119',
  sha:'7b2e9a60765a08b0662b332378958147431783ab',
  parent:'f9f73acbef0ba63f7f2706f87a1b0ee8b4cfdc7d',
  requiredJobs:Object.freeze(['r29-offline','r29-postgres',
    'r29-encrypted-dr','r29-reproducible','r29-release-graph'])
});
const SHA=/^[a-f0-9]{40}$/;
export function evaluateR30SourceReview({previous,r29,checks=[],
  ancestry,sourceCommit,mainCommit}={}){
  const issues=[];
  const predecessorValid=previous?.schema===R29_CHAIN_SCHEMA &&
    previous?.sourcePrCount===15 &&
    Array.isArray(previous?.humanMergeSequence) &&
    previous.humanMergeSequence.length===15 &&
    previous.humanMergeSequence.every((r,i)=>
      r.order===i+1&&Number.isInteger(r.pr)&&SHA.test(r.sourceSha||'')) &&
    previous.humanMergeSequence.at(-1)?.pr===62;
  if(!predecessorValid)issues.push('R29_PREDECESSOR_CHAIN_UNVERIFIED');
  const pinned=r29?.number===R29_PIN.number &&
    r29?.head?.ref===R29_PIN.head && r29.head.sha===R29_PIN.sha &&
    r29?.base?.ref===R29_PIN.base;
  if(!pinned)issues.push('R29_HEAD_DRIFT');
  const namedCi=R29_PIN.requiredJobs.every(name=>
    Array.isArray(checks)&&checks.some(x=>
      x?.name===name&&x?.head_sha===R29_PIN.sha&&
      x?.status==='completed'&&x?.conclusion==='success'));
  if(!namedCi)issues.push('R29_NAMED_CI_MISSING');
  const parentVerified=ancestry?.base===R29_PIN.parent &&
    ancestry?.head===R29_PIN.sha && ancestry?.status==='ahead';
  if(!parentVerified)issues.push('R29_PARENT_ANCESTRY_CHANGED');
  const sourceTree=sourceCommit?.sha===R29_PIN.sha&&
    SHA.test(sourceCommit?.tree?.sha||'')?sourceCommit.tree.sha:null;
  if(!sourceTree)issues.push('R29_SOURCE_TREE_UNAVAILABLE');
  const mainSha=previous?.mainSha;
  const mainTree=SHA.test(mainSha||'')&&mainCommit?.sha===mainSha&&
    SHA.test(mainCommit?.tree?.sha||'')?mainCommit.tree.sha:null;
  if(!mainTree)issues.push('MAIN_TREE_NOT_PINNED');
  const merged=r29?.merged===true&&r29?.state==='closed'&&
    typeof r29?.merged_at==='string'&&Number.isFinite(Date.parse(r29.merged_at));
  if(!merged)issues.push('R29_NEEDS_INDEPENDENT_MERGE_REVIEW');
  if(r29?.draft===true)issues.push('R29_IS_DRAFT');
  if(!previous?.allMerged)issues.push('PR_47_TO_62_NOT_ALL_MERGED');
  if(!sourceTree||!mainTree||sourceTree!==mainTree)
    issues.push('SOURCE_TREE_NOT_EQUAL_TO_MAIN');
  // No post-merge main CI can be established from source-branch checks.
  issues.push('FRESH_MAIN_CI_NOT_INDEPENDENTLY_ATTESTED');
  const prior=predecessorValid?previous.humanMergeSequence:[];
  const humanMergeSequence=[
    ...prior.map(x=>({order:x.order,pr:x.pr,sourceSha:x.sourceSha,
      reviewedAndMerged:x.merged===true})),
    {order:16,pr:64,sourceSha:R29_PIN.sha,reviewedAndMerged:merged}
  ];
  const blockers=[...new Set([...(Array.isArray(previous?.blockers)?
    previous.blockers.filter(x=>typeof x==='string').slice(0,64):[]),...issues])];
  return {
    schema:R30_SOURCE_SCHEMA,sourcePrsRequired:16,
    sourcePrsObserved:humanMergeSequence.length,
    headCommit:R29_PIN.sha,sourceTreeSha:sourceTree,
    mainSha:SHA.test(mainSha||'')?mainSha:null,mainTreeSha:mainTree,
    humanMergeSequence,sourceNamedCiPassed:namedCi,
    parentAncestryVerified:parentVerified,predecessorValid,
    allSourcePrsMerged:Boolean(previous?.allMerged&&merged),
    currentMainTreeMatchesSource:Boolean(sourceTree&&mainTree&&sourceTree===mainTree),
    freshPostMergeMainCiPassed:false,
    independentHumanReviewComplete:false,
    blockers,customerGo:false,productionAuthorized:false,
    automaticMergeAllowed:false,deployAllowed:false,changedMain:false,
    changedProduction:false
  };
}
