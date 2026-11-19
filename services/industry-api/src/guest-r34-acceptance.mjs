/**
 * One fully bounded, read-only handoff for independent human release audit.
 * Even perfect offline signatures cannot lift STOP or enable production.
 */
import {createPublicKey,KeyObject} from 'node:crypto';
import {R33_PIN,R34_SOURCE_SCHEMA} from './guest-r34-source.mjs';
import {reviewR34HostEvidence}
  from './guest-r34-host-evidence.mjs';
import {evaluateR34Custody,R34_CUSTODY_ROLES}
  from './guest-r34-custody.mjs';
import {evaluateR34ClientScope,R34_CLIENT_ROLES}
  from './guest-r34-client.mjs';
import {digest34} from './guest-r34-quorum.mjs';
export const R34_ACCEPTANCE_SCHEMA='osmanx.guest.r34.manual-decision-handoff.v1';
const SHA40=/^[a-f0-9]{40}$/;
const KEYS=['source','host','custody','custodyStatements','client',
  'clientStatements'];
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===k.slice().sort().join('|');
export function evaluateR34Acceptance({evidence,trustedKeys={},
  now=new Date()}={}){
  const issues=[];
  if(!exact(evidence,KEYS))issues.push('UNEXPECTED_EVIDENCE_FIELDS');
  const x=evidence&&typeof evidence==='object'?evidence:{};
  const sourceValid=x.source?.schema===R34_SOURCE_SCHEMA&&
    x.source?.sourcePrsRequired===20&&x.source?.observedPrs===20&&
    x.source?.sourceHeadSha===R33_PIN.sha&&
    SHA40.test(x.source?.sourceTreeSha||'')&&
    x.source?.sourceCiPassed===true&&
    x.source?.ancestryVerified===true&&
    x.source?.automaticMergeAllowed===false&&
    x.source?.productionAuthorized===false;
  if(!sourceValid)issues.push('SOURCE_20_PR_CHAIN_INVALID');
  const host=reviewR34HostEvidence(x.host,{
    pilotId:x.client?.pilotId,
    sourceTreeSha:x.source?.sourceTreeSha,now});
  if(!host.locallyObservedHealthy)
    issues.push('REAL_STAGING_OBSERVER_EVIDENCE_INVALID');
  const custody=evaluateR34Custody({packet:x.custody,
    statements:x.custodyStatements,trustedKeys,now});
  if(!custody.metadataReadyForHumanAudit)
    issues.push('OFFSITE_RESTORE_EVIDENCE_INVALID');
  const client=evaluateR34ClientScope({packet:x.client,
    statements:x.clientStatements,trustedKeys,now});
  if(!client.signedScopeMetadataValid)
    issues.push('CLIENT_PILOT_SCOPE_INVALID');
  for(const packet of [x.host,x.custody,x.client]){
    if(packet?.releaseSha!==R33_PIN.sha||
      packet?.sourceTreeSha!==undefined&&
        packet.sourceTreeSha!==x.source?.sourceTreeSha||
      packet?.treeSha!==undefined&&
        packet.treeSha!==x.source?.sourceTreeSha||
      packet?.pilotId!==x.client?.pilotId||
      packet?.tenantId!==undefined&&packet.tenantId!==x.client?.tenantId)
      issues.push('RELEASE_TENANT_PILOT_TREE_MISMATCH');
  }
  // One human may not act as independent signers across all four roles.
  const fingerprints=new Set();
  try{
    for(const role of [...R34_CUSTODY_ROLES,...R34_CLIENT_ROLES]){
      const item=trustedKeys?.[role];
      if(!exact(item,['keyId','publicKey']))throw Error('INVALID_KEYS');
      const key=item.publicKey instanceof KeyObject?
        item.publicKey:createPublicKey(item.publicKey);
      if(key.type!=='public'||key.asymmetricKeyType!=='ed25519')
        throw Error('INVALID_KEY_TYPE');
      const fp=key.export({type:'spki',format:'der'}).toString('hex');
      if(fingerprints.has(fp))throw Error('KEY_REUSED');
      fingerprints.add(fp);
    }
  }catch{issues.push('FOUR_INDEPENDENT_TRUST_ANCHORS_REQUIRED');}
  const metadataValid=issues.length===0;
  const out={schema:R34_ACCEPTANCE_SCHEMA,
    pilotId:metadataValid?x.client.pilotId:null,
    tenantId:metadataValid?x.client.tenantId:null,
    sourceHeadSha:R33_PIN.sha,
    sourceTreeSha:sourceValid?x.source.sourceTreeSha:null,
    hostSha:host.locallyObservedHealthy?x.host.sha256:null,
    custodySha:custody.evidenceSha,clientSha:client.scopeSha,
    canSubmitToHumanAudit:metadataValid,
    locallyObservedStaging:host.locallyObservedHealthy,
    independentlyWitnessedLiveHost:false,
    independentlyWitnessedOffsiteRestore:false,
    independentlyVerifiedLegalAuthority:false,
    actualProductionRollbackTestPassed:false,
    freshMergedMainCiVerified:false,
    humanMergeOf20PrsVerified:false,
    productionAuthorized:false,customerGo:false,
    stopLifted:false,mainChanged:false,
    blockers:[...new Set([...issues,
      'INDEPENDENT_OPERATOR_VERIFICATION_REQUIRED',
      'LIVE_OFFSITE_RESTORE_AND_ROLLBACK_REQUIRED',
      'LAWYER_AND_CLIENT_APPROVAL_REQUIRED',
      'HUMAN_PR_MERGE_AND_MAIN_CI_REQUIRED'])]};
  return {...out,sha256:digest34(out)};
}
