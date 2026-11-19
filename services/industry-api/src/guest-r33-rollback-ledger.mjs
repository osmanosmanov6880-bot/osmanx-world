/**
 * Rehearsal-only SHA-256 event chain for an isolated rollback. Never connects
 * to PostgreSQL and never permits restoring or changing production state.
 */
import {r33Hash,r33Timestamp}
  from './guest-r33-signatures.mjs';
import {R32_PIN} from './guest-r33-source.mjs';
export const R33_ROLLBACK_SCHEMA='osmanx.guest.r33.disposable-rollback.v1';
export const R33_STEPS=Object.freeze([
  'checkpoint','isolate','restore','verify','abort'
]);
const ROLES=['release_manager','recovery_lead','recovery_lead',
  'independent_auditor','release_manager'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const SHA40=/^[a-f0-9]{40}$/;
const TOP=['schema','tenantId','pilotId','releaseSha','sourceTreeSha',
  'changeId','issuedAt','target','mode','productionTouched',
  'events','finalSha'];
const ENTRY=['seq','step','actorRole','actorId','target','at','status',
  'previousSha','sha256'];
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===keys.slice().sort().join('|');
const entryHash=e=>r33Hash({
  schema:'osmanx.guest.r33.rollback-event.v1',
  seq:e.seq,step:e.step,actorRole:e.actorRole,actorId:e.actorId,
  target:e.target,at:e.at,status:e.status,previousSha:e.previousSha
});
export function makeR33RollbackLedger({tenantId,pilotId,sourceTreeSha,
  changeId,target,events,issuedAt}={}){
  const input={schema:R33_ROLLBACK_SCHEMA,tenantId,pilotId,
    releaseSha:R32_PIN.sha,sourceTreeSha,changeId,issuedAt,
    target,mode:'simulated',productionTouched:false,events:[],
    finalSha:'0'.repeat(64)};
  if(!Array.isArray(events))throw new TypeError('Events required');
  for(const event of events){
    const item={...event,previousSha:input.finalSha};
    item.sha256=entryHash(item);
    input.events.push(item);
    input.finalSha=item.sha256;
  }
  return input;
}
export function verifyR33RollbackLedger(ledger,{tenantId,pilotId,
  now=new Date()}={}){
  const blockers=[];
  if(!exact(ledger,TOP)||ledger?.schema!==R33_ROLLBACK_SCHEMA||
    !UUID.test(ledger?.tenantId||'')||
    !UUID.test(ledger?.pilotId||'')||
    ledger?.releaseSha!==R32_PIN.sha||
    !SHA40.test(ledger?.sourceTreeSha||'')||
    !UUID.test(ledger?.changeId||'')||
    !/^industry_dr_r33_[a-z0-9]{6,16}$/.test(ledger?.target||'')||
    ledger?.mode!=='simulated'||ledger?.productionTouched!==false||
    !SHA.test(ledger?.finalSha||'')||
    !r33Timestamp(ledger?.issuedAt))
    blockers.push('INVALID_ROLLBACK_ENVELOPE');
  if(tenantId!==undefined&&ledger?.tenantId!==tenantId)
    blockers.push('TENANT_MISMATCH');
  if(pilotId!==undefined&&ledger?.pilotId!==pilotId)
    blockers.push('PILOT_MISMATCH');
  if(!Array.isArray(ledger?.events)||ledger.events.length!==5)
    blockers.push('FIVE_SEQUENCE_EVENTS_REQUIRED');
  let previous='0'.repeat(64),last=Date.parse(ledger?.issuedAt);
  const seen=new Set(),roles=new Map(),actors=new Map();
  for(const [index,event] of (Array.isArray(ledger?.events)?
    ledger.events.slice(0,6):[]).entries()){
    if(!exact(event,ENTRY)||event.seq!==index+1||
      event.step!==R33_STEPS[index]||event.actorRole!==ROLES[index]||
      !/^[a-z][a-z0-9_-]{3,31}$/.test(event.actorId||'')||
      event.target!==ledger.target||
      event.status!==(index===4?'aborted':'pass')||
      !r33Timestamp(event.at)||event.previousSha!==previous||
      !SHA.test(event.sha256||'')||
      entryHash(event)!==event.sha256){
      blockers.push('INVALID_OR_TAMPERED_ROLLBACK_CHAIN');break;
    }
    if(seen.has(event.seq))blockers.push('REPLAYED_SEQUENCE');
    seen.add(event.seq);
    roles.set(event.actorRole,event.actorId);
    actors.set(event.actorId,event.actorRole);
    const time=Date.parse(event.at);
    if(!Number.isFinite(time)||time<last||
      time>now.getTime()||time-Date.parse(ledger.issuedAt)>10*60000)
      blockers.push('INVALID_REHEARSAL_CLOCK');
    last=time;previous=event.sha256;
  }
  if(previous!==ledger?.finalSha)
    blockers.push('BROKEN_FINAL_SHA');
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(Date.parse(ledger?.issuedAt))||
    Date.parse(ledger.issuedAt)>now.getTime()||
    now.getTime()-Date.parse(ledger.issuedAt)>10*60000)
    blockers.push('STALE_REHEARSAL');
  if(roles.size!==3||actors.size!==3||
    roles.get('release_manager')===roles.get('recovery_lead')||
    roles.get('release_manager')===roles.get('independent_auditor')||
    roles.get('recovery_lead')===roles.get('independent_auditor'))
    blockers.push('SEPARATION_OF_DUTIES_FAILED');
  return {schema:'osmanx.guest.r33.rollback-chain-verification.v1',
    rehearsalMetadataPass:blockers.length===0,
    finalSha:SHA.test(ledger?.finalSha||'')?ledger.finalSha:null,
    targetIsDisposable:true,simulationOnly:true,
    actualOffsiteRecoveryVerified:false,liveRollbackExecuted:false,
    productionTouched:false,stopLifted:false,customerGo:false,
    productionAuthorized:false,blockers:[...new Set(blockers)]};
}
