/**
 * R39 concrete first PR review packet. Binds full changed-file inventory,
 * full readable patch digest and current SHA to a minimum reviewer checklist.
 * Does not pretend automated scanning substitutes a security review.
 */
import {createHash} from 'node:crypto';
export const R39_FIRST_PR_SCHEMA='osmanx.guest.r39.first-pr-review-packet.v1';
const HEAD='840bb083e606058a9a32450f3b3a3e881a34891e';
const FILES=Object.freeze([
  '.github/workflows/guest-r14-operations.yml',
  'docs/GUEST_INTELLIGENCE_R14.md',
  'services/industry-api/ops/build-release.sh',
  'services/industry-api/ops/compose.r14.yml',
  'services/industry-api/ops/r14-canary.sh',
  'services/industry-api/ops/verify-release.sh',
  'services/industry-api/scripts/r14-admission.mjs',
  'services/industry-api/scripts/r14-incident.mjs',
  'services/industry-api/scripts/r14-monitor.mjs',
  'services/industry-api/test/guest-r14.test.mjs'
]);
const CHECKS=Object.freeze([
  {scope:'compose',path:'services/industry-api/ops/compose.r14.yml',
    task:'Confirm literal loopback-only binding, disabled writes and per-service capabilities'},
  {scope:'canary',path:'services/industry-api/ops/r14-canary.sh',
    task:'Review env file ownership, post-expansion Compose and repeat-apply protection; R37–R39 provide follow-up fixes'},
  {scope:'admission',path:'services/industry-api/scripts/r14-admission.mjs',
    task:'Verify independent Ed25519 signatures, actor separation, custody and chronological validity'},
  {scope:'monitor',path:'services/industry-api/scripts/r14-monitor.mjs',
    task:'Verify read-only probes, bounded responses and privacy of telemetry'},
  {scope:'incident',path:'services/industry-api/scripts/r14-incident.mjs',
    task:'Verify incident threshold, stop handling and absolutely no automatic restart'},
  {scope:'workflow',path:'.github/workflows/guest-r14-operations.yml',
    task:'Check GITHUB_TOKEN read-only, no privileged workflows and no leaked synthetic passwords'}
]);
const sha=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export function buildR39FirstPrPacket({pr,files,filesComplete=false,
  commit,review}={}){
  const problems=[];
  if(pr?.number!==47||pr?.head?.sha!==HEAD||
    pr?.base?.ref!=='main'||pr?.state!=='open'||
    pr?.merged===true)problems.push('PR47_DRIFT');
  if(commit?.sha!==HEAD||!/^[a-f0-9]{40}$/.test(commit?.tree?.sha||''))
    problems.push('PR47_TREE_UNKNOWN');
  if(!filesComplete||!Array.isArray(files)||files.length!==FILES.length||
    pr?.changed_files!==FILES.length)
    problems.push('PR47_FILE_LIST_INCOMPLETE');
  const matched=[],seen=new Set();
  if(Array.isArray(files))for(const f of files){
    if(!FILES.includes(f?.filename)||seen.has(f.filename)||
      typeof f.patch!=='string'||f.patch.length>65536||
      f.patch.length<10||
      !['added','modified','removed','renamed'].includes(f.status)||
      !Number.isSafeInteger(f.additions)||!Number.isSafeInteger(f.deletions))
      problems.push('INVALID_OR_UNEXPECTED_PATCH');
    else{
      seen.add(f.filename);
      matched.push({path:f.filename,status:f.status,
        patchSha256:sha(f.patch),additions:f.additions,deletions:f.deletions});
    }
  }
  if(seen.size!==FILES.length)problems.push('EXPECTED_R14_FILES_MISSING');
  const body={schema:R39_FIRST_PR_SCHEMA,pr:47,headSha:HEAD,
    treeSha:commit?.sha===HEAD?commit.tree.sha:null,
    fileCount:matched.length,inventory:matched.sort((a,b)=>a.path.localeCompare(b.path,'en')),
    reviewChecklist:CHECKS,
    reviewSignal:review?.schema==='osmanx.guest.r38.first-review-policy.v1'?
      {currentHeadApprovalCount:review.currentHeadApprovalCount,
        outstandingChangeRequestCount:review.outstandingChangeRequestCount,
        reviewSignalComplete:review.reviewSignalComplete===true}:
      {currentHeadApprovalCount:0,outstandingChangeRequestCount:0,
        reviewSignalComplete:false},
    laterSecurityFixesStillUnmerged:true,
    manualReviewerMustApproveExactHead:true,
    manualReviewPerformedByThisTool:false,
    branchProtectionIndependentlyAudited:false,
    productionAuthorized:false,automaticMergeAllowed:false,
    blockers:[...new Set(problems)]};
  return {...body,packetSha256:sha(body)};
}
