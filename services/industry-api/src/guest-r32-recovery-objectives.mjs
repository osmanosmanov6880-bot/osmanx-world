/**
 * R32 offline recovery SLO metrics on top of R31 disposable DR metadata.
 * Measures only timestamp arithmetic and SHA-bounded row comparisons.
 * Actual backups and offsite custody require independent real-world proof.
 */
import {reviewR31DrRehearsal} from './guest-r31-dr-review.mjs';
import {R31_PIN} from './guest-r32-source.mjs';
export const R32_RECOVERY_SCHEMA='osmanx.guest.r32.recovery-objectives.v1';
const SHA=/^[a-f0-9]{64}$/;
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===k.slice().sort().join('|');
const TIME=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const validTime=x=>typeof x==='string'&&TIME.test(x)&&
  Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;
const ENTRY=['copyId','archiveSha','restoreStartedAt','restoreFinishedAt',
  'expectedLastEventAt','recoveredLastEventAt','confirmedChecksum',
  'confirmedRows'];
const OUTER=['schema','pilotId','releaseSha','rehearsalSha','targetRtoMinutes',
  'targetRpoMinutes','samples'];
export function assessR32RecoveryObjectives({dr,record,now=new Date()}={}){
  const blockers=[],rehearsal=reviewR31DrRehearsal(dr,{
    pilotId:record?.pilotId,now});
  if(!rehearsal.metadataConsistent||
    dr?.source!=='operator-claimed')
    blockers.push('R31_DISPOSABLE_RESTORE_UNVERIFIED');
  if(!exact(record,OUTER)||record?.schema!==R32_RECOVERY_SCHEMA||
    record?.releaseSha!==R31_PIN.sha||
    !SHA.test(record?.rehearsalSha||'')||
    record?.rehearsalSha!==dr?.sha256||
    record?.pilotId!==dr?.pilotId||
    !Number.isSafeInteger(record?.targetRtoMinutes)||
    record.targetRtoMinutes<1||record.targetRtoMinutes>60||
    !Number.isSafeInteger(record?.targetRpoMinutes)||
    record.targetRpoMinutes<0||record.targetRpoMinutes>60||
    !Array.isArray(record?.samples)||record.samples.length!==2)
    blockers.push('INVALID_RECOVERY_TARGETS');
  const seen=new Set(),metrics=[];
  for(const s of Array.isArray(record?.samples)?record.samples.slice(0,3):[]){
    const copy=Array.isArray(dr?.copies)?
      dr.copies.find(x=>x?.copyId===s?.copyId):null;
    if(!exact(s,ENTRY)||!['A','B'].includes(s.copyId)||
      seen.has(s.copyId)||!copy||
      s.archiveSha!==copy.archiveSha||
      s.confirmedChecksum!==copy.restoredChecksum||
      s.confirmedRows!==copy.restoredRows||
      ![s.restoreStartedAt,s.restoreFinishedAt,
        s.expectedLastEventAt,s.recoveredLastEventAt].every(validTime)){
      blockers.push('UNTRUSTED_RECOVERY_SAMPLE');continue;
    }
    seen.add(s.copyId);
    const start=Date.parse(s.restoreStartedAt),
      finish=Date.parse(s.restoreFinishedAt),
      expected=Date.parse(s.expectedLastEventAt),
      recovered=Date.parse(s.recoveredLastEventAt);
    if(finish<start||finish>now.getTime()||start<Date.parse(dr?.issuedAt)||
      expected<recovered||expected>finish||recovered>finish||
      start>now.getTime()){
      blockers.push('INVALID_RECOVERY_CHRONOLOGY');continue;
    }
    const rtoMinutes=(finish-start)/60000,
      rpoMinutes=(expected-recovered)/60000;
    metrics.push({copyId:s.copyId,rtoMinutes,rpoMinutes});
    if(rtoMinutes>record.targetRtoMinutes)
      blockers.push('RTO_EXCEEDED_'+s.copyId);
    if(rpoMinutes>record.targetRpoMinutes)
      blockers.push('RPO_EXCEEDED_'+s.copyId);
  }
  if(seen.size!==2||metrics.length!==2)
    blockers.push('TWO_VALID_RECOVERY_MEASUREMENTS_REQUIRED');
  return {schema:'osmanx.guest.r32.recovery-objectives-review.v1',
    metadataMetricsPass:blockers.length===0,
    measurements:metrics,sourceSynthetic:dr?.source==='synthetic',
    actualOffsiteRestoreVerified:false,externalCustodyVerified:false,
    liveDatabaseTouched:false,productionAuthorized:false,
    customerGo:false,blockers:[...new Set(blockers)]};
}
