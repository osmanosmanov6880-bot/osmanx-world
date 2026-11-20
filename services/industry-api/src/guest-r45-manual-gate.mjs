/**
 * R45: a complete 31-PR (R14..R44) manual release handoff, combining
 * independently observed approval, Git source identity, check-runs and a
 * genuine local merge-tree preview. It never authorizes production/merge.
 */
import {createHash} from 'node:crypto';
import {
 R44_GRAPH_SCHEMA,R44_PINNED_STACK,evaluateR44Reviews
} from './guest-r44-full-chain.mjs';
import {R45_COMPARE_SCHEMA} from './guest-r45-compare-proof.mjs';
import {R45_MERGE_SCHEMA} from './guest-r45-merge-preview.mjs';
import {
 R45_CI_SCHEMA,inspectR45CICoverage
} from './guest-r45-ci-provenance.mjs';
export const R45_GATE_SCHEMA='osmanx.guest.r45.manual-31-pr-handoff.v1';
export const R45_LAST=Object.freeze({
 number:90,base:'feat/guest-r43-locked-supply-chain-review-smoke-20261120',
 head:'feat/guest-r44-complete-review-offline-supply-proof-20261120',
 sha:'18bb8da6ba360a4a54fbd9b4bedb913fb23c1d1c'
});
export const R45_ALL_STACK=Object.freeze([...R44_PINNED_STACK,R45_LAST]);
const SHA=/^[a-f0-9]{40}$/;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const uniq=a=>[...new Set(a)];

export function evaluateR45ManualHandoff({
 r44Report,pr90,review90=[],ciByNumber={},comparisonProof,
 mergePreview,mainAfterFinal
}={}){
 const blockers=[];
 const raw=r44Report&&typeof r44Report==='object'?{...r44Report}:null;
 const claimedHash=raw?.sha256;
 if(raw)delete raw.sha256;
 if(!raw||raw.schema!==R44_GRAPH_SCHEMA||
    claimedHash!==hash(raw)||raw.expectedPrs!==30||
    raw.queue?.length!==30||raw.verifiedSourcePrs!==30)
   blockers.push('R44_COMPLETE_PINNED_SOURCE_EVIDENCE_INVALID');
 const lastSourceValid=pr90?.number===R45_LAST.number&&
   pr90?.state==='open'&&pr90?.merged===false&&
   pr90?.head?.ref===R45_LAST.head&&pr90.head.sha===R45_LAST.sha&&
   pr90?.base?.ref===R45_LAST.base&&SHA.test(pr90.head.sha);
 if(!lastSourceValid)blockers.push('PR90_HEAD_BASE_OR_STATE_DRIFT');
 const review=evaluateR44Reviews(pr90,review90);
 const newReasons=[];
 if(!lastSourceValid)newReasons.push('SOURCE_REF_SHA_STATE_DRIFT');
 if(pr90?.draft!==false)newReasons.push('PR_STILL_DRAFT');
 newReasons.push(...review.reasons);
 const previous=Array.isArray(raw?.queue)?raw.queue.map(x=>({
   number:x.number,pinnedSha:x.pinnedSha,sourceVerified:x.sourceVerified,
   draft:x.draft,independentCurrentShaApproval:x.independentCurrentShaApproval,
   reasons:x.reasons
 })):[];
 const queue=[...previous,{
   number:R45_LAST.number,pinnedSha:R45_LAST.sha,
   sourceVerified:lastSourceValid,draft:pr90?.draft!==false,
   independentCurrentShaApproval:review.approved,
   reasons:uniq(newReasons)
 }];
 if(queue.length!==31||queue.some((q,i)=>q.number!==R45_ALL_STACK[i].number||
   q.pinnedSha!==R45_ALL_STACK[i].sha))
   blockers.push('R45_31_PR_SOURCE_ORDER_INVALID');
 const coverage=inspectR45CICoverage(R45_ALL_STACK,ciByNumber);
 if(!coverage.allCurrentSourceCIValidated)
   blockers.push('NOT_ALL_31_SOURCE_HEADS_HAVE_VERIFIED_GREEN_CHECKS');
 if(queue.some(x=>x.draft))
   blockers.push('DRAFTS_REQUIRE_HUMAN_READY_TRANSITION');
 if(queue.some(x=>!x.independentCurrentShaApproval))
   blockers.push('INDEPENDENT_CURRENT_HEAD_APPROVALS_REQUIRED');
 if(queue.some(x=>!x.sourceVerified))
   blockers.push('SOURCE_GRAPH_DRIFT');
 if(comparisonProof?.schema!==R45_COMPARE_SCHEMA||
   comparisonProof?.evidenceValid!==true||
   comparisonProof?.observedMain!==raw?.mainSha)
   blockers.push('INDEPENDENT_FIRST_SOURCE_COMPARE_UNVERIFIED');
 if(comparisonProof?.needsManualReconciliation!==false)
   blockers.push('FIRST_PR_MAIN_RECONCILIATION_REQUIRED');
 if(mergePreview?.schema!==R45_MERGE_SCHEMA||
   mergePreview?.valid!==true||
   mergePreview?.mainSha!==comparisonProof?.observedMain||
   mergePreview?.sourceSha!==R45_ALL_STACK[0].sha)
   blockers.push('REAL_GIT_MAIN_MERGE_PREVIEW_UNVERIFIED');
 if(mergePreview?.actualConflictCount>0)
   blockers.push('REAL_GIT_CONFLICTS_NEED_MANUAL_RESOLUTION');
 if(!raw?.mainProtectionReadable)
   blockers.push('MAIN_BRANCH_PROTECTION_UNVERIFIED');
 if(!SHA.test(mainAfterFinal||'')||mainAfterFinal!==raw?.mainSha)
   blockers.push('MAIN_CHANGED_DURING_R45_OBSERVATION');
 // Even a fully green source chain is not a current-main post-merge CI.
 blockers.push('HUMAN_MERGES_AND_FRESH_POST_MERGE_MAIN_CI_MISSING');
 blockers.push('REAL_STAGING_OFFSITE_DR_AND_LEGAL_ACCEPTANCE_MISSING');
 const firstManualBlocker=queue.find(x=>
   x.reasons?.length>0||ciByNumber?.[x.number]?.sourceChecksCompleteAndGreen!==true
 )?.number??47;
 const result={
   schema:R45_GATE_SCHEMA,
   expectedSourcePrs:31,verifiedSourcePrs:queue.filter(x=>x.sourceVerified).length,
   independentCurrentHeadApprovals:queue.filter(x=>x.independentCurrentShaApproval).length,
   greenSourceCheckPrs:coverage.greenCurrentHead,
   firstManualBlockerPr:firstManualBlocker,
   currentMainSha:raw?.mainSha||null,
   firstPrBehindMain:comparisonProof?.behindMain??null,
   firstPrAheadMain:comparisonProof?.aheadMain??null,
   comparisonEvidenceValid:comparisonProof?.evidenceValid===true,
   mergePreviewValid:mergePreview?.valid===true,
   mergePreviewConflictCount:mergePreview?.actualConflictCount??null,
   mergeConflictPaths:mergePreview?.conflictPaths||[],
   queue,sourceCI:coverage,
   legacyR44ComparisonStatusIsNotAuthoritative:true,
   blockers:uniq(blockers),
   decisions:{githubReadOnly:true,branchRefWrites:0,
     noAutomaticMerge:true,manualMergeStillPending:true,
     freshPostMergeMainCIConfirmed:false,customerGo:false,
     productionAuthorized:false,customerWritesEnabled:false}
 };
 return {...result,sha256:hash(result)};
}
export function renderR45OperatorHandoff(r){
 if(r?.schema!==R45_GATE_SCHEMA||
   r.decisions?.productionAuthorized!==false||
   r.decisions?.branchRefWrites!==0)
   throw Error('R45 invalid signed-boundary NO-GO');
 const lines=['# OSMANX Guest Intelligence — R45 human release acceptance','',
   'Current main: '+(r.currentMainSha||'UNKNOWN'),
   'Source head SHA matches: '+r.verifiedSourcePrs+'/31',
   'Independent current-head approvals: '+r.independentCurrentHeadApprovals+'/31',
   'Current-source checks all green: '+r.greenSourceCheckPrs+'/31',
   'PR #47 behind/ahead main: '+(r.firstPrBehindMain??'?')+'/'+(r.firstPrAheadMain??'?'),
   'Real git merge-tree conflicts: '+(r.mergePreviewConflictCount??'UNVERIFIED'),
   'First human blocker: PR #'+r.firstManualBlockerPr,'',
   '## Read-only conflict preview',
   ...(r.mergeConflictPaths.length?r.mergeConflictPaths.map(p=>'- '+p):
     ['No named conflicts in proven preview; all other gates still apply.']),
   '','## Review & verification queue'];
 for(const q of r.queue)
   lines.push('- #'+q.number+' | '+q.pinnedSha+
     ' | source '+(q.sourceVerified?'PINNED':'DRIFT')+
     ' | '+(q.draft?'DRAFT':'READY')+
     ' | independent approval '+(q.independentCurrentShaApproval?'YES':'NO')+
     ' | current SHA CI '+(r.sourceCI.checks.find(c=>c.number===q.number)?.green?'GREEN':'UNVERIFIED')+
     ' | '+(q.reasons||[]).join(', '));
 lines.push('','## Manual-only sequence',
   '1. Inspect PR #47 against fresh main, independently review real merge conflicts and agree a non-destructive reconciliation commit.',
   '2. Obtain separate human approval for every relevant CURRENT PR head. Never treat bot/self review or old head approval as valid.',
   '3. Keep ordered source commits pinned. Review and merge R14–R44 dependencies one by one only with the repository owner and required protected-branch checks.',
   '4. Re-run full CI on fresh MAIN after the human merges. Source-branch green checks do not count as post-merge evidence.',
   '5. Independently witness staging, external disaster recovery and legal/consent acceptance before any customer write or STOP lift.',
   '','## Explicit NO-GO blockers',...r.blockers.map(s=>'- '+s),'',
   '**NO AUTOMATIC MERGE. NO PRODUCTION. NO CUSTOMER WRITES.**','');
 return lines.join('\n');
}
