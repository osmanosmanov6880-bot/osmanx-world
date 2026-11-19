/**
 * Two independently signed claimed offsite restore events.
 * Metadata is not proof of actual remote custody or recovery. No DB contact.
 */
import {R33_PIN} from './guest-r34-source.mjs';
import {digest34,valid34Time,verifyR34Quorum}
  from './guest-r34-quorum.mjs';
export const R34_CUSTODY_SCHEMA='osmanx.guest.r34.offsite-two-copy-review.v1';
export const R34_CUSTODY_ROLES=Object.freeze([
  'offsite_custodian','independent_recovery_auditor'
]);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const SHA40=/^[a-f0-9]{40}$/;
const outer=['schema','tenantId','pilotId','releaseSha','treeSha',
  'issuedAt','expiresAt','productionDatabaseTouched','copies',
  'targetRtoMinutes','targetRpoMinutes'];
const inner=['copyId','storageRealm','archiveSha','keyFingerprint',
  'restoreTarget','encryptedWithAge','restoredRows','restoredDataSha',
  'restoreStartedAt','restoreFinishedAt','lastExpectedEventAt',
  'lastRecoveredEventAt'];
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===k.slice().sort().join('|');
export function evaluateR34Custody({packet,statements,trustedKeys={},
  now=new Date()}={}){
  const issues=[],identifiers=new Set(),archives=new Set(),keys=new Set(),
    realms=new Set(),targets=new Set(),checksums=new Set(),rows=new Set();
  if(!exact(packet,outer)||packet?.schema!==R34_CUSTODY_SCHEMA||
    !UUID.test(packet?.tenantId||'')||!UUID.test(packet?.pilotId||'')||
    packet?.releaseSha!==R33_PIN.sha||
    !SHA40.test(packet?.treeSha||'')||
    !valid34Time(packet?.issuedAt)||!valid34Time(packet?.expiresAt)||
    packet?.productionDatabaseTouched!==false||
    !Number.isInteger(packet?.targetRtoMinutes)||
    packet?.targetRtoMinutes<1||packet?.targetRtoMinutes>60||
    !Number.isInteger(packet?.targetRpoMinutes)||
    packet?.targetRpoMinutes<0||packet?.targetRpoMinutes>60||
    !Array.isArray(packet?.copies)||packet.copies.length!==2)
    issues.push('INVALID_OFFSITE_SCOPE');
  const measurements=[];
  for(const copy of Array.isArray(packet?.copies)?packet.copies.slice(0,3):[]){
    if(!exact(copy,inner)||!['A','B'].includes(copy.copyId)||
      !['independent-region-a','independent-region-b'].includes(copy.storageRealm)||
      !SHA.test(copy.archiveSha||'')||
      !SHA.test(copy.keyFingerprint||'')||
      !SHA.test(copy.restoredDataSha||'')||
      !/^industry_dr_r34_[a-z0-9]{6,16}$/.test(copy.restoreTarget||'')||
      copy.encryptedWithAge!==true||
      !Number.isSafeInteger(copy.restoredRows)||copy.restoredRows<0||
      copy.restoredRows>1000000||
      ![copy.restoreStartedAt,copy.restoreFinishedAt,
        copy.lastExpectedEventAt,copy.lastRecoveredEventAt].every(valid34Time)){
      issues.push('INVALID_DISPOSABLE_RESTORE');continue;
    }
    identifiers.add(copy.copyId);archives.add(copy.archiveSha);
    keys.add(copy.keyFingerprint);realms.add(copy.storageRealm);
    targets.add(copy.restoreTarget);
    checksums.add(copy.restoredDataSha);rows.add(copy.restoredRows);
    const start=Date.parse(copy.restoreStartedAt),
      finish=Date.parse(copy.restoreFinishedAt),
      expected=Date.parse(copy.lastExpectedEventAt),
      recovered=Date.parse(copy.lastRecoveredEventAt);
    if(start<Date.parse(packet?.issuedAt)||finish<start||
      finish>now.getTime()||expected<recovered||expected>finish||
      recovered>finish){
      issues.push('UNTRUSTED_RECOVERY_TIMING');continue;
    }
    const rto=(finish-start)/60000,rpo=(expected-recovered)/60000;
    if(rto>packet.targetRtoMinutes||rpo>packet.targetRpoMinutes)
      issues.push('RECOVERY_OBJECTIVE_EXCEEDED');
    measurements.push({copyId:copy.copyId,rtoMinutes:rto,rpoMinutes:rpo});
  }
  if(identifiers.size!==2||archives.size!==2||keys.size!==2||
    realms.size!==2||targets.size!==2)
    issues.push('COPIES_NOT_INDEPENDENT');
  if(checksums.size!==1||rows.size!==1)
    issues.push('RESTORED_DATA_DIVERGED');
  const sigs=verifyR34Quorum({
    domain:'osmanx.guest.r34.offsite-custody.v1',
    payload:packet,statements,roles:R34_CUSTODY_ROLES,
    trustedKeys,now});
  if(!sigs.signaturesValid)issues.push('CUSTODY_SIGNATURES_INVALID');
  const valid=issues.length===0;
  return {schema:'osmanx.guest.r34.custody-review.v1',
    metadataReadyForHumanAudit:valid,
    evidenceSha:valid?digest34(packet):null,measurements,
    independentlyVerifiedRealOffsite:false,
    independentlyVerifiedRealRestore:false,
    realRollbackProven:false,productionDatabaseTouched:false,
    customerGo:false,productionAuthorized:false,
    blockers:[...new Set(issues)]};
}
