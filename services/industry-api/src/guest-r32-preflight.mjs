/**
 * Combined offline technical evidence review. Green metadata can only
 * advance the *review queue*, not customer launch, merge or STOP lift.
 */
import {createHash} from 'node:crypto';
import {R31_PIN,R32_SOURCE_SCHEMA} from './guest-r32-source.mjs';
import {evaluateR32StagingDrift} from './guest-r32-staging-drift.mjs';
import {verifyR32ChangeWindow} from './guest-r32-change-window.mjs';
import {assessR32RecoveryObjectives} from './guest-r32-recovery-objectives.mjs';
export const R32_PREFLIGHT_SCHEMA='osmanx.guest.r32.manual-preflight.v1';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function evaluateR32Preflight({source,plan,signatures,publicKeys,
  first,second,dr,recovery,now=new Date()}={}){
  const issues=[];
  const validSource=source?.schema===R32_SOURCE_SCHEMA&&
    source?.releaseSha===R31_PIN.sha&&source?.sourcePrsRequired===18&&
    source?.observedPrs===18&&
    source?.sourceCiPassed===true&&source?.ancestryVerified===true&&
    source?.automaticMergeAllowed===false&&
    source?.productionAuthorized===false;
  if(!validSource)issues.push('SOURCE_GRAPH_UNVERIFIED');
  const window=verifyR32ChangeWindow({plan,signatures,publicKeys,now});
  if(!window.metadataAndSignaturesValid)issues.push('CHANGE_WINDOW_NOT_SIGNED');
  const pilotId=plan?.pilotId;
  const drift=evaluateR32StagingDrift({first,second,pilotId,now});
  if(!drift.technicalParityStable)issues.push('STAGING_PARITY_UNSTABLE');
  const restore=assessR32RecoveryObjectives({dr,record:recovery,now});
  if(!restore.metadataMetricsPass)issues.push('RESTORE_OBJECTIVES_NOT_MET');
  if(plan?.releaseSha!==source?.releaseSha||
    plan?.treeSha!==source?.sourceTreeSha)
    issues.push('PLAN_SOURCE_DIGEST_MISMATCH');
  if(dr?.pilotId!==pilotId||recovery?.pilotId!==pilotId||
    first?.pilotId!==pilotId||second?.pilotId!==pilotId)
    issues.push('PILOT_IDENTITY_MISMATCH');
  if(plan?.recoveryEvidenceSha!==dr?.sha256)
    issues.push('PLAN_DR_SHA_MISMATCH');
  // Must remain NO-GO even when all offline metadata is consistent.
  const metadataReady=issues.length===0;
  const payload={
    schema:R32_PREFLIGHT_SCHEMA,pilotId:pilotId||null,
    releaseSha:R31_PIN.sha,
    sourceCiPassed:validSource,
    stagingEvidenceHashes:[drift.firstSha,drift.secondSha],
    changeWindowSignaturesValid:window.metadataAndSignaturesValid,
    recoveryMetadataPass:restore.metadataMetricsPass,
    eligibleForHumanAudit:metadataReady,
    independentVpsWitnessVerified:false,
    independentOffsiteCustodyVerified:false,
    clientLegalApprovalVerified:false,
    humanSourceMergeVerified:false,postMergeMainCiVerified:false,
    productionAuthorized:false,customerGo:false,stopLifted:false,
    blockers:[...new Set([...issues,
      'INDEPENDENT_STAGING_AND_OFFSITE_CUSTODY_REQUIRED',
      'HUMAN_APPROVAL_LEGAL_REVIEW_AND_MAIN_CI_REQUIRED'])]
  };
  return {...payload,sha256:hash(payload)};
}
