import test from 'node:test';
import assert from 'node:assert/strict';
import {R28_PR,evaluateR29SourceTree,R29_CHAIN_SCHEMA}
  from '../scripts/r29-source-tree.mjs';
import {runR29StagingRehearsal}
  from '../src/guest-r29-staging.mjs';
import {evaluateR29Rollback,R29_ROLLBACK_ORDER}
  from '../src/guest-r29-rollback.mjs';
import {buildR27SyntheticCase,runR27FirstClientRehearsal}
  from '../src/guest-r27-rehearsal.mjs';
import {makeR27Handoff} from '../src/guest-r27-handoff.mjs';
import {evaluateR28ManualGate} from '../src/guest-r28-stage-gate.mjs';
import {makeR28OperatorPacket} from '../src/guest-r28-operator-packet.mjs';
import {makeR29Report,verifyR29Report,r29ReportCsv}
  from '../src/guest-r29-report.mjs';
const now=new Date('2026-11-19T12:00:00.000Z');
function packet(){
 const {r24,r25,r26,decision}=buildR27SyntheticCase('normal');
 const handoff=makeR27Handoff({
   r24,r25,r26,audit:decision,
   rehearsal:runR27FirstClientRehearsal(),now
 });
 return makeR28OperatorPacket({
   handoff,gate:evaluateR28ManualGate({handoff,now}),now
 });
}
function fixture(){
 return {
   previous:{mainComparison:{mainSha:'a'.repeat(40)}},
   r28:{number:R28_PR.number,head:{ref:R28_PR.head,sha:R28_PR.sha},
     base:{ref:R28_PR.base},draft:true,state:'open',merged:false},
   checks:R28_PR.requiredJobs.map(name=>({
     name,head_sha:R28_PR.sha,status:'completed',conclusion:'success'
   })),
   compare:{base:R28_PR.parent,head:R28_PR.sha,status:'ahead'},
   sourceCommit:{sha:R28_PR.sha,tree:{sha:'b'.repeat(40)}},
   mainCommit:{sha:'a'.repeat(40),tree:{sha:'c'.repeat(40)}},
   mainComparison:{base:'a'.repeat(40),head:R28_PR.sha,status:'ahead'}
 };
}
test('R29 exact 15 PRs: source CI green does not prove merged main TREE identical',()=>{
 const result=evaluateR29SourceTree(fixture());
 assert.equal(result.schema,R29_CHAIN_SCHEMA);
 assert.deepEqual(result.humanMergeSequence.map(x=>x.pr),
  [47,48,49,51,52,53,54,55,56,57,58,59,60,61,62]);
 assert.equal(result.sourcePrCount,15);
 assert.equal(result.dependencies.at(-1).ciPassed,true);
 assert.equal(result.sourceTreeEqualsMain,false);
 assert.equal(result.freshMainCiPassed,false);
 assert.equal(result.productionAuthorized,false);
 assert.ok(result.blockers.includes('MERGED_MAIN_TREE_NOT_EQUAL_TO_SOURCE'));
 const changed=fixture();changed.r28.head.sha='f'.repeat(40);
 assert.ok(evaluateR29SourceTree(changed).blockers.includes('R28_PR_HEAD_CHANGED'));
 const noCi=fixture();noCi.checks.pop();
 assert.ok(evaluateR29SourceTree(noCi).blockers.includes('R28_REQUIRED_NAMED_CI_MISSING'));
 const noAncestor=fixture();noAncestor.compare.status='diverged';
 assert.ok(evaluateR29SourceTree(noAncestor).blockers.includes('R28_PARENT_ANCESTRY_CHANGED'));
});
test('R29 staging tests six synthetic paths and real live host is never contacted',()=>{
 const a=runR29StagingRehearsal(),b=runR29StagingRehearsal();
 assert.deepEqual(a,b);
 assert.equal(a.passedCases,6,JSON.stringify(a.cases));
 assert.equal(a.allPassed,true);
 assert.equal(a.realHostContacted,false);
 assert.equal(a.actualStagingHostProbed,false);
 assert.equal(a.productionAuthorized,false);
 assert.ok(a.cases.filter(x=>!x.expectedHealthy).length>=4);
});
test('R29 rollback denies illegal transitions, wrong identities and unfinished evidence',()=>{
 const rel='a'.repeat(64),restore='b'.repeat(64);
 const roles={STOPPED:'owner',ROLLBACK_DRY_RUN:'manager',
   RECOVERED_OFFLINE:'recovery',INDEPENDENT_REVIEW:'auditor',CLOSED:'owner'};
 const opts={expectedReleaseSha:rel,expectedRestoreSha:restore};
 const good=R29_ROLLBACK_ORDER.map(stage=>({
   stage,operatorRole:roles[stage],releaseSha:rel,restoreSha:restore
 }));
 const yes=evaluateR29Rollback({...opts,steps:good});
 assert.equal(yes.syntheticPathComplete,true);
 assert.equal(yes.completedSteps,5);
 assert.equal(yes.remoteRollbackExecuted,false);
 assert.equal(yes.productionAuthorized,false);
 assert.equal(evaluateR29Rollback({...opts,steps:good.slice(1)})
   .syntheticPathComplete,false);
 assert.equal(evaluateR29Rollback({...opts,
   steps:[{...good[0],operatorRole:'manager'}]})
   .syntheticPathComplete,false);
 assert.equal(evaluateR29Rollback({...opts,
   steps:[{...good[0],releaseSha:'c'.repeat(64)}]})
   .syntheticPathComplete,false);
});
test('R29 report binds R28 SHA, strict 10m TTL, synthetic vs real status and NO-GO',()=>{
 const r28=packet(),report=makeR29Report({r28,now});
 assert.equal(report.stagedSynthetic.passed,6);
 assert.equal(report.actualStagingVerified,false);
 assert.equal(report.verifiedSourcePrsInApi,0);
 assert.equal(report.productionAuthorized,false);
 assert.equal(report.blockers.includes('R29_REAL_STAGING_ORIGIN_NOT_PROBED'),true);
 assert.equal(verifyR29Report(report,{now,pilotId:r28.pilotId}).valid,true);
 assert.equal(verifyR29Report({...report,productionAuthorized:true},{now}).valid,false);
 assert.equal(verifyR29Report({...report,blockers:[]},{now}).valid,false);
 assert.equal(verifyR29Report({...report,clientEmail:'x@example.com'},{now}).valid,false);
 assert.equal(verifyR29Report(report,{now:new Date(now.getTime()+10*60000)}).valid,false);
 const csv=r29ReportCsv(report,{now});
 assert.ok(csv.startsWith('\uFEFF'));
 assert.equal(csv.includes('x@example.com'),false);
});
