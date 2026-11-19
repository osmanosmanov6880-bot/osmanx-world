/**
 * Offline-only, source/tenant/pilot/tree-bound evidence manifest.
 * A valid packet can be sent for external HUMAN review, never deployment.
 */
import {createPublicKey,KeyObject} from 'node:crypto';
import {R32_PIN,R33_SOURCE_SCHEMA}
  from './guest-r33-source.mjs';
import {r33Hash} from './guest-r33-signatures.mjs';
import {evaluateR33Staging,R33_STAGE_ROLES}
  from './guest-r33-staging-witness.mjs';
import {verifyR33RollbackLedger}
  from './guest-r33-rollback-ledger.mjs';
import {evaluateR33Privacy,R33_PRIVACY_ROLES}
  from './guest-r33-privacy.mjs';
export const R33_BUNDLE_SCHEMA='osmanx.guest.r33.independent-review-handoff.v1';
const KEYS=['source','staging','stagingReceipts','rollback','privacy',
  'privacyReceipts'];
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===k.slice().sort().join('|');
export function evaluateR33ProofBundle({evidence,publicKeys={},
  now=new Date()}={}){
  const issues=[];
  if(!exact(evidence,KEYS))issues.push('INVALID_BUNDLE_FIELDS');
  const {source,staging,stagingReceipts,rollback,privacy,privacyReceipts}=
    evidence&&typeof evidence==='object'?evidence:{};
  const sourceValid=source?.schema===R33_SOURCE_SCHEMA&&
    source?.sourcePrsRequired===19&&source?.observedPrs===19&&
    source?.sourceHeadSha===R32_PIN.sha&&
    source?.sourceCiPassed===true&&source?.ancestryVerified===true&&
    source?.automaticMergeAllowed===false&&
    source?.productionAuthorized===false&&
    typeof source?.sourceTreeSha==='string'&&
    /^[a-f0-9]{40}$/.test(source.sourceTreeSha);
  if(!sourceValid)issues.push('SOURCE_GRAPH_INVALID');
  const stage=evaluateR33Staging({packet:staging,
    receipts:stagingReceipts,publicKeys,now});
  if(!stage.pairedProbesHealthy)
    issues.push('STAGING_SIGNED_METADATA_INVALID');
  const recovery=verifyR33RollbackLedger(rollback,{
    tenantId:staging?.tenantId,pilotId:staging?.pilotId,now});
  if(!recovery.rehearsalMetadataPass)
    issues.push('DISPOSABLE_ROLLBACK_CHAIN_INVALID');
  const policy=evaluateR33Privacy({packet:privacy,
    receipts:privacyReceipts,publicKeys,now});
  if(!policy.metadataAndSignaturesValid)
    issues.push('PRIVACY_SIGNED_METADATA_INVALID');
  if(staging?.tenantId!==privacy?.tenantId||
    staging?.pilotId!==privacy?.pilotId||
    staging?.tenantId!==rollback?.tenantId||
    staging?.pilotId!==rollback?.pilotId||
    privacy?.changeId!==rollback?.changeId)
    issues.push('TENANT_PILOT_OR_CHANGE_MISMATCH');
  if(staging?.releaseSha!==R32_PIN.sha||
    privacy?.releaseSha!==R32_PIN.sha||
    rollback?.releaseSha!==R32_PIN.sha||
    staging?.sourceTreeSha!==source?.sourceTreeSha||
    privacy?.sourceTreeSha!==source?.sourceTreeSha||
    rollback?.sourceTreeSha!==source?.sourceTreeSha)
    issues.push('RELEASE_OR_TREE_MISMATCH');
  // Cross-document separation: four distinct public keys for four roles.
  const fingerprints=new Set();
  try{
    for(const role of [...R33_STAGE_ROLES,...R33_PRIVACY_ROLES]){
      const item=publicKeys?.[role];
      if(!exact(item,['keyId','publicKey']))throw Error('MISSING_KEY');
      const key=item.publicKey instanceof KeyObject?
        item.publicKey:createPublicKey(item.publicKey);
      if(key.type!=='public'||key.asymmetricKeyType!=='ed25519')
        throw Error('BAD_KEY');
      const fp=key.export({type:'spki',format:'der'}).toString('hex');
      if(fingerprints.has(fp))throw Error('DUPLICATED_KEY');
      fingerprints.add(fp);
    }
  }catch{issues.push('FOUR_DISTINCT_SIGNING_KEYS_REQUIRED');}
  const valid=issues.length===0;
  const payload={schema:R33_BUNDLE_SCHEMA,
    tenantId:valid?staging.tenantId:null,
    pilotId:valid?staging.pilotId:null,
    releaseSha:R32_PIN.sha,
    sourceSha:sourceValid?r33Hash(source):null,
    stagingSha:stage.metadataSha,
    rollbackFinalSha:recovery.finalSha,
    privacySha:policy.evidenceSha,
    independentMetadataBindingsPass:valid,
    humanReviewQueueEligible:valid,
    actualExternalVpsVerified:false,
    actualOffsiteRecoveryVerified:false,
    lawfulBasisVerified:false,postMergeMainCiPassed:false,
    liveRollbackExecuted:false,stopLifted:false,
    customerGo:false,productionAuthorized:false,
    blockers:[...new Set([...issues,
      'HUMAN_CODE_REVIEW_AND_MANUAL_MERGE_REQUIRED',
      'REAL_STAGING_OFFSITE_RECOVERY_LEGAL_APPROVAL_REQUIRED',
      'FRESH_POST_MERGE_MAIN_CI_REQUIRED'])]};
  return {...payload,sha256:r33Hash(payload)};
}
