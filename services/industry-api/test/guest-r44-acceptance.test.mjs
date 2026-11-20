import test from 'node:test';
import assert from 'node:assert/strict';
import {
 R44_PINNED_STACK,evaluateR44Reviews,evaluateR44FullChain,renderR44ReviewerMarkdown
} from '../src/guest-r44-full-chain.mjs';
import {verifyR44NpmAudit} from '../src/guest-r44-npm-audit.mjs';
const sha='a'.repeat(40);
function fixture(){
 const prs=R44_PINNED_STACK.map(x=>({
   number:x.number,state:'open',merged:false,draft:true,
   base:{ref:x.base},head:{ref:x.head,sha:x.sha},
   user:{login:'osmanosmanov6880-bot'}
 }));
 const mainBefore={ref:'refs/heads/main',object:{sha}};
 return {prs,reviewsByNumber:Object.fromEntries(prs.map(x=>[x.number,[]])),
   mainBefore,mainAfter:structuredClone(mainBefore),
   compare:{base_commit:{sha},head_commit:{sha:R44_PINNED_STACK[0].sha},
     behind_by:1,ahead_by:3,status:'diverged'},
   protection:{status:403,data:null}};
}
function audit(){
 return {auditReportVersion:2,metadata:{vulnerabilities:{
   info:0,low:0,moderate:0,high:0,critical:0,total:0
 }},vulnerabilities:{}};
}
test('R44 pins the entire 30 PR stack from R14 through R43',()=>{
 assert.equal(R44_PINNED_STACK.length,30);
 assert.equal(R44_PINNED_STACK[0].number,47);
 assert.equal(R44_PINNED_STACK.at(-1).number,84);
 assert.equal(R44_PINNED_STACK[0].base,'main');
 for(let i=1;i<R44_PINNED_STACK.length;i++)
   assert.equal(R44_PINNED_STACK[i].base,R44_PINNED_STACK[i-1].head);
 const out=evaluateR44FullChain(fixture());
 assert.equal(out.verifiedSourcePrs,30);
 assert.equal(out.firstManualBlockerPr,47);
 assert.equal(out.decisions.productionAuthorized,false);
 assert.equal(out.decisions.githubWrites,0);
 assert.equal(out.mainProtectionReadable,false);
 assert.match(renderR44ReviewerMarkdown(out),/NO AUTOMATIC MERGE/);
});
test('R44 refuses a drifting head, duplicate PR, missing PR, or changed main',()=>{
 const drift=fixture();drift.prs[10].head.sha='f'.repeat(40);
 assert.equal(evaluateR44FullChain(drift).verifiedSourcePrs,29);
 const duplicate=fixture();duplicate.prs[1].number=duplicate.prs[0].number;
 assert.ok(evaluateR44FullChain(duplicate).blockers.includes('DUPLICATE_OR_INVALID_PR_NUMBER'));
 const missing=fixture();missing.prs.pop();
 assert.ok(evaluateR44FullChain(missing).blockers.includes('NOT_ALL_30_PR_RESPONSES_RECEIVED'));
 const moved=fixture();moved.mainAfter.object.sha='b'.repeat(40);
 assert.ok(evaluateR44FullChain(moved).blockers.includes('MAIN_MOVED_OR_UNVERIFIED'));
});
test('R44 current head approval must be independent, not dismissed or stale',()=>{
 const p=fixture().prs[0];p.draft=false;
 const approval=(state,commit,id,login='reviewer')=>({
   id,state,commit_id:commit,submitted_at:'2026-11-20T12:00:00Z',
   user:{login,type:'User'}
 });
 assert.equal(evaluateR44Reviews(p,[approval('APPROVED',p.head.sha,1)]).approved,true);
 assert.equal(evaluateR44Reviews(p,[approval('APPROVED','f'.repeat(40),1)]).approved,false);
 assert.equal(evaluateR44Reviews(p,[approval('APPROVED',p.head.sha,1,'osmanosmanov6880-bot')]).approved,false);
 const changed=approval('CHANGES_REQUESTED',p.head.sha,2);
 changed.submitted_at='2026-11-20T12:02:00Z';
 assert.equal(evaluateR44Reviews(p,[approval('APPROVED',p.head.sha,1),changed]).approved,false);
 const dismissed=approval('DISMISSED',p.head.sha,3);
 dismissed.submitted_at='2026-11-20T12:03:00Z';
 assert.equal(evaluateR44Reviews(p,[approval('APPROVED',p.head.sha,1),dismissed]).approved,false);
});
test('R44 npm audit refuses false zero, conflicting total and malformed records',()=>{
 assert.equal(verifyR44NpmAudit(audit()).valid,true);
 const concealed=audit();
 concealed.metadata.vulnerabilities.high=1;
 assert.equal(verifyR44NpmAudit(concealed).valid,false);
 assert.ok(verifyR44NpmAudit(concealed).blockers.includes('AUDIT_TOTAL_DOES_NOT_MATCH_SEVERITY_COUNTERS'));
 const incomplete=audit();incomplete.metadata.vulnerabilities.total=1;
 assert.equal(verifyR44NpmAudit(incomplete).valid,false);
 const bad=audit();bad.vulnerabilities.fastify={severity:'critical'};
 assert.equal(verifyR44NpmAudit(bad).valid,false);
 const advisory=audit();advisory.metadata.vulnerabilities.total=1;
 advisory.metadata.vulnerabilities.critical=1;
 advisory.vulnerabilities.fastify={severity:'critical',via:[],effects:[],
   nodes:['node_modules/fastify'],isDirect:true};
 assert.equal(verifyR44NpmAudit(advisory).valid,false);
 assert.ok(verifyR44NpmAudit(advisory).blockers.includes(
   'UNRESOLVED_HIGH_OR_CRITICAL_ADVISORIES'));
});
test('R44 supply gate remains NO-GO even if point-in-time audit is clean',()=>{
 const ok=verifyR44NpmAudit(audit());
 assert.equal(ok.valid,true);
 assert.equal(ok.snapshotOnly,true);
 assert.equal(ok.customerGo,false);
 assert.equal(ok.productionAuthorized,false);
});
