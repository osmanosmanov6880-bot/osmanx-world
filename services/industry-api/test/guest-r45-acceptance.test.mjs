import test from 'node:test';
import assert from 'node:assert/strict';
import {
 R44_PINNED_STACK,evaluateR44FullChain
} from '../src/guest-r44-full-chain.mjs';
import {
 R45_FIRST,verifyR45FirstComparison
} from '../src/guest-r45-compare-proof.mjs';
import {assessR45MergeTree} from '../src/guest-r45-merge-preview.mjs';
import {
 inspectR45CurrentShaChecks,inspectR45CICoverage
} from '../src/guest-r45-ci-provenance.mjs';
import {
 R45_ALL_STACK,R45_LAST,evaluateR45ManualHandoff,
 renderR45OperatorHandoff
} from '../src/guest-r45-manual-gate.mjs';
const mainSha='a'.repeat(40);
const treeSha='b'.repeat(40);
const before={ref:'refs/heads/main',object:{sha:mainSha}};
const comp=()=>({status:'diverged',ahead_by:4,behind_by:8,
 base_commit:{sha:mainSha}});
const firstCommit={sha:R45_FIRST.sha};
function compare(){
 return verifyR45FirstComparison({mainBefore:before,mainAfter:structuredClone(before),
   comparison:comp(),firstCommit});
}
const clean=()=>assessR45MergeTree({mainSha,exitCode:0,stdout:treeSha+'\n'});
const conflicted=()=>assessR45MergeTree({mainSha,exitCode:1,
 stdout:treeSha+'\nservices/industry-api/ops/build-release.sh\n'});
const reportFor=expected=>inspectR45CurrentShaChecks({
 prNumber:expected.number,expectedSha:expected.sha,
 response:{total_count:1,check_runs:[{
   id:10,name:'unit-tests',app:{slug:'github-actions'},
   head_sha:expected.sha,status:'completed',conclusion:'success'
 }]}
});
function r44Fixture(){
 const prs=R44_PINNED_STACK.map(x=>({
   number:x.number,state:'open',merged:false,draft:true,
   base:{ref:x.base},head:{ref:x.head,sha:x.sha},
   user:{login:'osmanosmanov6880-bot'}
 }));
 return evaluateR44FullChain({
   prs,reviewsByNumber:Object.fromEntries(prs.map(p=>[p.number,[]])),
   mainBefore:before,mainAfter:structuredClone(before),
   compare:{...comp(),head_commit:{sha:R45_FIRST.sha}},
   protection:{status:403,data:null}
 });
}
const pr90=()=>({number:90,state:'open',merged:false,draft:true,
 base:{ref:R45_LAST.base},head:{ref:R45_LAST.head,sha:R45_LAST.sha},
 user:{login:'osmanosmanov6880-bot'}});
function manual(args={}){
 return evaluateR45ManualHandoff({
   r44Report:r44Fixture(),pr90:pr90(),review90:[],
   ciByNumber:Object.fromEntries(R45_ALL_STACK.map(x=>[x.number,reportFor(x)])),
   comparisonProof:compare(),mergePreview:conflicted(),
   mainAfterFinal:mainSha,...args
 });
}
test('R45 independent SHA proof tolerates optional missing compare head',()=>{
 const r=compare();
 assert.equal(r.evidenceValid,true,JSON.stringify(r.blockers));
 assert.equal(r.behindMain,8);
 assert.equal(r.aheadMain,4);
 assert.equal(r.needsManualReconciliation,true);
 assert.equal(r.productionAuthorized,false);
});
test('R45 independent SHA proof rejects fake identity, contradictory compare and main movement',()=>{
 const wrong=verifyR45FirstComparison({mainBefore:before,
   mainAfter:structuredClone(before),comparison:{
     ...comp(),head_commit:{sha:'f'.repeat(40)}
   },firstCommit});
 assert.ok(wrong.blockers.includes('COMPARE_REPORTED_DIFFERENT_HEAD_COMMIT'));
 const missing=verifyR45FirstComparison({mainBefore:before,
   mainAfter:structuredClone(before),comparison:comp(),firstCommit:{}});
 assert.equal(missing.evidenceValid,false);
 const moved=verifyR45FirstComparison({mainBefore:before,
   mainAfter:{ref:'refs/heads/main',object:{sha:'c'.repeat(40)}},
   comparison:comp(),firstCommit});
 assert.equal(moved.evidenceValid,false);
 const contradiction=verifyR45FirstComparison({mainBefore:before,
   mainAfter:structuredClone(before),comparison:{
     ...comp(),status:'identical'
   },firstCommit});
 assert.equal(contradiction.evidenceValid,false);
});
test('R45 Git merge-tree clean and real-conflict output is parsed without merge authorization',()=>{
 const a=clean(),b=conflicted();
 assert.equal(a.valid,true,JSON.stringify(a.blockers));
 assert.equal(a.conflictFreePreview,true);
 assert.equal(a.productionAuthorized,false);
 assert.equal(b.valid,true,JSON.stringify(b.blockers));
 assert.equal(b.humanReconcileRequired,true);
 assert.deepEqual(b.conflictPaths,['services/industry-api/ops/build-release.sh']);
 assert.equal(b.actualConflictCount,1);
 assert.equal(b.branchRefsChanged,false);
});
test('R45 refuses ambiguous, malicious, missing and wrong source merge proof',()=>{
 const missing=assessR45MergeTree({mainSha,exitCode:1,stdout:treeSha+'\n'});
 assert.equal(missing.valid,false);
 const traversal=assessR45MergeTree({mainSha,exitCode:1,
   stdout:treeSha+'\n../etc/passwd\n'});
 assert.equal(traversal.valid,false);
 const spoof=assessR45MergeTree({mainSha,sourceSha:'c'.repeat(40),
   exitCode:0,stdout:treeSha+'\n'});
 assert.equal(spoof.valid,false);
 const error=assessR45MergeTree({mainSha,exitCode:128,stdout:'fatal: corrupt'});
 assert.equal(error.valid,false);
});
test('R45 GitHub Actions checks require exact SHA, complete paging and no skipped jobs',()=>{
 const p=R45_ALL_STACK[0],ok=reportFor(p);
 assert.equal(ok.sourceChecksCompleteAndGreen,true);
 assert.equal(ok.productionAuthorized,false);
 const wrong=inspectR45CurrentShaChecks({prNumber:p.number,
   expectedSha:p.sha,response:{total_count:1,check_runs:[{
     id:10,name:'tests',app:{slug:'github-actions'},
     head_sha:'f'.repeat(40),status:'completed',conclusion:'success'
   }]}});
 assert.equal(wrong.sourceChecksCompleteAndGreen,false);
 const pending=inspectR45CurrentShaChecks({prNumber:p.number,
   expectedSha:p.sha,response:{total_count:1,check_runs:[{
     id:10,name:'tests',app:{slug:'github-actions'},
     head_sha:p.sha,status:'completed',conclusion:'skipped'
   }]}});
 assert.equal(pending.sourceChecksCompleteAndGreen,false);
 const paged=inspectR45CurrentShaChecks({prNumber:p.number,
   expectedSha:p.sha,response:{total_count:101,check_runs:[]}});
 assert.equal(paged.sourceChecksCompleteAndGreen,false);
 const empty=inspectR45CurrentShaChecks({prNumber:p.number,
   expectedSha:p.sha,response:{total_count:0,check_runs:[]}});
 assert.equal(empty.sourceChecksCompleteAndGreen,false);
});
test('R45 CI coverage spans exactly 31 pinned PR commits',()=>{
 assert.equal(R45_ALL_STACK.length,31);
 assert.equal(R45_ALL_STACK[0].number,47);
 assert.equal(R45_ALL_STACK.at(-1).number,90);
 const reports=Object.fromEntries(R45_ALL_STACK.map(p=>[p.number,reportFor(p)]));
 const result=inspectR45CICoverage(R45_ALL_STACK,reports);
 assert.equal(result.greenCurrentHead,31);
 assert.equal(result.allCurrentSourceCIValidated,true);
 delete reports[47];
 assert.equal(inspectR45CICoverage(R45_ALL_STACK,reports).allCurrentSourceCIValidated,false);
});
test('R45 joint human packet shows first actual blocker, conflicts and post-merge NO-GO',()=>{
 const r=manual();
 assert.equal(r.expectedSourcePrs,31);
 assert.equal(r.verifiedSourcePrs,31);
 assert.equal(r.greenSourceCheckPrs,31);
 assert.equal(r.independentCurrentHeadApprovals,0);
 assert.equal(r.firstManualBlockerPr,47);
 assert.equal(r.firstPrBehindMain,8);
 assert.equal(r.mergePreviewConflictCount,1);
 assert.equal(r.decisions.productionAuthorized,false);
 assert.match(renderR45OperatorHandoff(r),/NO AUTOMATIC MERGE/);
 assert.match(renderR45OperatorHandoff(r),/build-release.sh/);
});
test('R45 packet refuses tampered R44 proof, drift PR90 and inconsistent main snapshot',()=>{
 const raw=r44Fixture();
 const tainted=structuredClone(raw);tainted.mainSha='f'.repeat(40);
 assert.ok(manual({r44Report:tainted}).blockers.includes(
   'R44_COMPLETE_PINNED_SOURCE_EVIDENCE_INVALID'));
 const moving=pr90();moving.head.sha='f'.repeat(40);
 assert.equal(manual({pr90:moving}).verifiedSourcePrs,30);
 const stale=manual({mainAfterFinal:'d'.repeat(40)});
 assert.ok(stale.blockers.includes('MAIN_CHANGED_DURING_R45_OBSERVATION'));
 const wrongPreview=clean();
 wrongPreview.mainSha='c'.repeat(40);
 assert.ok(manual({mergePreview:wrongPreview}).blockers.includes(
   'REAL_GIT_MAIN_MERGE_PREVIEW_UNVERIFIED'));
});
test('R45 all-green source checks never prove production, protected main or staging',()=>{
 const r=manual();
 assert.equal(r.greenSourceCheckPrs,31);
 assert.equal(r.decisions.freshPostMergeMainCIConfirmed,false);
 assert.equal(r.decisions.noAutomaticMerge,true);
 assert.equal(r.decisions.customerWritesEnabled,false);
 assert.equal(r.blockers.includes('HUMAN_MERGES_AND_FRESH_POST_MERGE_MAIN_CI_MISSING'),true);
});
