import test from 'node:test';
import assert from 'node:assert/strict';
import {
 R46_PINNED_STACK,assessR46SourceGraph
} from '../src/guest-r46-source-graph.mjs';
import {
 R46_R14_FILES,assessR46FirstDrift
} from '../src/guest-r46-first-drift.mjs';
import {assessR46VirtualMerge} from '../src/guest-r46-virtual-merge.mjs';
import {
 inspectR46HumanReviews,assessR46ManualQueue,
 renderR46ReviewerPacket
} from '../src/guest-r46-reviewer-gate.mjs';
import {collectR46Review} from '../scripts/r46-live-handoff.mjs';
const main='9'.repeat(40),virtualCommit='a'.repeat(40),tree='b'.repeat(40);
const mainRef={ref:'refs/heads/main',object:{sha:main}};
const prs=()=>R46_PINNED_STACK.map(x=>({
 number:x.number,state:'open',merged:false,draft:true,
 head:{ref:x.head,sha:x.sha},base:{ref:x.base},user:{login:'owner'}
}));
const graph=()=>assessR46SourceGraph({prs:prs(),
 mainBefore:mainRef,mainAfter:structuredClone(mainRef)});
const drift=()=>assessR46FirstDrift({mergeBaseSha:'c'.repeat(40),
 mainSha:main,sourceChangedPaths:[...R46_R14_FILES],
 mainChangedPaths:['README.md','services/industry-api/ops/build-release.sh']});
const steps=()=>{
 let parent=main;
 return R46_PINNED_STACK.map(x=>{
   const r={number:x.number,sourceSha:x.sha,baseBefore:parent,
     treeSha:tree,mergeExitCode:0,conflictPaths:[],
     syntheticCommit:virtualCommit};
   parent=virtualCommit;
   return r;
 });
};
const vmerge=()=>assessR46VirtualMerge({mainSha:main,steps:steps(),
 branchRefsBefore:'d'.repeat(64),branchRefsAfter:'d'.repeat(64)});
const trusted=['reviewer-one','reviewer-two'];
const approval=(login,id,sha=R46_PINNED_STACK[0].sha,state='APPROVED',
 submitted='2026-11-20T14:00:00Z')=>({
 id,submitted_at:submitted,state,commit_id:sha,user:{login,type:'User'}
});
const check=x=>({total_count:1,check_runs:[{
 id:123,name:'unit',app:{slug:'github-actions'},
 head_sha:x.sha,status:'completed',conclusion:'success'
}]});
const checks=()=>Object.fromEntries(R46_PINNED_STACK.map(x=>[x.number,check(x)]));
const reviews=()=>Object.fromEntries(R46_PINNED_STACK.map(x=>[x.number,[]]));

test('R46 pins exactly 32 linked PRs R14 through R45, zero source mutations',()=>{
 assert.equal(R46_PINNED_STACK.length,32);
 assert.deepEqual([R46_PINNED_STACK[0].number,R46_PINNED_STACK.at(-1).number],[47,94]);
 for(let i=1;i<R46_PINNED_STACK.length;i++)
   assert.equal(R46_PINNED_STACK[i].base,R46_PINNED_STACK[i-1].head);
 const r=graph();
 assert.equal(r.matchingSourceHeads,32);
 assert.deepEqual(r.blockers,[]);
 assert.equal(r.githubWrites,0);
 assert.equal(r.productionAuthorized,false);
});
test('R46 source graph refuses duplicate, missing, altered refs and moving main',()=>{
 const fake=prs();fake[2].head.sha='0'.repeat(40);
 const a=assessR46SourceGraph({prs:fake,
   mainBefore:mainRef,mainAfter:mainRef});
 assert.equal(a.matchingSourceHeads,31);
 const b=assessR46SourceGraph({prs:prs().slice(1),
   mainBefore:mainRef,mainAfter:mainRef});
 assert.ok(b.blockers.includes('SOURCE_PR_COUNT_NOT_32'));
 const c=prs();c[1].number=c[0].number;
 assert.ok(assessR46SourceGraph({prs:c,mainBefore:mainRef,mainAfter:mainRef})
   .blockers.includes('DUPLICATE_OR_MISSING_PR_ID'));
 const moved={ref:'refs/heads/main',object:{sha:'1'.repeat(40)}};
 assert.ok(assessR46SourceGraph({prs:prs(),
   mainBefore:mainRef,mainAfter:moved}).blockers.includes(
   'CURRENT_MAIN_SHA_CHANGED_OR_UNVERIFIED'));
});
test('R46 PR47 patch proof identifies exactly ten files and main overlap',()=>{
 const r=drift();
 assert.equal(r.valid,true,JSON.stringify(r.blockers));
 assert.equal(r.sourceFilesVerified,10);
 assert.equal(r.overlapCount,1);
 assert.deepEqual(r.overlappingFiles,[
   'services/industry-api/ops/build-release.sh'
 ]);
 assert.equal(r.productionAuthorized,false);
});
test('R46 drift fail-closes on patch expansion, duplicates or unsafe paths',()=>{
 const extra=assessR46FirstDrift({mergeBaseSha:main,mainSha:main,
   sourceChangedPaths:[...R46_R14_FILES,'unexpected.exe'],mainChangedPaths:[]});
 assert.equal(extra.valid,false);
 const dup=assessR46FirstDrift({mergeBaseSha:main,mainSha:main,
   sourceChangedPaths:[...R46_R14_FILES],
   mainChangedPaths:['readme.md','readme.md']});
 assert.equal(dup.valid,false);
 const attack=assessR46FirstDrift({mergeBaseSha:main,mainSha:main,
   sourceChangedPaths:[...R46_R14_FILES],mainChangedPaths:['../secret']});
 assert.equal(attack.valid,false);
});
test('R46 all 32 virtual Git merges can be validated without branch writes',()=>{
 const r=vmerge();
 assert.equal(r.valid,true,JSON.stringify(r.blockers));
 assert.equal(r.evaluatedPrs,32);
 assert.equal(r.successfullyRehearsed,32);
 assert.equal(r.completeWithoutGitConflicts,true);
 assert.equal(r.branchRefsModified,false);
 assert.equal(r.actualGitBranchMergesExecuted,0);
 assert.equal(r.productionAuthorized,false);
});
test('R46 virtual preview halts exactly at first conflict and preserves NO-GO',()=>{
 const p=steps().slice(0,8);
 p.at(-1).mergeExitCode=1;
 p.at(-1).conflictPaths=['services/industry-api/ops/verify-release.sh'];
 p.at(-1).syntheticCommit=null;
 const r=assessR46VirtualMerge({mainSha:main,steps:p,
   branchRefsBefore:'d'.repeat(64),branchRefsAfter:'d'.repeat(64)});
 assert.equal(r.valid,true,JSON.stringify(r.blockers));
 assert.equal(r.firstBlockedPr,R46_PINNED_STACK[7].number);
 assert.equal(r.successfullyRehearsed,7);
 assert.equal(r.completeWithoutGitConflicts,false);
 assert.equal(r.productionAuthorized,false);
});
test('R46 rejects continued execution after conflict and path traversal',()=>{
 const a=steps().slice(0,3);
 a[1].mergeExitCode=1;
 a[1].conflictPaths=['README.md'];
 a[1].syntheticCommit=null;
 assert.equal(assessR46VirtualMerge({mainSha:main,steps:a,
   branchRefsBefore:'d'.repeat(64),branchRefsAfter:'d'.repeat(64)}).valid,false);
 const b=steps().slice(0,2);
 b[1].mergeExitCode=1;
 b[1].conflictPaths=['../etc/passwd'];
 b[1].syntheticCommit=null;
 assert.equal(assessR46VirtualMerge({mainSha:main,steps:b,
   branchRefsBefore:'d'.repeat(64),branchRefsAfter:'d'.repeat(64)}).valid,false);
});
test('R46 refuses modified refs, switched source or missing synthetic commit',()=>{
 const mutated=assessR46VirtualMerge({mainSha:main,steps:steps(),
   branchRefsBefore:'d'.repeat(64),branchRefsAfter:'e'.repeat(64)});
 assert.equal(mutated.valid,false);
 const spoof=steps();spoof[1].sourceSha='0'.repeat(40);
 assert.equal(assessR46VirtualMerge({mainSha:main,steps:spoof,
   branchRefsBefore:'d'.repeat(64),branchRefsAfter:'d'.repeat(64)}).valid,false);
 const missing=steps();missing[3].syntheticCommit=null;
 assert.equal(assessR46VirtualMerge({mainSha:main,steps:missing,
   branchRefsBefore:'d'.repeat(64),branchRefsAfter:'d'.repeat(64)}).valid,false);
});
test('R46 requires two trusted non-author reviewers on CURRENT SHA',()=>{
 const p=prs()[0];p.draft=false;
 const valid=inspectR46HumanReviews({pr:p,expected:R46_PINNED_STACK[0],
   trustedReviewers:trusted,
   reviews:[approval('reviewer-one',1),approval('reviewer-two',2)]});
 assert.equal(valid.valid,true,JSON.stringify(valid.reasons));
 assert.equal(valid.approvedHumanCount,2);
 assert.equal(valid.automaticApprovalCalls,0);
 const absent=inspectR46HumanReviews({pr:p,expected:R46_PINNED_STACK[0],
   reviews:[approval('reviewer-one',1),approval('reviewer-two',2)]});
 assert.equal(absent.valid,false);
 assert.ok(absent.reasons.includes('TWO_TRUSTED_REVIEWER_IDENTITIES_NOT_CONFIGURED'));
});
test('R46 rejects old approval, author approval, bot and pending requests',()=>{
 const p=prs()[0];p.draft=false;
 const stale=inspectR46HumanReviews({pr:p,expected:R46_PINNED_STACK[0],
   trustedReviewers:trusted,reviews:[
     approval('reviewer-one',1,'0'.repeat(40)),approval('reviewer-two',2)
   ]});
 assert.equal(stale.valid,false);
 const owner=inspectR46HumanReviews({pr:p,expected:R46_PINNED_STACK[0],
   trustedReviewers:['owner','reviewer-two'],
   reviews:[approval('owner',1),approval('reviewer-two',2)]});
 assert.equal(owner.valid,false);
 const bot=approval('reviewer-one',1);bot.user.type='Bot';
 assert.equal(inspectR46HumanReviews({pr:p,expected:R46_PINNED_STACK[0],
   trustedReviewers:trusted,reviews:[bot,approval('reviewer-two',2)]}).valid,false);
 const request=approval('reviewer-one',3,undefined,'CHANGES_REQUESTED',
   '2026-11-20T14:10:00Z');
 assert.equal(inspectR46HumanReviews({pr:p,expected:R46_PINNED_STACK[0],
   trustedReviewers:trusted,reviews:[
     approval('reviewer-one',1),approval('reviewer-two',2),request
   ]}).valid,false);
});
test('R46 dismissed later review revokes earlier approval',()=>{
 const p=prs()[0];p.draft=false;
 const revoked=inspectR46HumanReviews({pr:p,expected:R46_PINNED_STACK[0],
   trustedReviewers:trusted,reviews:[
     approval('reviewer-one',1),approval('reviewer-two',2),
     approval('reviewer-one',3,undefined,'DISMISSED',
       '2026-11-20T14:20:00Z')
   ]});
 assert.equal(revoked.valid,false);
 assert.equal(revoked.approvedHumanCount,1);
});
test('R46 integrated handoff reports 32 green source CI but ZERO authority',()=>{
 const result=assessR46ManualQueue({graph:graph(),prList:prs(),reviewsByPr:reviews(),
   checksByPr:checks(),trustedReviewers:trusted,drift:drift(),
   virtualMerge:vmerge(),protectionStatus:403,mainFinally:main});
 assert.equal(result.pinnedPrsVerified,32);
 assert.equal(result.sourceCIGreen,32);
 assert.equal(result.doubleIndependentApprovals,0);
 assert.equal(result.firstManualBlockerPr,47);
 assert.equal(result.previewCompleteWithoutConflicts,true);
 assert.equal(result.actions.automaticMergeAllowed,false);
 assert.ok(result.blockers.includes('DRAFT_PRS_REQUIRE_HUMAN_READY_TRANSITION'));
 assert.ok(result.blockers.includes('TWO_TRUSTED_CURRENT_HEAD_APPROVALS_MISSING'));
 assert.equal(result.actions.customerGo,false);
 assert.match(renderR46ReviewerPacket(result),/NO APPROVALS, NO MERGES/);
});
test('R46 rejects stale main and failed per-source CI evidence',()=>{
 const x=checks();x[47]={total_count:0,check_runs:[]};
 const result=assessR46ManualQueue({graph:graph(),prList:prs(),
   reviewsByPr:reviews(),checksByPr:x,trustedReviewers:trusted,
   drift:drift(),virtualMerge:vmerge(),protectionStatus:403,
   mainFinally:'2'.repeat(40)});
 assert.equal(result.sourceCIGreen,31);
 assert.ok(result.blockers.includes('SOURCE_CI_UNVERIFIED_PR_47'));
 assert.ok(result.blockers.includes('MAIN_CHANGED_DURING_EVIDENCE_COLLECTION'));
});
test('R46 mocked GitHub collector uses GET only and refuses unreadable protection',async()=>{
 const localDrift=drift(),localVirtual=vmerge();
 let count=0;
 const indexed=new Map(R46_PINNED_STACK.map((x,i)=>[x.number,i]));
 const fetched=async(url,options)=>{
   count++;
   assert.equal(options.method,'GET');
   const path=new URL(url).pathname;
   const asJson=(x,status=200)=>({ok:status===200,status,json:async()=>x});
   if(path.endsWith('/git/ref/heads/main'))return asJson(mainRef);
   if(path.endsWith('/branches/main/protection'))return asJson({},403);
   const m=path.match(/\/pulls\/(\d+)(\/reviews)?$/);
   if(m){
     const n=Number(m[1]),idx=indexed.get(n);
     if(idx===undefined)throw Error('Unexpected PR number');
     return asJson(m[2]?[]:prs()[idx]);
   }
   const c=path.match(/\/commits\/([0-9a-f]{40})\/check-runs$/);
   if(c){
     const expected=R46_PINNED_STACK.find(x=>x.sha===c[1]);
     if(!expected)throw Error('Unexpected SHA');
     return asJson(check(expected));
   }
   throw Error('Unexpected GitHub GET '+path);
 };
 const result=await collectR46Review({
   fetcher:fetched,token:'test-token',trustedReviewers:trusted,
   drift:localDrift,virtualMerge:localVirtual
 });
 assert.equal(result.githubMutationCalls,0);
 assert.equal(result.githubReadCalls,99);
 assert.equal(result.graph.matchingSourceHeads,32);
 assert.equal(result.report.actions.productionAuthorized,false);
 assert.equal(result.report.branchProtectionReadable,false);
 assert.equal(count,99);
});
