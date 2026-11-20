/**
 * Require independent review on exact current PR head, and fail closed
 * when either pages are incomplete or reviewer has an active change request.
 * A GitHub login != an external proof of reviewer identity.
 */
export const R38_REVIEW_SCHEMA='osmanx.guest.r38.first-review-policy.v1';
export function evaluateR38CurrentReview({pr,reviews=[],
  reviewsComplete=false,checks=[],checksComplete=false,
  requiredHead,requiredNumber=47}={}){
  const reasons=[];
  if(pr?.number!==requiredNumber||pr?.head?.sha!==requiredHead||
    pr?.state!=='open'||pr?.merged===true||pr?.draft!==false)
    reasons.push('PR_NOT_READY_ON_PINNED_HEAD');
  if(!reviewsComplete||!checksComplete||
    !Array.isArray(reviews)||!Array.isArray(checks))
    reasons.push('INCOMPLETE_GITHUB_EVIDENCE');
  const byUser=new Map();
  for(const review of Array.isArray(reviews)?reviews:[]){
    if(!review?.user?.login||review?.state==='PENDING')continue;
    const timestamp=Date.parse(review.submitted_at||'');
    if(!Number.isFinite(timestamp))continue;
    const old=byUser.get(review.user.login);
    if(!old||timestamp>old.time||(timestamp===old.time&&
      (review.id||0)>(old.id||0)))
      byUser.set(review.user.login,{time:timestamp,
        id:review.id||0,state:review.state,commit:review.commit_id});
  }
  let independent=0,blocking=0;
  for(const [login,item] of byUser){
    if(login===pr?.user?.login)continue;
    if(item.state==='CHANGES_REQUESTED')blocking++;
    if(item.state==='APPROVED'&&item.commit===requiredHead)independent++;
  }
  if(blocking)reasons.push('UNRESOLVED_CHANGES_REQUESTED');
  if(!independent)reasons.push('NO_INDEPENDENT_APPROVAL_ON_HEAD');
  if(!Array.isArray(checks)||!checks.length||
    checks.some(c=>c?.head_sha!==requiredHead||
      c.status!=='completed'||c.conclusion!=='success'))
    reasons.push('CURRENT_HEAD_CHECKS_NOT_GREEN');
  return {schema:R38_REVIEW_SCHEMA,pr:requiredNumber,
    reviewSignalComplete:reasons.length===0,
    currentHeadApprovalCount:independent,
    outstandingChangeRequestCount:blocking,
    humanSecurityReviewCompleted:false,
    branchProtectionVerified:false,
    mergePermissionGranted:false,
    productionAuthorized:false,blockers:[...new Set(reasons)]};
}
