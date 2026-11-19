/**
 * R22 independent pre-production evidence cross-check. Inputs are obtained
 * via separate read-only procedures, never by a writable dashboard.
 * Even all-green technical results cannot authorize production or customers.
 */
import {evaluateR22Chain} from './r22-release-chain.mjs';
import {verifyHostAttestation} from './r22-host-witness.mjs';
import {verifyChangeTicket} from './r20-change-ticket.mjs';
import {verifyR21Bundle} from './r21-evidence-bundle.mjs';

export const REVIEW_SCHEMA='osmanx.guest.r22.independent-preflight.v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const MANDATORY_EXTERNAL=[
  'independent_physical_vps_review',
  'independent_offsite_worm_retention_audit',
  'independent_client_consent_contract_review',
  'authorized_release_change_window',
  'ordered_merge_and_final_main_regression'
];
export function evaluateR22Readiness({
  chainInput,hostSnapshot,hostAttestation,hostTrust,scopeDigest,
  drQuorum,ticket,ticketKeys,r21Bundle,databaseAudit,
  tenantId,pilotId,releaseCommit,anchorDigest,now=new Date()
}={}){
  const blockers=[],checks={};
  if(!UUID.test(tenantId||'')||!UUID.test(pilotId||'')||
     !COMMIT.test(releaseCommit||'')||!SHA.test(scopeDigest||'')||
     !SHA.test(anchorDigest||'')||
     !(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw new Error('R22 exact pilot, release and evidence digest required');
  let chain=null,host=null,twoPeople=null,bundle=null;
  try{
    chain=evaluateR22Chain(chainInput);
    checks.releaseGraphPinned=chain.stagedCodeVerified===true;
    checks.dependenciesMerged=chain.allDependenciesMerged===true;
    checks.protectedMain=chain.branchProtectionVerified===true;
  }catch{checks.releaseGraphPinned=false;}
  try{
    host=verifyHostAttestation(hostSnapshot,hostAttestation,{
      operatorPublicKey:hostTrust?.operator,
      r18CustodianPublicKey:hostTrust?.r18,
      r19SignerPublicKey:hostTrust?.r19,
      r20ReleasePublicKey:hostTrust?.r20,
      releaseCommit,tenantId,pilotId,now
    });
    checks.independentHostSignature=host.valid===true;
  }catch{checks.independentHostSignature=false;}
  try{
    twoPeople=verifyChangeTicket(ticket,ticketKeys,{
      releaseCommit,tenantId,pilotId,scopeDigest,anchorDigest,
      r18CustodianKey:hostTrust?.r18,
      r19OperatorKey:hostTrust?.r19,now
    });
    checks.twoHumanChangeTicket=twoPeople.valid===true;
  }catch{checks.twoHumanChangeTicket=false;}
  try{
    bundle=verifyR21Bundle(r21Bundle,{
      releaseCommit,tenantId,pilotId,scopeDigest,now
    });
    checks.r21EvidenceDigest=bundle.valid===true;
  }catch{checks.r21EvidenceDigest=false;}
  checks.databaseReadOnlyReport=databaseAudit?.schema===
    'osmanx.guest.r21.database-posture.v1'&&
    databaseAudit?.technicalPostureReady===true&&
    databaseAudit?.queriesReadOnly===true;
  checks.twoRestoredCopiesReported=drQuorum?.schema===
    'osmanx.guest.r22.two-copy-dr-quorum.v1'&&
    drQuorum?.technicalQuorumReady===true&&
    drQuorum?.contentsIdentical===true&&
    drQuorum?.isolatedDatabasesDistinct===true&&
    drQuorum?.custodyMetadataDistinct===true;
  checks.scopeMatchesTicket=ticket?.r19ScopeDigest===scopeDigest;
  checks.anchorMatchesTicket=ticket?.r18AnchorDigest===anchorDigest;
  checks.releaseMatchesTicket=ticket?.releaseCommit===releaseCommit;
  for(const [k,v] of Object.entries(checks))
    if(v!==true)blockers.push('r22_'+k);
  for(const x of MANDATORY_EXTERNAL)blockers.push('external_'+x);
  const derivedTechnicalChecksPassed=[
    'releaseGraphPinned','independentHostSignature','twoHumanChangeTicket',
    'r21EvidenceDigest','databaseReadOnlyReport','twoRestoredCopiesReported',
    'scopeMatchesTicket','anchorMatchesTicket','releaseMatchesTicket'
  ].every(k=>checks[k]===true);
  return {schema:REVIEW_SCHEMA,tenantId,pilotId,releaseCommit,
    checks,blockers,
    verifiedSignatures:{
      independentHost:host?.independentSignatureValid===true&&host?.valid===true,
      twoPersonTicket:twoPeople?.valid===true
    },
    derivedTechnicalChecksPassed,
    releaseChainUnmerged:checks.dependenciesMerged!==true,
    operatorVerificationOutstanding:MANDATORY_EXTERNAL,
    readinessForReviewOnly:derivedTechnicalChecksPassed,
    // Constant hard boundary. This report has NO actor that can write, merge,
    // deploy, rotate keys, lift emergency STOP, or ingest real guest data.
    productionAuthorized:false,legalGo:false,customerGo:false,
    productionChanged:false,offsiteWormVerified:false,
    customerRecordsProcessed:false
  };
}
