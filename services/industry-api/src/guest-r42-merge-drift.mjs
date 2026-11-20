/**
 * R42 inspect the ACTUAL moving main branch vs pinned PR #47 before asking
 * independent humans to review. "GitHub says clean" is NOT branch-protection
 * or external production permission.
 */
export const R42_MERGE_SCHEMA='osmanx.guest.r42.first-pr-main-drift.v1';
const HEAD='840bb083e606058a9a32450f3b3a3e881a34891e';
const SHA=/^[a-f0-9]{40}$/;
export function inspectR42Merge({pr,mainRef,compare,protection,
  mainAfter}={}){
  const blockers=[];
  const main=mainRef?.object?.sha;
  const validSource=pr?.number===47&&pr?.state==='open'&&pr?.merged===false&&
    pr?.head?.sha===HEAD&&pr?.base?.ref==='main'&&SHA.test(main||'');
  if(!validSource)blockers.push('FIRST_PR_HEAD_OR_MAIN_DRIFT');
  if(mainAfter?.object?.sha!==main)
    blockers.push('MAIN_CHANGED_DURING_GITHUB_CHECK');
  const comparisonValid=compare&&
    ['ahead','behind','diverged','identical'].includes(compare.status)&&
    compare?.base_commit?.sha===main&&
    compare?.head_commit?.sha===HEAD&&
    Number.isSafeInteger(compare.ahead_by)&&compare.ahead_by>=0&&
    Number.isSafeInteger(compare.behind_by)&&compare.behind_by>=0&&
    Number.isSafeInteger(compare.total_commits)&&
    compare.total_commits>=0;
  if(!comparisonValid)blockers.push('INCOMPLETE_MAIN_TO_SOURCE_COMPARISON');
  const ahead=comparisonValid?compare.ahead_by:null,
    behind=comparisonValid?compare.behind_by:null;
  if(behind!==0)blockers.push('SOURCE_BRANCH_BEHIND_MAIN_MANUAL_UPDATE_REQUIRED');
  if(ahead===0)blockers.push('NO_PENDING_FIRST_PR_COMMITS');
  if(pr?.draft!==false)blockers.push('FIRST_PR_STILL_DRAFT');
  if(pr?.mergeable!==true||pr?.mergeable_state!=='clean')
    blockers.push('GITHUB_MERGEABILITY_NOT_CLEAN');
  // 403 or missing protection means an UNVERIFIED external dependency.
  const policy=protection?.status===200?protection.data:null;
  const rule=policy?.required_pull_request_reviews;
  const approvals=rule?.required_approving_review_count;
  const branchRulesObserved=Number.isSafeInteger(approvals)&&approvals>=1&&
    policy?.enforce_admins?.enabled===true;
  if(!branchRulesObserved)blockers.push('BRANCH_PROTECTION_NOT_INDEPENDENTLY_VERIFIED');
  blockers.push('INDEPENDENT_REVIEW_MISSING_OR_NOT_ATTESTED');
  const canHandOffToReviewer=validSource&&comparisonValid&&
    mainAfter?.object?.sha===main;
  return {schema:R42_MERGE_SCHEMA,
    pinnedFirstPr:47,pinnedHead:HEAD,observedMainSha:SHA.test(main||'')?main:null,
    prRecordedBaseSha:SHA.test(pr?.base?.sha||'')?pr.base.sha:null,
    firstPrAheadCommits:ahead,firstPrBehindCommits:behind,
    githubMergeableObserved:pr?.mergeable===true&&pr?.mergeable_state==='clean',
    branchProtectionReadable:protection?.status===200,
    minimumHumanApprovalsObserved:branchRulesObserved?approvals:null,
    sourceDivergedFromMain:comparisonValid&&behind>0,
    canHandOffToReviewer,canMergeNow:false,
    changedMain:false,automaticMergeAllowed:false,customerGo:false,
    productionAuthorized:false,
    blockers:[...new Set(blockers)]};
}
