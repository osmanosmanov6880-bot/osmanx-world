/**
 * Read-only gate for requesting human review of the FIRST source PR.
 * Full technical evidence may be ready for a reviewer, but this module
 * cannot request reviews, merge PRs or approve production.
 */
import {createHash} from 'node:crypto';
export const R41_REVIEW_SCHEMA='osmanx.guest.r41.first-pr-human-handoff.v1';
const SOURCE='840bb083e606058a9a32450f3b3a3e881a34891e';
const R40_MAIN='85e9fe290e354d113fd62787f5e8db90406f0961';
const SHA=/^[a-f0-9]{40}$/;
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function evaluateR41ReviewGate({pr,packet,treeProof,mainRef}={}){
  const blockers=[];
  const packetValid=packet?.schema==='osmanx.guest.r39.first-pr-review-packet.v1'&&
    packet.pr===47&&packet.headSha===SOURCE&&
    packet.fileCount===10&&packet.blockers?.length===0&&
    packet.inventory?.length===10&&
    packet.inventory.every(x=>x.allHunksVerified===true);
  if(!packetValid)blockers.push('PATCH_AUDIT_INCOMPLETE');
  if(treeProof?.schema!=='osmanx.guest.r41.pr47-exact-git-tree.v1'||
    treeProof.valid!==true||treeProof.verifiedFiles!==10||
    treeProof.productionAuthorized!==false)
    blockers.push('EXACT_GIT_BLOBS_UNVERIFIED');
  if(pr?.number!==47||pr?.head?.sha!==SOURCE||
    pr?.base?.ref!=='main'||pr?.state!=='open'||pr?.merged===true)
    blockers.push('FIRST_SOURCE_PR_DRIFT');
  if(mainRef?.ref!=='refs/heads/main'||!SHA.test(mainRef?.object?.sha||''))
    blockers.push('CURRENT_MAIN_NOT_WITNESSED');
  if(pr?.draft!==false)blockers.push('PR47_STILL_DRAFT');
  if(packet?.reviewSignal?.reviewSignalComplete!==true)
    blockers.push('NO_INDEPENDENT_REVIEW_ON_CURRENT_HEAD');
  // GitHub can report unknown while recalculating mergeability.
  if(pr?.mergeable!==true||!['clean','has_hooks','unstable'].includes(pr?.mergeable_state))
    blockers.push('CURRENT_MAIN_MERGEABILITY_NOT_VERIFIED');
  const technicallyAuditable=packetValid&&treeProof?.valid===true&&
    pr?.head?.sha===SOURCE&&SHA.test(mainRef?.object?.sha||'');
  const steps=[
    {id:'01_MANUAL_REVIEW_R14',action:'Independent reviewer inspects exact 10 PR #47 files and subsequent fixes'},
    {id:'02_CLOSE_DRAFT_AND_OBTAIN_APPROVAL',action:'Change draft state and request human approval on current SHA only after review'},
    {id:'03_MANUAL_SOURCE_CHAIN_MERGE',action:'Manually merge dependency PRs after required approvals, checking exact trees'},
    {id:'04_FRESH_MAIN_POSTMERGE_CI',action:'Validate new main SHA and complete CI after last merge'},
    {id:'05_EXTERNAL_STAGING_ATTESTATION',action:'Operator verifies actual remote staging version, TLS and tenant isolation'},
    {id:'06_REAL_OFFSITE_RESTORE_AND_ROLLBACK',action:'Independently witness restoration, RTO/RPO and rollback on safe infrastructure'},
    {id:'07_CLIENT_LEGAL_AND_CHANGE_APPROVAL',action:'Client verifies contracts, lawful basis, data retention and change window'}
  ];
  const body={schema:R41_REVIEW_SCHEMA,firstPr:47,
    pinnedHead:SOURCE,currentMainSha:SHA.test(mainRef?.object?.sha||'')?
      mainRef.object.sha:null,
    mainMovedSinceR40:SHA.test(mainRef?.object?.sha||'')?
      mainRef.object.sha!==R40_MAIN:null,
    technicallyAuditable,
    tenPatchHunksComplete:packetValid,
    tenBlobsMatchPinnedTree:treeProof?.valid===true,
    independentReviewObtained:false,
    currentHumanApprovalObserved:packet?.reviewSignal?.reviewSignalComplete===true,
    blockers:[...new Set(blockers)],
    reviewerChecklist:packetValid?packet.reviewChecklist:[],
    nextSteps:steps,
    githubWriteCalls:0,automaticMergeAllowed:false,mainChangedByThisTool:false,
    productionAuthorized:false,customerGo:false,
    guestWritesEnabled:false,stopLifted:false};
  return {...body,sha256:sha(body)};
}
export function renderR41ReviewerGuide(x){
  if(x?.schema!==R41_REVIEW_SCHEMA||x?.productionAuthorized!==false)
    throw Error('R41 unsafe reviewer packet');
  const lines=[
    '# OSMANX Guest Intelligence — PR #47 independent review',
    '',
    'This is a read-only review handoff. No approval, merge or release occurred.',
    '',
    'Source SHA: '+x.pinnedHead,
    'Current main SHA: '+(x.currentMainSha||'UNAVAILABLE'),
    'Exact ten patch hunks verified: '+(x.tenPatchHunksComplete?'yes':'NO'),
    'Exact ten Git blobs verified: '+(x.tenBlobsMatchPinnedTree?'yes':'NO'),
    '',
    '## Independent code review checklist'
  ];
  for(const item of x.reviewerChecklist||[])
    lines.push('- **'+item.scope+'**: \`'+item.path+'\` — '+item.task);
  lines.push('','## Blockers and follow-up');
  for(const item of x.blockers)lines.push('- BLOCKED: '+item);
  for(const step of x.nextSteps)
    lines.push('- '+step.id+': '+step.action);
  lines.push('','**Production NO-GO. Never interpret a clean diff as a human approval.**');
  return lines.join('\n')+'\n';
}
