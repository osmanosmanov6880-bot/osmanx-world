/**
 * R47: comprehensive first-human-review packet for PR #47.
 * Never interprets source checks or conflict-free Git as approval.
 */
import {createHash} from 'node:crypto';
import {R47_FIRST_PR,R47_SOURCE_SCHEMA} from './guest-r47-source-pins.mjs';
import {R47_CANARY_SCHEMA} from './guest-r47-canary-policy.mjs';
import {R47_CHECK_SCHEMA} from './guest-r47-first-checks.mjs';
import {R45_MERGE_SCHEMA} from './guest-r45-merge-preview.mjs';
import {R45_COMPARE_SCHEMA} from './guest-r45-compare-proof.mjs';
import {inspectR46HumanReviews} from './guest-r46-reviewer-gate.mjs';
export const R47_REVIEW_SCHEMA='osmanx.guest.r47.first-independent-manual-review.v1';
const SHA=/^[0-9a-f]{40}$/;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const UNIQUE=x=>[...new Set(x)];
const CHECKLIST=Object.freeze([
 ['.github/workflows/guest-r14-operations.yml','Confirm workflow is exercised at exact PR #47 SHA, without production side effects'],
 ['docs/GUEST_INTELLIGENCE_R14.md','Verify operational limits, independent owners and no unapproved customer writes'],
 ['services/industry-api/ops/build-release.sh','Check source archive cannot import secrets and release manifest ties to a real revision'],
 ['services/industry-api/ops/compose.r14.yml','Review resolved local port, isolated DB/network, no worker, guest writes permanently false'],
 ['services/industry-api/ops/r14-canary.sh','Check private env path, local Docker context, explicit acknowledgement and stop without volume deletion'],
 ['services/industry-api/ops/verify-release.sh','Check tar and checksum validation, path traversal rejection and archive size bounds'],
 ['services/industry-api/scripts/r14-admission.mjs','Verify independent Ed25519 trust anchors and no automatic production write enable'],
 ['services/industry-api/scripts/r14-incident.mjs','Confirm incident counters never clear STOP or automatically resume onboarding'],
 ['services/industry-api/scripts/r14-monitor.mjs','Check GET-only, no cookies/redirects and private routes return 401'],
 ['services/industry-api/test/guest-r14.test.mjs','Verify negative tests for auth privacy, signatures, canary and incident transitions']
]);

export function assessR47FirstHandoff({
 pr,reviews=[],trustedReviewers=[],sourcePins,canary,checks,
 compareProof,mergeProof,currentComposeMatchesFirstPr,
 currentComposeSha,mainFinal,branchProtectionStatus=0,
 protectionData=null
}={}){
 const blockers=[];
 const matches=pr?.number===47&&pr?.state==='open'&&
   pr?.merged===false&&pr?.head?.ref===R47_FIRST_PR.head&&
   pr?.base?.ref==='main'&&pr?.head?.sha===R47_FIRST_PR.sha;
 if(!matches)blockers.push('FIRST_PR_REFS_OR_COMMIT_DRIFT');
 if(sourcePins?.schema!==R47_SOURCE_SCHEMA||
   sourcePins.exactHistoricalBytesVerified!==true)
   blockers.push('R14_TEN_FILE_BYTES_NOT_VERIFIED');
 if(canary?.schema!==R47_CANARY_SCHEMA||canary.canaryTopologySafe!==true)
   blockers.push('R14_EFFECTIVE_CANARY_NOT_ISOLATED');
 if(currentComposeMatchesFirstPr===false)
   blockers.push('LATER_BRANCH_CANARY_COMPOSE_DIFF_NEEDS_HUMAN_REVIEW');
 if(checks?.schema!==R47_CHECK_SCHEMA||checks.requiredCheckPolicyPassed!==true||
   checks.sha!==R47_FIRST_PR.sha)
   blockers.push('R14_REQUIRED_OPS_CONTRACT_NOT_VERIFIED');
 const compareVerified=compareProof?.schema===R45_COMPARE_SCHEMA&&
   compareProof.evidenceValid===true&&
   compareProof.pinnedHead===R47_FIRST_PR.sha&&
   SHA.test(compareProof.observedMain||'');
 if(!compareVerified)blockers.push('CURRENT_MAIN_COMPARE_NOT_VERIFIED');
 if(!SHA.test(mainFinal||'')||mainFinal!==compareProof?.observedMain)
   blockers.push('MAIN_CHANGED_DURING_REVIEW');
 const mergeVerified=mergeProof?.schema===R45_MERGE_SCHEMA&&
   mergeProof.valid===true&&
   mergeProof.sourceSha===R47_FIRST_PR.sha&&
   mergeProof.mainSha===compareProof?.observedMain;
 if(!mergeVerified)blockers.push('REAL_GIT_MERGE_PREVIEW_UNVERIFIED');
 if(mergeProof?.conflictFreePreview!==true)
   blockers.push('PR47_GIT_CONFLICTS_OR_UNKNOWN');
 if(compareProof?.behindMain!==0)
   blockers.push('PR47_MUST_BE_RECONCILED_WITH_CURRENT_MAIN');
 const expected={...R47_FIRST_PR};
 const human=inspectR46HumanReviews({pr,reviews,trustedReviewers,expected});
 if(!human.valid)
   blockers.push('TWO_CURRENT_HEAD_INDEPENDENT_APPROVALS_ABSENT');
 if(pr?.draft!==false)blockers.push('PR47_STILL_DRAFT');
 // API 200 is not enough: explicitly inspect minimum review and strict CI
 // protection. Unknown rulesets / other policies still need owner review.
 const reviewMinimum=protectionData?.required_pull_request_reviews?.
   required_approving_review_count;
 const strictCI=protectionData?.required_status_checks?.strict;
 const protectionReadable=branchProtectionStatus===200&&
   protectionData&&typeof protectionData==='object';
 if(!protectionReadable)blockers.push('BRANCH_PROTECTION_UNREADABLE');
 else if(!Number.isSafeInteger(reviewMinimum)||reviewMinimum<2||
   strictCI!==true)
   blockers.push('EXPECTED_TWO_APPROVAL_STRICT_CI_POLICY_NOT_PROVEN');
 blockers.push('NO_REAL_HUMAN_MERGE_OR_FRESH_MAIN_CI');
 blockers.push('NO_STAGING_DR_LEGAL_OPERATOR_ACCEPTANCE');
 const record={
   schema:R47_REVIEW_SCHEMA,firstPr:47,
   pinnedSourceSha:R47_FIRST_PR.sha,
   mainSha:compareProof?.observedMain||null,
   firstPrAheadMain:compareProof?.aheadMain??null,
   firstPrBehindMain:compareProof?.behindMain??null,
   pinnedTenFilesVerified:sourcePins?.exactHistoricalBytesVerified===true,
   realCanaryTopologyValidated:canary?.canaryTopologySafe===true,
   laterCandidateComposeBlob:typeof currentComposeSha==='string'?
     currentComposeSha:null,
   candidateComposeMatchesHistorical:currentComposeMatchesFirstPr===true,
   requiredExactShaCIGreen:checks?.requiredCheckPolicyPassed===true,
   verifiedMergePreview:mergeVerified,
   firstMergeConflictPaths:mergeProof?.conflictPaths||[],
   humanReviewedApproved:human.valid,
   humanReviewReasons:human.reasons,
   branchProtectionReadable:!!protectionReadable,
   reviewerChecklist:CHECKLIST.map(([path,question])=>({path,reviewQuestion:question,reviewedByHuman:false})),
   manualSequence:[
     'Independent humans inspect every one of the ten PR47 files and its operational constraints',
     'Check all branch policies and other applicable repo/org rulesets manually',
     'Reconcile PR47 with current main in a separately reviewed branch, never rewrite historic pins silently',
     'Re-run source and complete CI on the reconciled current commit; collect two independent approvals',
     'Authorized owner manually merges only with protected-branch policy satisfied',
     'Re-run complete CI on resulting main SHA, then independent staging, offsite DR and lawful acceptance'
   ],
   blockers:UNIQUE(blockers),
   githubMutationCalls:0,manualMergePerformed:false,
   productionAuthorized:false,customerGo:false,guestWritesEnabled:false
 };
 return {...record,sha256:digest(record)};
}
export function renderR47HumanPacket(r){
 if(r?.schema!==R47_REVIEW_SCHEMA||r.productionAuthorized!==false||
   r.githubMutationCalls!==0)throw Error('R47 reviewer evidence invalid');
 return [
   '# OSMANX Guest Intelligence — R47 independent PR #47 handoff','',
   'First PR SHA: '+r.pinnedSourceSha,
   'Current main SHA: '+(r.mainSha||'UNKNOWN'),
   'PR47 ahead/behind current main: '+(r.firstPrAheadMain??'?')+
     '/'+(r.firstPrBehindMain??'?'),
   'Ten historical blobs verified: '+r.pinnedTenFilesVerified,
   'R14 resolved canary topology safe: '+r.realCanaryTopologyValidated,
   'Current candidate Compose equals historical PR47: '+
     r.candidateComposeMatchesHistorical,
   'Required R14 ops-contract current-SHA CI: '+r.requiredExactShaCIGreen,
   'Git merger preview independently checked: '+r.verifiedMergePreview,
   'Two independent current-SHA human approvals: '+r.humanReviewedApproved,
   'Branch protection readable: '+r.branchProtectionReadable,'',
   '## Exact ten-file review checklist',
   ...r.reviewerChecklist.map(x=>'- [ ] '+x.path+' — '+x.reviewQuestion),'',
   '## Human-only sequence',...r.manualSequence.map((x,i)=>(i+1)+'. '+x),
   '','## Current NO-GO blockers',...r.blockers.map(x=>'- '+x),'',
   '**No human approval, real merge, deployment, STOP lift, or customer writes were performed.**',''
 ].join('\n');
}
