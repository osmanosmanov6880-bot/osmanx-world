/**
 * R35: exact twenty-first source PR, plus one actionable human-review gate.
 * All inputs are read-only GitHub snapshots. This code cannot merge or deploy.
 */
import {R34_SOURCE_SCHEMA} from './guest-r34-source.mjs';
export const R35_SOURCE_SCHEMA='osmanx.guest.r35.twenty-one-pr-review.v1';
export const R34_PIN=Object.freeze({
  pr:69,head:'feat/guest-r34-staging-evidence-and-review-20261120',
  base:'feat/guest-r33-verified-staging-rollback-privacy-20261119',
  sha:'d1c072296f48047a494de3629fcb6758b8e7216b',
  parent:'9957b916a3e72fbf7aba73d0e9da0f176013a037',
  jobs:Object.freeze(['r34-offline','r34-postgres','r34-encrypted-dr',
    'r34-reproducible','r34-release-graph'])
});
const SHA=/^[a-f0-9]{40}$/;
export function evaluateR35Source({prior,pr,checks=[],ancestry,releaseCommit,
  mainCommit}={}){
  const issues=[];
  const priorValid=prior?.schema===R34_SOURCE_SCHEMA&&
    prior?.sourcePrsRequired===20&&prior?.observedPrs===20&&
    Array.isArray(prior?.humanSequence)&&prior.humanSequence.length===20&&
    prior.humanSequence.every((e,i)=>e?.order===i+1&&
      Number.isInteger(e?.pr)&&SHA.test(e?.sourceSha||''))&&
    prior.humanSequence.at(-1)?.pr===68&&
    prior.humanSequence.at(-1)?.sourceSha===
      '9957b916a3e72fbf7aba73d0e9da0f176013a037';
  if(!priorValid)issues.push('R34_CHAIN_INVALID');
  const pinned=pr?.number===R34_PIN.pr&&pr?.head?.ref===R34_PIN.head&&
    pr?.head?.sha===R34_PIN.sha&&pr?.base?.ref===R34_PIN.base;
  if(!pinned)issues.push('PR69_HEAD_OR_BASE_CHANGED');
  const ci=R34_PIN.jobs.every(name=>Array.isArray(checks)&&
    checks.some(c=>c?.name===name&&c?.head_sha===R34_PIN.sha&&
      c?.status==='completed'&&c?.conclusion==='success'));
  if(!ci)issues.push('R34_CI_NOT_GREEN');
  const ancestryVerified=ancestry?.base===R34_PIN.parent&&
    ancestry?.head===R34_PIN.sha&&ancestry?.status==='ahead';
  if(!ancestryVerified)issues.push('R34_ANCESTRY_INVALID');
  const sourceTree=releaseCommit?.sha===R34_PIN.sha&&
    SHA.test(releaseCommit?.tree?.sha||'')?releaseCommit.tree.sha:null;
  if(!sourceTree)issues.push('R34_TREE_MISSING');
  const mainSha=SHA.test(prior?.mainSha||'')?prior.mainSha:null;
  const mainTree=mainSha&&mainCommit?.sha===mainSha&&
    SHA.test(mainCommit?.tree?.sha||'')?mainCommit.tree.sha:null;
  if(!mainTree)issues.push('MAIN_TREE_NOT_VERIFIED');
  const merged=pr?.merged===true&&pr?.draft===false&&
    pr?.state==='closed'&&Number.isFinite(Date.parse(pr?.merged_at||''));
  if(!merged)issues.push('PR69_REQUIRES_MANUAL_MERGE');
  if(prior?.allHumanMerged!==true)
    issues.push('EARLIER_PRS_NOT_MERGED');
  if(!sourceTree||!mainTree||sourceTree!==mainTree)
    issues.push('FINAL_TREE_NOT_EQUAL_TO_MAIN');
  issues.push('FRESH_MAIN_CI_AFTER_MERGE_NOT_SEEN');
  const humanSequence=[
    ...(priorValid?prior.humanSequence.map(e=>({
      order:e.order,pr:e.pr,sourceSha:e.sourceSha,
      reviewedAndMerged:e.reviewedAndMerged===true
    })):[]),
    {order:21,pr:69,sourceSha:R34_PIN.sha,
      reviewedAndMerged:merged}
  ];
  const next=humanSequence.find(e=>!e.reviewedAndMerged);
  return {schema:R35_SOURCE_SCHEMA,sourcePrsRequired:21,
    observedPrs:humanSequence.length,sourceHeadSha:R34_PIN.sha,
    sourceTreeSha:sourceTree,sourceCiPassed:ci,ancestryVerified,
    mainSha,mainTreeSha:mainTree,humanSequence,
    firstPendingPr:next?.pr??null,expectedPendingSha:next?.sourceSha??null,
    allHumanMerged:Boolean(prior?.allHumanMerged&&merged),
    freshPostMergeMainCiPassed:false,blockers:[...new Set(issues)],
    automaticMergeAllowed:false,productionAuthorized:false,
    deployAllowed:false,stopLifted:false,
    mainChanged:false,productionChanged:false};
}
export function evaluateR35HumanReview({source,pr,reviews=[],
  checks=[]}={}){
  const issues=[],expected=source?.humanSequence?.find(e=>!e.reviewedAndMerged);
  const safe=source?.schema===R35_SOURCE_SCHEMA&&
    source?.sourcePrsRequired===21&&
    source?.automaticMergeAllowed===false&&
    Number.isInteger(expected?.pr)&&SHA.test(expected?.sourceSha||'');
  if(!safe)issues.push('PENDING_PR_UNKNOWN');
  if(pr?.number!==expected?.pr||pr?.head?.sha!==expected?.sourceSha||
    typeof pr?.user?.login!=='string')
    issues.push('NEXT_PR_HEAD_CHANGED');
  if(pr?.state!=='open'||pr?.merged===true)
    issues.push('PR_NOT_OPEN_FOR_REVIEW');
  if(pr?.draft!==false)issues.push('PR_STILL_DRAFT');
  const matching=Array.isArray(reviews)?reviews.filter(r=>
    r?.state==='APPROVED'&&r?.commit_id===expected?.sourceSha&&
    typeof r?.user?.login==='string'&&r.user.login!==pr?.user?.login&&
    Number.isFinite(Date.parse(r?.submitted_at||''))):[];
  const reviewerSet=new Set(matching.map(r=>r.user.login));
  if(reviewerSet.size<1)issues.push('NO_INDEPENDENT_APPROVAL_FOR_HEAD');
  const badCheck=Array.isArray(checks)?checks.some(c=>
    c?.head_sha===expected?.sourceSha&&
    c?.status==='completed'&&
    !['success','neutral','skipped'].includes(c?.conclusion)):true;
  if(badCheck)issues.push('LATEST_HEAD_CI_FAILURE');
  const noChecks=!Array.isArray(checks)||
    !checks.some(c=>c?.head_sha===expected?.sourceSha&&
      c?.status==='completed'&&c?.conclusion==='success');
  if(noChecks)issues.push('NO_SUCCESSFUL_CI_FOR_PENDING_HEAD');
  const step=pr?.draft===true?'MARK_PR_READY_FOR_REVIEW':
    reviewerSet.size===0?'REQUEST_INDEPENDENT_REVIEW':
      noChecks||badCheck?'FIX_AND_RUN_HEAD_CI':
        'INDEPENDENT_MERGE_DECISION_REQUIRED';
  return {schema:'osmanx.guest.r35.review-queue.v1',
    firstPendingPr:expected?.pr??null,
    expectedHeadSha:expected?.sourceSha??null,
    githubApprovedCurrentHead:reviewerSet.size>0,
    distinctApproverCount:reviewerSet.size,
    headCiPassed:!noChecks&&!badCheck,manualNextAction:step,
    independentRealWorldIdentityVerified:false,
    externalCodeAuditVerified:false,
    automaticMergeAllowed:false,customerGo:false,
    productionAuthorized:false,blockers:[...new Set(issues)]};
}
