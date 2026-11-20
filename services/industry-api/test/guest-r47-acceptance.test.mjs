import test from 'node:test';
import assert from 'node:assert/strict';
import {R47_FIRST_PR,R47_SOURCE_FILES,assessR47SourcePins}
  from '../src/guest-r47-source-pins.mjs';
import {assessR47ResolvedCanary}
  from '../src/guest-r47-canary-policy.mjs';
import {assessR47FirstChecks}
  from '../src/guest-r47-first-checks.mjs';
import {assessR47FirstHandoff,renderR47HumanPacket}
  from '../src/guest-r47-review-packet.mjs';
import {assessR45MergeTree}
  from '../src/guest-r45-merge-preview.mjs';
import {verifyR45FirstComparison}
  from '../src/guest-r45-compare-proof.mjs';
import {collectR47FirstReview}
  from '../scripts/r47-first-review.mjs';
const source=R47_FIRST_PR.sha,main='a'.repeat(40),tree='b'.repeat(40);
const pins=()=>assessR47SourcePins({commitSha:source,
   blobShaByPath:{...R47_SOURCE_FILES},
   changedPaths:Object.keys(R47_SOURCE_FILES)});
const serviceBase=()=>({
   networks:{r14_private:null},
   security_opt:['no-new-privileges:true'],
   privileged:false
});
const compose=()=>({
 name:'osmanx-guest-r14-canary',
 networks:{r14_private:{driver:'bridge',name:'test_r14_private'}},
 volumes:{guest_r14_data:{name:'test_guest_r14_data'}},
 services:{
   api:{...serviceBase(),
     ports:[{host_ip:'127.0.0.1',published:'3150',target:3047,
       protocol:'tcp'}],
     environment:{GUEST_WRITES_ENABLED:'false',NODE_ENV:'production'},
     read_only:true,tmpfs:['/tmp'],
     depends_on:{db:{condition:'service_healthy'}}},
   db:{...serviceBase(),image:'postgres:16',
     volumes:[{type:'volume',source:'guest_r14_data',
       target:'/var/lib/postgresql/data'}]},
   provision:{...serviceBase(),profiles:['setup'],restart:'no'},
   migrate:{...serviceBase(),profiles:['setup'],restart:'no'},
   bootstrap:{...serviceBase(),profiles:['setup'],restart:'no'}
 }
});
const checks=()=>assessR47FirstChecks({total_count:1,
 check_runs:[{id:11,name:'ops-contract',head_sha:source,
   status:'completed',conclusion:'success',app:{slug:'github-actions'}}]});
const pr=()=>({number:47,state:'open',merged:false,draft:true,
 head:{sha:source,ref:R47_FIRST_PR.head},
 base:{ref:'main'},user:{login:'owner'}});
const mainRef=()=>({ref:'refs/heads/main',object:{sha:main}});
const comp=()=>verifyR45FirstComparison({
 mainBefore:mainRef(),mainAfter:mainRef(),
 firstCommit:{sha:source},
 comparison:{base_commit:{sha:main},status:'diverged',
   ahead_by:4,behind_by:10}
});
const merge=()=>assessR45MergeTree({
 mainSha:main,sourceSha:source,exitCode:0,stdout:tree+'\n'
});
const handoff=({patchPr=pr(),reviews=[],humanTrust=[],
  changedCompose=compose(),changedChecks=checks(),
  changedCompare=comp(),changedMerge=merge(),
  protectionStatus=403,protection=null}={})=>
 assessR47FirstHandoff({
 pr:patchPr,reviews,trustedReviewers:humanTrust,
 sourcePins:pins(),canary:assessR47ResolvedCanary(changedCompose),
 checks:changedChecks,compareProof:changedCompare,mergeProof:changedMerge,
 mainFinal:main,branchProtectionStatus:protectionStatus,
 protectionData:protection
 });
test('R47 ten historical PR47 blobs and exact changed-path inventory must match',()=>{
 const report=pins();
 assert.equal(report.exactHistoricalBytesVerified,true,report.blockers.join(';'));
 assert.equal(report.filesExpected,10);
 assert.equal(report.blobMatches,10);
 assert.equal(report.independentSecurityReviewCompleted,false);
 const drift={...R47_SOURCE_FILES,
   'services/industry-api/ops/compose.r14.yml':'c'.repeat(40)};
 assert.equal(assessR47SourcePins({commitSha:source,blobShaByPath:drift,
   changedPaths:Object.keys(R47_SOURCE_FILES)}).exactHistoricalBytesVerified,false);
});
test('R47 rejects extra, duplicated and missing PR47 paths',()=>{
 const actual={...R47_SOURCE_FILES};
 assert.equal(assessR47SourcePins({commitSha:source,blobShaByPath:actual,
   changedPaths:[...Object.keys(actual),'malicious.sh']}).changedPathsVerified,false);
 assert.equal(assessR47SourcePins({commitSha:source,blobShaByPath:actual,
   changedPaths:Object.keys(actual).slice(1)}).exactHistoricalBytesVerified,false);
 assert.equal(assessR47SourcePins({commitSha:'f'.repeat(40),
   blobShaByPath:actual,changedPaths:Object.keys(actual)}).exactHistoricalBytesVerified,false);
});
test('R47 resolved Compose config is strictly isolated and writes are off',()=>{
 const good=assessR47ResolvedCanary(compose());
 assert.equal(good.canaryTopologySafe,true,good.blockers.join(';'));
 assert.equal(good.loopbackOnly,true);
 assert.equal(good.productionAuthorized,false);
});
test('R47 refuses public port, guest writes, extra worker, privileged mode',()=>{
 const publicPort=compose();publicPort.services.api.ports[0].host_ip='0.0.0.0';
 assert.equal(assessR47ResolvedCanary(publicPort).canaryTopologySafe,false);
 const writes=compose();writes.services.api.environment.GUEST_WRITES_ENABLED='true';
 assert.equal(assessR47ResolvedCanary(writes).canaryTopologySafe,false);
 const worker=compose();worker.services.worker=serviceBase();
 assert.equal(assessR47ResolvedCanary(worker).canaryTopologySafe,false);
 const privileged=compose();privileged.services.db.privileged=true;
 assert.equal(assessR47ResolvedCanary(privileged).canaryTopologySafe,false);
});
test('R47 refuses external network, mounted external data and missing no-new-privileges',()=>{
 const net=compose();net.networks.r14_private.external=true;
 assert.equal(assessR47ResolvedCanary(net).canaryTopologySafe,false);
 const volume=compose();volume.volumes.guest_r14_data.external=true;
 assert.equal(assessR47ResolvedCanary(volume).canaryTopologySafe,false);
 const missing=compose();missing.services.api.security_opt=[];
 assert.equal(assessR47ResolvedCanary(missing).canaryTopologySafe,false);
 const anonymous=compose();anonymous.services.api.ports=[];
 assert.equal(assessR47ResolvedCanary(anonymous).canaryTopologySafe,false);
});
test('R47 ops-contract required on exact PR47 commit; no substitute check',()=>{
 assert.equal(checks().requiredCheckPolicyPassed,true);
 const other=assessR47FirstChecks({total_count:1,check_runs:[{
   id:1,name:'other-check',head_sha:source,app:{slug:'github-actions'},
   status:'completed',conclusion:'success'
 }]});
 assert.equal(other.requiredCheckPolicyPassed,false);
 assert.ok(other.blockers.includes('REQUIRED_R14_OPS_CONTRACT_NOT_GREEN'));
});
test('R47 fails on skipped, stale, pending and paginated GitHub Checks',()=>{
 const base={id:1,name:'ops-contract',head_sha:source,
   app:{slug:'github-actions'},status:'completed',conclusion:'success'};
 for(const bad of [
   {...base,conclusion:'skipped'},
   {...base,status:'in_progress',conclusion:null},
   {...base,head_sha:'c'.repeat(40)}
 ]){
   const report=assessR47FirstChecks({total_count:1,check_runs:[bad]});
   assert.equal(report.requiredCheckPolicyPassed,false);
 }
 assert.equal(assessR47FirstChecks({total_count:101,
   check_runs:[base]}).requiredCheckPolicyPassed,false);
});
test('R47 reviewer packet is NO-GO without actual independent approvals',()=>{
 const h=handoff();
 assert.equal(h.pinnedTenFilesVerified,true);
 assert.equal(h.realCanaryTopologyValidated,true);
 assert.equal(h.requiredExactShaCIGreen,true);
 assert.equal(h.verifiedMergePreview,true);
 assert.equal(h.firstPrBehindMain,10);
 assert.equal(h.humanReviewedApproved,false);
 assert.ok(h.blockers.includes('PR47_STILL_DRAFT'));
 assert.ok(h.blockers.includes('PR47_MUST_BE_RECONCILED_WITH_CURRENT_MAIN'));
 assert.equal(h.reviewerChecklist.length,10);
 assert.match(renderR47HumanPacket(h),/NO-GO blockers/);
 assert.equal(h.productionAuthorized,false);
});
test('R47 changed main, merge tree or protection policy cannot be mistaken for READY',()=>{
 const moved=handoff({changedCompare:{
   ...comp(),observedMain:'c'.repeat(40)
 }});
 assert.ok(moved.blockers.includes('MAIN_CHANGED_DURING_REVIEW'));
 const conflict=handoff({changedMerge:{
   ...merge(),conflictFreePreview:false,conflictPaths:['README.md']
 }});
 assert.ok(conflict.blockers.includes('PR47_GIT_CONFLICTS_OR_UNKNOWN'));
 const relaxed=handoff({protectionStatus:200,protection:{
   required_pull_request_reviews:{required_approving_review_count:1},
   required_status_checks:{strict:false}
 }});
 assert.ok(relaxed.blockers.includes('EXPECTED_TWO_APPROVAL_STRICT_CI_POLICY_NOT_PROVEN'));
});
test('R47 independent human review still requires current source, no bot/self',()=>{
 const p=pr();p.draft=false;
 const reviewers=['reviewer-one','reviewer-two'];
 const approvals=reviewers.map((login,i)=>({
   id:i+1,submitted_at:'2026-11-20T14:00:00Z',
   state:'APPROVED',commit_id:source,
   user:{login,type:'User'}
 }));
 const good=handoff({patchPr:p,humanTrust:reviewers,reviews:approvals,
   protectionStatus:200,protection:{
     required_pull_request_reviews:{required_approving_review_count:2},
     required_status_checks:{strict:true}
   }});
 assert.equal(good.humanReviewedApproved,true);
 assert.equal(good.productionAuthorized,false);
 assert.ok(good.blockers.includes('NO_REAL_HUMAN_MERGE_OR_FRESH_MAIN_CI'));
 const stale=structuredClone(approvals);
 stale[0].commit_id='0'.repeat(40);
 assert.equal(handoff({patchPr:p,humanTrust:reviewers,
   reviews:stale}).humanReviewedApproved,false);
});
test('R47 later Compose candidate differences require explicit human signoff',()=>{
 const h=assessR47FirstHandoff({
   pr:pr(),reviews:[],sourcePins:pins(),
   canary:assessR47ResolvedCanary(compose()),checks:checks(),
   compareProof:comp(),mergeProof:merge(),mainFinal:main,
   currentComposeMatchesFirstPr:false,currentComposeSha:'d'.repeat(40),
   branchProtectionStatus:403
 });
 assert.equal(h.realCanaryTopologyValidated,true);
 assert.equal(h.candidateComposeMatchesHistorical,false);
 assert.ok(h.blockers.includes('LATER_BRANCH_CANARY_COMPOSE_DIFF_NEEDS_HUMAN_REVIEW'));
 assert.equal(h.productionAuthorized,false);
});
test('R47 GET-only live reviewer script refuses dirty input and exports NO-GO',async()=>{
 let calls=0;
 const localEvidence={
   sourcePins:pins(),canary:assessR47ResolvedCanary(compose()),
   merge:merge(),observedMain:main,localBranchRefsUnchanged:true
 };
 const response=async(url,init)=>{
   calls++;
   assert.equal(init.method,'GET');
   assert.equal(init.redirect,'error');
   const path=new URL(url).pathname;
   const json=(data,status=200)=>({
     status,ok:status===200,json:async()=>data
   });
   if(path.endsWith('/git/ref/heads/main'))return json(mainRef());
   if(path.endsWith('/pulls/47'))return json(pr());
   if(path.endsWith('/pulls/47/reviews'))return json([]);
   if(path.endsWith('/commits/'+source+'/check-runs'))return json({
     total_count:1,check_runs:[{id:11,name:'ops-contract',
       app:{slug:'github-actions'},head_sha:source,
       status:'completed',conclusion:'success'}]
   });
   if(path.endsWith('/git/commits/'+source))return json({sha:source});
   if(path.includes('/compare/'))return json({
     status:'diverged',ahead_by:4,behind_by:10,base_commit:{sha:main}
   });
   if(path.endsWith('/branches/main/protection'))return json({},403);
   throw Error('Unexpected GitHub URL '+path);
 };
 const data=await collectR47FirstReview({
   localEvidence,fetcher:response,token:'fake-token'
 });
 assert.equal(calls,8);
 assert.equal(data.requestsMade,8);
 assert.equal(data.githubWriteCalls,0);
 assert.equal(data.handoff.productionAuthorized,false);
 assert.equal(data.checks.requiredCheckPolicyPassed,true);
});
