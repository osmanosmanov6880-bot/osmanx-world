/**
 * Operator-only offline evidence binding across source, staging, DR and privacy.
 * No key acquisition here: trusted verification keys must be pinned by an
 * independent administrator outside GitHub/web API.
 */
import {createHash} from 'node:crypto';
import {verifyR30Report} from './guest-r30-report.mjs';
import {reviewR30ProbeSnapshot} from './guest-r30-probe.mjs';
import {verifyR30IndependentReceipts} from './guest-r30-evidence.mjs';
import {R30_PIN,R31_CHAIN_SCHEMA} from './guest-r31-chain.mjs';
import {reviewR31DrRehearsal} from './guest-r31-dr-review.mjs';
export const R31_BUNDLE_SCHEMA='osmanx.guest.r31.operator-evidence-binding.v1';
const SHA=/^[a-f0-9]{64}$/;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===keys.slice().sort().join('|');
export function reviewR31EvidenceBundle({
  r30,source,probe,dr,privacy,identity,receipts,publicKeys={},now=new Date()
}={}){
  const blockers=[];
  const packetValid=verifyR30Report(r30,{pilotId:identity?.pilotId,now}).valid;
  if(!packetValid||identity?.pilotId!==r30?.pilotId||
    identity?.r29ReportSha!==r30?.r29ReportSha||
    identity?.releaseCommit!==R30_PIN.sha)
    blockers.push('R30_HANDOFF_OR_SCOPE_INVALID');
  const sourceValid=source?.schema===R31_CHAIN_SCHEMA&&
    source?.releaseCommitSha===R30_PIN.sha&&
    source?.sourcePrsRequired===17&&
    source?.observedPrs===17&&
    source?.autoMergeAllowed===false&&source?.deployAllowed===false&&
    source?.customerGo===false&&source?.productionAuthorized===false;
  if(!sourceValid)blockers.push('SOURCE_REVIEW_INVALID');
  const probeCheck=reviewR30ProbeSnapshot(probe,{
    pilotId:identity?.pilotId,releaseCommit:R30_PIN.sha,now
  });
  if(!probeCheck.technicalParityPassed||
    probe?.source!=='operator-claimed')
    blockers.push('STAGING_OPERATOR_TRACE_UNVERIFIED');
  const drCheck=reviewR31DrRehearsal(dr,{pilotId:identity?.pilotId,now});
  if(!drCheck.metadataConsistent||dr?.source!=='operator-claimed')
    blockers.push('DR_OPERATOR_RECORDS_UNVERIFIED');
  const privacyValid=exact(privacy,['schema','assessmentSha',
    'noCustomerDataCopied','lawfulBasisConfirmedExternally'])&&
    privacy.schema==='osmanx.guest.r31.privacy-brief.v1'&&
    SHA.test(privacy.assessmentSha||'')&&
    privacy.noCustomerDataCopied===true&&
    privacy.lawfulBasisConfirmedExternally===false;
  if(!privacyValid)blockers.push('PRIVACY_BRIEF_INVALID');
  const witness=verifyR30IndependentReceipts({
    identity,packet:receipts,publicKeys,now
  });
  if(!witness.signatureQuorumVerified)
    blockers.push('INDEPENDENT_SIGNATURE_QUORUM_MISSING');
  const expected={
    source_reviewer:sourceValid?hash(source):null,
    staging_witness:probeCheck.technicalParityPassed?probe?.sha256:null,
    recovery_auditor:drCheck.metadataConsistent?dr?.sha256:null,
    privacy_officer:privacyValid?hash(privacy):null
  };
  for(const [role,expectedSha] of Object.entries(expected)){
    const item=Array.isArray(receipts?.receipts)?
      receipts.receipts.find(r=>r?.role===role):null;
    if(!expectedSha||item?.evidenceSha!==expectedSha)
      blockers.push('EVIDENCE_SHA_MISMATCH_'+role.toUpperCase());
  }
  // Independent signature verification establishes authenticity of a hash
  // statement only. Human source review, actual offsite custody, legal basis
  // and main post-merge CI remain external blockers.
  const bound=blockers.length===0;
  const payload={
    schema:R31_BUNDLE_SCHEMA,pilotId:identity?.pilotId||null,
    releaseCommit:R30_PIN.sha,
    sourceSha:expected.source_reviewer,
    probeSha:expected.staging_witness,
    drSha:expected.recovery_auditor,
    privacySha:expected.privacy_officer,
    independentSignatureQuorum:bound&&witness.signatureQuorumVerified,
    offlineMetadataBound:bound,
    realStagingIndependentlyConfirmed:false,
    offsiteCustodyConfirmed:false,
    legalBasisConfirmed:false,postMergeMainCiPassed:false,
    customerGo:false,productionAuthorized:false,
    blockers:[...new Set([...blockers,
      'R31_MANUAL_SOURCE_MERGE_REQUIRED',
      'R31_ACTUAL_VPS_OFFSITE_LEGAL_AUDIT_REQUIRED',
      'R31_FINAL_MAIN_CI_REQUIRED'])]
  };
  return {...payload,sha256:hash(payload)};
}
