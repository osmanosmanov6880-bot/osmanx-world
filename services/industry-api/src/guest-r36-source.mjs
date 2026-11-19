/**
 * R36: 22 pinned source PRs and current human-review event state.
 * Read-only, no branch operations, approvals or deploy commands.
 */
import {R35_SOURCE_SCHEMA} from './guest-r35-source.mjs';
export const R36_SOURCE_SCHEMA='osmanx.guest.r36.twenty-two-pr-gate.v1';
export const R35_PIN=Object.freeze({
  pr:70,head:'feat/guest-r35-manual-merge-verified-host-evidence-20261120',
  base:'feat/guest-r34-staging-evidence-and-review-20261120',
  sha:'3e4d0609950fbc315947481cf4e431a0afe87e67',
  parent:'d1c072296f48047a494de3629fcb6758b8e7216b',
  jobs:Object.freeze(['r35-offline','r35-postgres','r35-encrypted-dr',
    'r35-reproducible','r35-release-graph'])
});
const HEX40=/^[a-f0-9]{40}$/;
export function evaluateR36Source({prior,pr,checks=[],compare,commit,
  mainCommit}={}){
  const blockers=[];
  const validPrior=prior?.schema===R35_SOURCE_SCHEMA&&
    prior?.sourcePrsRequired===21&&prior?.observedPrs===21&&
    Array.isArray(prior?.humanSequence)&&prior.humanSequence.length===21&&
    prior.humanSequence.every((x,i)=>x?.order===i+1&&
      Number.isInteger(x?.pr)&&HEX40.test(x.sourceSha||''))&&
    prior.humanSequence.at(-1)?.pr===69&&
    prior.humanSequence.at(-1)?.sourceSha===
      'd1c072296f48047a494de3629fcb6758b8e7216b';
  if(!validPrior)blockers.push('PR_CHAIN_21_INVALID');
  const expectedPr=pr?.number===R35_PIN.pr&&
    pr?.head?.ref===R35_PIN.head&&pr.head.sha===R35_PIN.sha&&
    pr?.base?.ref===R35_PIN.base;
  if(!expectedPr)blockers.push('PR70_HEAD_OR_BASE_DRIFT');
  const jobsOk=R35_PIN.jobs.every(name=>checks.some(x=>x?.name===name&&
    x?.head_sha===R35_PIN.sha&&x?.status==='completed'&&
    x?.conclusion==='success'));
  if(!jobsOk)blockers.push('R35_FIVE_CI_JOBS_NOT_GREEN');
  const ancestor=compare?.status==='ahead'&&compare?.base===R35_PIN.parent&&
    compare?.head===R35_PIN.sha;
  if(!ancestor)blockers.push('R35_PARENT_ANOMALY');
  const tree=commit?.sha===R35_PIN.sha&&
    HEX40.test(commit?.tree?.sha||'')?commit.tree.sha:null;
  if(!tree)blockers.push('R35_TREE_NOT_VERIFIED');
  const mainSha=HEX40.test(prior?.mainSha||'')?prior.mainSha:null;
  const mainTree=mainSha&&mainCommit?.sha===mainSha&&
    HEX40.test(mainCommit?.tree?.sha||'')?mainCommit.tree.sha:null;
  if(!mainTree)blockers.push('MAIN_TREE_UNKNOWN');
  const merged=pr?.merged===true&&pr?.state==='closed'&&
    pr?.draft===false&&Number.isFinite(Date.parse(pr?.merged_at||''));
  if(!merged)blockers.push('PR70_UNMERGED');
  if(prior?.allHumanMerged!==true)blockers.push('EARLIER_SOURCE_PRS_UNMERGED');
  if(!tree||!mainTree||tree!==mainTree)
    blockers.push('SOURCE_NOT_PRESENT_IN_MAIN');
  blockers.push('POST_MERGE_MAIN_CI_MUST_BE_INDEPENDENTLY_RUN');
  const humanSequence=[
    ...(validPrior?prior.humanSequence.map(x=>({
      order:x.order,pr:x.pr,sourceSha:x.sourceSha,
      reviewedAndMerged:x.reviewedAndMerged===true
    })):[]),
    {order:22,pr:R35_PIN.pr,sourceSha:R35_PIN.sha,
      reviewedAndMerged:merged}
  ];
  const pending=humanSequence.find(x=>!x.reviewedAndMerged);
  return {schema:R36_SOURCE_SCHEMA,
    sourcePrsRequired:22,observedPrs:humanSequence.length,
    pinnedSourceHeadSha:R35_PIN.sha,sourceTreeSha:tree,
    sourceCiVerified:jobsOk,sourceAncestryVerified:ancestor,
    humanSequence,firstPendingPr:pending?.pr??null,
    firstPendingExpectedSha:pending?.sourceSha??null,
    allHumanMerged:Boolean(prior?.allHumanMerged&&merged),
    postMergeMainCiVerified:false,mainSha,mainTreeSha:mainTree,
    automaticMergeAllowed:false,productionAuthorized:false,
    guestWritesEnabled:false,changedMain:false,changedProduction:false,
    blockers:[...new Set(blockers)]};
}
/**
 * Correctly apply the *latest* review event for each different login.
 * Older APPROVED followed by DISMISSED/CHANGES_REQUESTED is not approval.
 * A review of any previous commit is stale. GitHub login != real identity.
 */
export function reviewR36FirstPending({source,pr,reviews,checks,
  reviewPagesComplete=false,checksComplete=false}={}){
  const blockers=[];
  const pending=source?.humanSequence?.find(x=>!x.reviewedAndMerged);
  const scope=source?.schema===R36_SOURCE_SCHEMA&&
    source?.sourcePrsRequired===22&&
    Number.isInteger(pending?.pr)&&HEX40.test(pending?.sourceSha||'')&&
    source?.firstPendingPr===pending?.pr;
  if(!scope||pr?.number!==pending?.pr||
    pr?.head?.sha!==pending?.sourceSha||
    pr?.state!=='open'||pr?.merged===true)
    blockers.push('PENDING_PR_CHANGED_OR_CLOSED');
  if(pr?.draft!==false)blockers.push('PR_IS_DRAFT');
  if(reviewPagesComplete!==true)blockers.push('REVIEWS_PAGINATION_INCOMPLETE');
  if(checksComplete!==true)blockers.push('CHECKS_PAGINATION_INCOMPLETE');
  if(!Array.isArray(reviews)||reviews.length>2000)
    blockers.push('REVIEWS_MISSING_OR_TOO_MANY');
  const byLogin=new Map();
  if(Array.isArray(reviews))for(const item of reviews.slice(0,2000)){
    const login=item?.user?.login;
    const submitted=Date.parse(item?.submitted_at||'');
    if(typeof login!=='string'||login.length>80||
      !Number.isFinite(submitted)||item?.state==='PENDING')continue;
    const prev=byLogin.get(login);
    if(!prev||submitted>prev.submitted||
      submitted===prev.submitted&&(item?.id??0)>(prev.id??0)){
      byLogin.set(login,{id:item.id,submitted,
        state:item?.state,commit:item?.commit_id});
    }
  }
  const author=pr?.user?.login;
  const all=[...byLogin].filter(([login])=>login!==author);
  const blockersByReview=all.filter(([,r])=>
    r.state==='CHANGES_REQUESTED');
  if(blockersByReview.length)blockers.push('REVIEW_CHANGES_REQUESTED');
  const current=all.filter(([,r])=>r.state==='APPROVED'&&
    r.commit===pending?.sourceSha);
  if(!current.length)blockers.push('NO_CURRENT_INDEPENDENT_APPROVAL');
  const allChecks=Array.isArray(checks)?checks:[];
  const currentChecks=allChecks.filter(x=>
    x?.head_sha===pending?.sourceSha);
  if(currentChecks.some(x=>x.status!=='completed'))
    blockers.push('PENDING_HEAD_CI_INCOMPLETE');
  if(currentChecks.some(x=>x.status==='completed'&&
    x.conclusion!=='success'))
    blockers.push('PENDING_HEAD_CI_NOT_GREEN');
  if(!currentChecks.some(x=>x.status==='completed'&&
    x.conclusion==='success'))
    blockers.push('NO_SUCCESSFUL_CURRENT_HEAD_CHECK');
  const manualNextAction=pr?.draft===true?'READY_FOR_REVIEW_AFTER_CODE_AUDIT':
    blockersByReview.length?'RESOLVE_CHANGE_REQUESTS':
      !current.length?'REQUEST_INDEPENDENT_APPROVAL':
        blockers.some(x=>x.includes('CI'))?'REPAIR_HEAD_CI':
          'HUMAN_MERGE_DECISION_REQUIRED';
  return {schema:'osmanx.guest.r36.first-human-review.v1',
    firstPendingPr:pending?.pr??null,
    expectedHeadSha:pending?.sourceSha??null,
    currentIndependentApprovals:current.length,
    unresolvedChangeRequests:blockersByReview.length,
    reviewPagesComplete,checksComplete,
    firstReviewAcceptedByGitHub:current.length>0&&blockers.length===0,
    manualNextAction,realWorldReviewerIdentityVerified:false,
    sourceMergedIntoMain:false,automaticMergeAllowed:false,
    productionAuthorized:false,blockers:[...new Set(blockers)]};
}
