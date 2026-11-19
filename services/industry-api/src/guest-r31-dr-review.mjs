/**
 * R31 offline DR copy/recovery attestation format, strictly metadata only.
 * Valid records are operator CLAIMS, not proof of actual offsite custody.
 * No DB connections, filesystem reads or restoration in this module.
 */
import {createHash} from 'node:crypto';
import {R30_PIN} from './guest-r31-chain.mjs';
export const R31_DR_SCHEMA='osmanx.guest.r31.offline-dr-recovery-review.v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const TIME=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const keys=['copyId','archiveSha','keyFingerprint','restoredChecksum',
  'restoredRows','restoreTarget','encrypted','localDisposable','observedAt'];
const top=['schema','pilotId','releaseCommit','issuedAt','source','copies',
  'productionDatabaseTouched'];
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===k.slice().sort().join('|');
const timestamp=s=>typeof s==='string'&&TIME.test(s)&&
  Number.isFinite(Date.parse(s))&&new Date(Date.parse(s)).toISOString()===s;
export const r31Hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function makeR31DrRehearsal({pilotId,copies,source='synthetic',
  now=new Date()}={}){
  if(!['synthetic','operator-claimed'].includes(source)||
    !(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw new TypeError('DR origin and UTC time required');
  const body={schema:R31_DR_SCHEMA,pilotId,releaseCommit:R30_PIN.sha,
    issuedAt:now.toISOString(),source,copies,productionDatabaseTouched:false};
  return {...body,sha256:r31Hash(body)};
}
export function reviewR31DrRehearsal(packet,{
  pilotId,now=new Date()
}={}){
  const errors=[],ids=new Set(),archives=new Set(),keysSeen=new Set(),
    targets=new Set(),checksums=new Set(),counts=new Set();
  if(!exact(packet,[...top,'sha256'])||
    packet?.schema!==R31_DR_SCHEMA||!UUID.test(packet?.pilotId||'')||
    packet?.releaseCommit!==R30_PIN.sha||
    !SHA.test(packet?.sha256||'')||
    !timestamp(packet?.issuedAt)||
    !['synthetic','operator-claimed'].includes(packet?.source)||
    packet?.productionDatabaseTouched!==false)
    errors.push('BAD_DR_ENVELOPE');
  if(pilotId!==undefined&&packet?.pilotId!==pilotId)
    errors.push('WRONG_PILOT');
  const issued=Date.parse(packet?.issuedAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(issued)||issued>now.getTime()||
    now.getTime()-issued>10*60000)errors.push('STALE_DR_PACKET');
  if(!Array.isArray(packet?.copies)||packet.copies.length!==2)
    errors.push('REQUIRE_TWO_INDEPENDENT_COPIES');
  for(const x of Array.isArray(packet?.copies)?packet.copies.slice(0,3):[]){
    if(!exact(x,keys)||!['A','B'].includes(x.copyId)||
      !SHA.test(x.archiveSha||'')||!SHA.test(x.keyFingerprint||'')||
      !SHA.test(x.restoredChecksum||'')||
      !Number.isSafeInteger(x.restoredRows)||x.restoredRows<0||
      x.restoredRows>1000000||
      !/^industry_dr_r31_[a-z0-9]{6,16}$/.test(x.restoreTarget||'')||
      x.encrypted!==true||x.localDisposable!==true||
      !timestamp(x.observedAt)||Date.parse(x.observedAt)<issued||
      Date.parse(x.observedAt)>now.getTime()){
      errors.push('INVALID_DISPOSABLE_RECOVERY');continue;
    }
    ids.add(x.copyId);archives.add(x.archiveSha);
    keysSeen.add(x.keyFingerprint);targets.add(x.restoreTarget);
    checksums.add(x.restoredChecksum);counts.add(x.restoredRows);
  }
  if(ids.size!==2||archives.size!==2||keysSeen.size!==2||
    targets.size!==2)errors.push('COPIES_NOT_INDEPENDENT');
  if(checksums.size!==1||counts.size!==1)
    errors.push('RESTORE_DATA_MISMATCH');
  try{
    if(exact(packet,[...top,'sha256'])){
      const {sha256,...payload}=packet;
      if(r31Hash(payload)!==sha256)errors.push('TAMPERED_DR_PACKET');
    }
  }catch{errors.push('BAD_DR_DIGEST');}
  return {
    schema:'osmanx.guest.r31.dr-metadata-review.v1',
    metadataConsistent:errors.length===0,
    copyCount:Array.isArray(packet?.copies)?packet.copies.length:0,
    independentKeysAndArchives:ids.size===2&&archives.size===2&&keysSeen.size===2,
    sourceSynthetic:packet?.source==='synthetic',
    externalCustodyIndependentlyVerified:false,
    actualRestoreIndependentlyWitnessed:false,
    productionDatabaseTouched:false,
    blockers:[...new Set(errors)],productionAuthorized:false,customerGo:false
  };
}
