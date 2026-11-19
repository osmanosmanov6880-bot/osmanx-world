/**
 * Offline operator handoff: source+actual bounded GET+encrypted local bytes+
 * five locally checked legal files. Facts still need independent human audit.
 */
import {createHash} from 'node:crypto';
import {R34_PIN,R35_SOURCE_SCHEMA} from './guest-r35-source.mjs';
import {R33_PIN} from './guest-r34-source.mjs';
import {R35_ARCHIVE_SCHEMA} from './guest-r35-archive-bytes.mjs';
import {R35_DOCUMENT_SCHEMA} from './guest-r35-document-bytes.mjs';
export const R35_HANDOFF_SCHEMA='osmanx.guest.r35.evidence-verification-handoff.v1';
const SHA=/^[a-f0-9]{64}$/;
const TREE=/^[a-f0-9]{40}$/;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function evaluateR35OperatorHandoff({source,review,staging,archive,
  documents,client,custody,now=new Date()}={}){
  const blockers=[];
  const sourceOk=source?.schema===R35_SOURCE_SCHEMA&&
    source?.sourcePrsRequired===21&&source?.observedPrs===21&&
    source?.sourceHeadSha===R34_PIN.sha&&
    source?.sourceCiPassed===true&&
    source?.ancestryVerified===true&&
    TREE.test(source?.sourceTreeSha||'')&&
    source?.automaticMergeAllowed===false&&
    source?.productionAuthorized===false;
  if(!sourceOk)blockers.push('21_PR_SOURCE_REVIEW_INCOMPLETE');
  const manualOk=review?.schema==='osmanx.guest.r35.review-queue.v1'&&
    review.firstPendingPr===source?.firstPendingPr&&
    review.expectedHeadSha===source?.expectedPendingSha&&
    review.productionAuthorized===false&&
    review.automaticMergeAllowed===false;
  if(!manualOk)blockers.push('FIRST_PENDING_PR_REVIEW_NOT_VERIFIED');
  const stagingOk=staging?.schema==='osmanx.guest.r35.pinned-staging-review.v1'&&
    staging?.releaseSha===R34_PIN.sha&&
    staging?.sourceTreeSha===source?.sourceTreeSha&&
    staging?.pilotId===client?.pilotId&&
    staging?.operatorExecuted===true&&
    staging?.dnsAndTlsPinned===true&&
    staging?.independentWitnessVerified===false&&
    SHA.test(staging?.profileSha256||'')&&
    SHA.test(staging?.observationSha256||'')&&
    staging?.productionAuthorized===false;
  if(!stagingOk)blockers.push('LIVE_STAGING_OBSERVATION_MISSING');
  const nowMs=now instanceof Date?now.getTime():NaN,
    start=Date.parse(staging?.issuedAt),end=Date.parse(staging?.expiresAt);
  if(!Number.isFinite(nowMs)||!Number.isFinite(start)||
    !Number.isFinite(end)||start>nowMs||nowMs>=end||
    end<=start||end-start>600000)
    blockers.push('STAGING_EVIDENCE_EXPIRED');
  const archiveOk=archive?.schema===R35_ARCHIVE_SCHEMA&&
    archive?.localEncryptedArchiveHashesMatched===true&&
    archive?.actualDecryptionAndRestorationPerformed===false&&
    archive?.independentOffsiteCustodyVerified===false&&
    archive?.productionAuthorized===false&&
    Array.isArray(archive?.proofs)&&archive.proofs.length===2&&
    ['A','B'].every((id,i)=>archive.proofs[i]?.copyId===id&&
      archive.proofs[i].sha256===
        custody?.copies?.find(c=>c.copyId===id)?.archiveSha);
  if(!archiveOk)blockers.push('ENCRYPTED_ARCHIVE_BYTES_NOT_VERIFIED');
  const mapping={contract:'contractSha',
    processorAgreement:'processorAgreementSha',
    privacyNotice:'privacyNoticeSha',
    lawfulBasisOpinion:'lawfulBasisOpinionSha',
    deletionProcedure:'deletionProcedureSha'};
  const docsOk=documents?.schema===R35_DOCUMENT_SCHEMA&&
    documents?.fiveSignedFileDigestsMatched===true&&
    documents?.legalValidityIndependentlyEstablished===false&&
    documents?.productionAuthorized===false&&
    Array.isArray(documents?.proofs)&&
    documents.proofs.length===5&&
    Object.entries(mapping).every(([name,shaName],i)=>
      documents.proofs[i]?.documentType===name&&
      documents.proofs[i]?.sha256===client?.[shaName]);
  if(!docsOk)blockers.push('ACTUAL_CLIENT_DOCUMENT_BYTES_UNVERIFIED');
  if(client?.tenantId!==custody?.tenantId||
    client?.pilotId!==custody?.pilotId||
    client?.treeSha!==source?.sourceTreeSha||
    custody?.treeSha!==source?.sourceTreeSha||
    client?.releaseSha!==R33_PIN.sha||
    custody?.releaseSha!==R33_PIN.sha||
    client?.productionCollectionAuthorized!==false)
    blockers.push('TENANT_PILOT_RELEASE_SCOPE_MISMATCH');
  const metadataPass=blockers.length===0;
  const result={
    schema:R35_HANDOFF_SCHEMA,
    tenantId:metadataPass?client.tenantId:null,
    pilotId:metadataPass?client.pilotId:null,
    sourceHeadSha:R34_PIN.sha,
    sourceTreeSha:sourceOk?source.sourceTreeSha:null,
    firstPendingPr:manualOk?review.firstPendingPr:null,
    manualNextAction:manualOk?review.manualNextAction:null,
    stagingObservationSha:stagingOk?staging.observationSha256:null,
    archiveProofsSha:archiveOk?digest(archive.proofs):null,
    contractProofsSha:docsOk?digest(documents.proofs):null,
    eligibleForIndependentHumanReview:metadataPass,
    approvedRealWorldCodeReview:false,
    independentlyWitnessedStaging:false,
    realOffsiteRestoreExecuted:false,
    realRollbackDrillExecuted:false,
    legalDocumentsIndependentlyApproved:false,
    sourceMergedIntoMain:false,postMergeMainCiVerified:false,
    productionAuthorized:false,customerGo:false,
    stopLifted:false,guestWritesEnabled:false,
    blockers:[...new Set([...blockers,
      'FIRST_PENDING_PR_NEEDS_HUMAN_REVIEW_AND_MERGE',
      'INDEPENDENT_STAGING_HOST_WITNESS_REQUIRED',
      'AGE_DECRYPT_RESTORE_AND_OFFSITE_WITNESS_REQUIRED',
      'LEGAL_AUTHORITY_AND_CONTRACT_REVIEW_REQUIRED',
      'FRESH_FINAL_MAIN_CI_REQUIRED'])]};
  return {...result,sha256:digest(result)};
}
