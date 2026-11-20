/**
 * R46 two-independent-human reviewer policy. No approval is invented, and a
 * trusted allowlist must be supplied by the repository owner out of band.
 */
import {createHash} from 'node:crypto';
import {R46_PINNED_STACK,R46_GRAPH_SCHEMA} from './guest-r46-source-graph.mjs';
import {R46_DRIFT_SCHEMA} from './guest-r46-first-drift.mjs';
import {R46_VIRTUAL_SCHEMA} from './guest-r46-virtual-merge.mjs';
import {inspectR45CurrentShaChecks} from './guest-r45-ci-provenance.mjs';

export const R46_REVIEW_SCHEMA='osmanx.guest.r46.current-human-review-and-manual-queue.v1';
const SHA=/^[a-f0-9]{40}$/;
const LOGIN=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const unique=x=>[...new Set(x)];
const date=s=>typeof s==='string'&&Number.isFinite(Date.parse(s));

export function inspectR46HumanReviews({pr,reviews,trustedReviewers=[],expected}={}){
 const reasons=[];
 if(!expected||!Number.isInteger(expected.number)||
   pr?.number!==expected.number||pr?.head?.sha!==expected.sha||
   pr?.head?.ref!==expected.head||pr?.base?.ref!==expected.base||
   pr?.state!=='open'||pr.merged!==false)
   reasons.push('PR_IDENTITY_OR_BASE_DRIFT');
 if(pr?.draft!==false)reasons.push('PR_REMAINS_DRAFT');
 if(!Array.isArray(trustedReviewers)||trustedReviewers.length<2||
   trustedReviewers.length>50||
   trustedReviewers.some(x=>!LOGIN.test(x))||
   new Set(trustedReviewers.map(x=>x.toLowerCase())).size!==trustedReviewers.length)
   reasons.push('TWO_TRUSTED_REVIEWER_IDENTITIES_NOT_CONFIGURED');
 if(!Array.isArray(reviews)||reviews.length>=100)
   reasons.push('INCOMPLETE_OR_UNTRUSTED_REVIEW_PAGINATION');
 const sorted=[];
 for(const r of Array.isArray(reviews)?reviews:[]){
   if(!r||!LOGIN.test(r.user?.login||'')||
     !date(r.submitted_at)||!Number.isSafeInteger(r.id)||
     !['APPROVED','CHANGES_REQUESTED','DISMISSED','COMMENTED','PENDING'].includes(r.state)){
     reasons.push('REVIEW_DATE_ACTOR_OR_STATE_UNTRUSTED');
   }else sorted.push(r);
 }
 sorted.sort((a,b)=>Date.parse(a.submitted_at)-Date.parse(b.submitted_at)||
   a.id-b.id);
 const last=new Map();
 for(const r of sorted){
   if(['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(r.state))
     last.set(r.user.login.toLowerCase(),r);
 }
 const trusted=new Set(Array.isArray(trustedReviewers)?
   trustedReviewers.filter(x=>LOGIN.test(x)).map(x=>x.toLowerCase()):[]);
 const accepted=[];
 let activeChangeRequests=0;
 for(const [login,r] of last){
   if(login===pr?.user?.login?.toLowerCase()||
     r.user?.type==='Bot'||login.endsWith('[bot]'))continue;
   if(r.state==='CHANGES_REQUESTED'){
     activeChangeRequests++;reasons.push('ACTIVE_CHANGES_REQUESTED');
   }
   if(r.state!=='APPROVED')continue;
   if(r.commit_id!==expected?.sha){
     reasons.push('OLD_SOURCE_SHA_APPROVAL');
     continue;
   }
   if(!trusted.has(login)){
     reasons.push('APPROVAL_FROM_UNTRUSTED_REVIEWER');
     continue;
   }
   accepted.push(r.user.login);
 }
 if(accepted.length<2)reasons.push('FEWER_THAN_TWO_INDEPENDENT_CURRENT_HEAD_APPROVALS');
 return {prNumber:expected?.number??null,expectedSha:expected?.sha??null,
   valid:reasons.length===0,approvedHumanCount:accepted.length,
   approvedHumanLogins:accepted.sort(),activeChangeRequests,
   trustedListProvided:trusted.size>=2,automaticApprovalCalls:0,
   productionAuthorized:false,reasons:unique(reasons)};
}

export function assessR46ManualQueue({
 graph,prList,reviewsByPr,checksByPr,trustedReviewers=[],
 drift,virtualMerge,protectionStatus=0,mainFinally
}={}){
 const blockers=[];
 if(graph?.schema!==R46_GRAPH_SCHEMA||graph?.checked!==32||
   graph?.matchingSourceHeads!==32||graph?.blockers?.length)
   blockers.push('EXACT_32_SOURCE_GRAPH_UNVERIFIED');
 if(drift?.schema!==R46_DRIFT_SCHEMA||!drift?.valid||
   drift.mainSha!==graph?.mainSha)
   blockers.push('PR47_MAIN_DRIFT_PROOF_INVALID');
 if(virtualMerge?.schema!==R46_VIRTUAL_SCHEMA||!virtualMerge?.valid||
   virtualMerge.mainSha!==graph?.mainSha)
   blockers.push('32_STAGE_VIRTUAL_REHEARSAL_UNVERIFIED');
 if(virtualMerge?.firstBlockedPr)
   blockers.push('VIRTUAL_MERGE_HALTED_AT_PR_'+virtualMerge.firstBlockedPr);
 if(graph?.mainSha!==mainFinally||!SHA.test(mainFinally||''))
   blockers.push('MAIN_CHANGED_DURING_EVIDENCE_COLLECTION');
 if(protectionStatus!==200)
   blockers.push('MAIN_PROTECTION_RULES_UNAVAILABLE');
 const prs=new Map((Array.isArray(prList)?prList:[]).map(x=>[x.number,x]));
 const queue=[];
 for(const expected of R46_PINNED_STACK){
   const p=prs.get(expected.number);
   const review=inspectR46HumanReviews({
     pr:p,reviews:reviewsByPr?.[expected.number],
     trustedReviewers,expected
   });
   const ci=inspectR45CurrentShaChecks({
     prNumber:expected.number,expectedSha:expected.sha,
     response:checksByPr?.[expected.number]
   });
   if(!ci.sourceChecksCompleteAndGreen)
     blockers.push('SOURCE_CI_UNVERIFIED_PR_'+expected.number);
   queue.push({number:expected.number,sha:expected.sha,
     sourceMatch:!!p&&p.head?.sha===expected.sha,
     draft:p?.draft!==false,review,ciGreen:ci.sourceChecksCompleteAndGreen,
     ciBlockers:ci.blockers,
     readyForManualMerge:false});
 }
 const firstBlocker=queue.find(x=>
   !x.sourceMatch||x.draft||!x.review.valid||!x.ciGreen)?.number??47;
 if(queue.some(x=>x.draft))blockers.push('DRAFT_PRS_REQUIRE_HUMAN_READY_TRANSITION');
 if(queue.some(x=>!x.review.valid))
   blockers.push('TWO_TRUSTED_CURRENT_HEAD_APPROVALS_MISSING');
 blockers.push('HUMAN_MERGES_NOT_EXECUTED');
 blockers.push('FRESH_POST_MERGE_MAIN_CI_NOT_EXECUTED');
 blockers.push('REAL_STAGING_OFFSITE_RECOVERY_LEGAL_GATE_UNVERIFIED');
 const base={
   schema:R46_REVIEW_SCHEMA,expectedPrs:32,
   pinnedPrsVerified:graph?.matchingSourceHeads??0,
   sourceCIGreen:queue.filter(x=>x.ciGreen).length,
   doubleIndependentApprovals:queue.filter(x=>x.review.valid).length,
   firstManualBlockerPr:firstBlocker,
   observedMain:graph?.mainSha??null,
   firstPrOverlapFiles:drift?.overlappingFiles??[],
   firstPrMainOverlapCount:drift?.overlapCount??null,
   previewCompleteWithoutConflicts:virtualMerge?.completeWithoutGitConflicts===true,
   virtualRehearsedPrs:virtualMerge?.successfullyRehearsed??0,
   firstVirtualConflictPr:virtualMerge?.firstBlockedPr??null,
   branchProtectionReadable:protectionStatus===200,
   queue,blockers:unique(blockers),
   actions:{githubMutationCalls:0,realMergeCommitsCreated:0,
     humanReviewRequired:true,automaticMergeAllowed:false,
     productionAuthorized:false,customerGo:false,stopLifted:false}
 };
 return {...base,sha256:hash(base)};
}

export function renderR46ReviewerPacket(report){
 if(report?.schema!==R46_REVIEW_SCHEMA||
   report.actions?.githubMutationCalls!==0||
   report.actions?.productionAuthorized!==false)
   throw Error('R46 invalid no-go reviewer packet');
 const lines=['# OSMANX Guest Intelligence R46 — manual review packet','',
   'Current pinned main: '+(report.observedMain||'UNVERIFIED'),
   '32 exact source commits: '+report.pinnedPrsVerified+'/32',
   'Current source CI success: '+report.sourceCIGreen+'/32',
   'Two independent trusted approvals per PR: '+
     report.doubleIndependentApprovals+'/32',
   'Temporary full-stack Git rehearsal: '+
     report.virtualRehearsedPrs+'/32',
   'First virtual conflict: '+(report.firstVirtualConflictPr??'none reported'),
   'First manual-review blocker: PR #'+report.firstManualBlockerPr,
   'PR47 touched by intervening main: '+
     (report.firstPrMainOverlapCount??'unverified')+' files','',
   '## R14 files touched on main since divergence',
   ...(report.firstPrOverlapFiles.length?
     report.firstPrOverlapFiles.map(x=>'- '+x):
     ['No file overlap was reported; this alone is not a merge approval.']),
   '','## Required 32-PR independent review'];
 for(const item of report.queue)
   lines.push('- PR #'+item.number+' | '+item.sha+
     ' | source '+(item.sourceMatch?'PINNED':'DRIFT')+
     ' | '+(item.draft?'DRAFT':'READY')+
     ' | 2 independent approvals '+(item.review.valid?'VERIFIED':'MISSING')+
     ' | source CI '+(item.ciGreen?'PASS':'UNVERIFIED')+
     ' | '+item.review.reasons.join(', '));
 lines.push('','## Human-only sequence',
   '1. An independent authorized reviewer first inspects PR #47 full patch and the exact changed main files.',
   '2. If main moved, re-run the 32-stage rehearsal; create only separately reviewed reconciliation commits on an authorized branch.',
   '3. Configure and verify trusted human reviewer identities; obtain two distinct current-head approvals per PR.',
   '4. A repository owner checks branch protection and manually merges PRs in dependency order; never auto-merge.',
   '5. After manual merges, demand NEW main CI, live staging, offsite DR and legal acceptance before writes.',
   '','## Release blockers',...report.blockers.map(x=>'- '+x),'',
   '**NO APPROVALS, NO MERGES, NO PRODUCTION, NO CUSTOMER WRITES were performed by R46.**','');
 return lines.join('\n');
}
