/**
 * R17: independently signed witness checkpoint of an exhaustive, hash-chained,
 * non-PII registry journal. NO trust-on-first-use: independent public keys and
 * a persistent DB revision/sequence fence remain mandatory to enable writes.
 */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {readOutsideCheckout} from './guest-tenant-authorization.mjs';
import {loadR16Registry} from './guest-r16-registry.mjs';

export const JOURNAL_SCHEMA='osmanx.guest.r17.journal.v1';
export const WITNESS_SCHEMA='osmanx.guest.r17.witness.v1';
export const WITNESS_MESSAGE_SCHEMA='osmanx.guest.r17.witness.message.v1';
export const WITNESS_REPORT_SCHEMA='osmanx.guest.r17.report.v1';
const SHA=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTOR=/^[A-Za-z0-9._-]{3,80}$/;
const SIG=/^[A-Za-z0-9+/]{86}==$/;
const EVENT_KEYS=['sequence','revision','event','tenantId','reasonCode','occurredAt','previousDigest','digest'];
const WITNESS_KEYS=['schema','role','actorId','releaseCommit','registryRevision',
  'registryDigest','journalSequence','journalHead','issuedAt','expiresAt','signature'];
const ACTIONS=['enrolled','revoked','reinstated','removed','published'];
const REASONS=['operator_request','security_incident','consent_withdrawn','contract_expired'];
const ENV_KEYS=['GUEST_R17_JOURNAL_FILE','GUEST_R17_OWNER_WITNESS_FILE',
  'GUEST_R17_MANAGER_WITNESS_FILE','GUEST_R17_OWNER_PUBLIC_KEY',
  'GUEST_R17_MANAGER_PUBLIC_KEY','GUEST_R17_MIN_SEQUENCE','GUEST_R17_MIN_REVISION'];
const HOUR=3600000;
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&
  Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const validInt=n=>Number.isSafeInteger(n)&&n>=1;
const utc=v=>typeof v==='string'&&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&
  Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const GENESIS='0'.repeat(64);
export function eventMessage(event){
  return JSON.stringify({
    sequence:event.sequence,revision:event.revision,event:event.event,
    tenantId:event.tenantId,reasonCode:event.reasonCode,occurredAt:event.occurredAt,
    previousDigest:event.previousDigest
  });
}
export function eventDigest(event){
  return createHash('sha256').update(eventMessage(event)).digest('hex');
}
export function witnessMessage(witness){
  return JSON.stringify({
    schema:WITNESS_MESSAGE_SCHEMA,role:witness.role,actorId:witness.actorId,
    releaseCommit:witness.releaseCommit,registryRevision:witness.registryRevision,
    registryDigest:witness.registryDigest,journalSequence:witness.journalSequence,
    journalHead:witness.journalHead,issuedAt:witness.issuedAt,expiresAt:witness.expiresAt
  });
}
function validKey(pem){
  const key=createPublicKey(pem);
  if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 witness key required');
  return key;
}
export function verifyJournal(journal,registry,now=new Date()){
  const blockers=[];
  const entries=journal?.entries;
  if(!exact(journal,['schema','entries'])||journal.schema!==JOURNAL_SCHEMA||
     !Array.isArray(entries)||entries.length<2||entries.length>4096)
    return {valid:false,blockers:['journal_shape'],head:null,sequence:null};
  let expectedSeq=1,head=GENESIS,published=0,revision=1;
  const enrolled=new Set(),revoked=new Map();
  for(const entry of entries){
    if(!exact(entry,EVENT_KEYS)||entry.sequence!==expectedSeq||
       entry.revision!==revision||!ACTIONS.includes(entry.event)||
       entry.previousDigest!==head||!utc(entry.occurredAt)||
       Date.parse(entry.occurredAt)>now.getTime()||
       !SHA.test(entry.digest||'')||eventDigest(entry)!==entry.digest){
      blockers.push('broken_hash_chain');break;
    }
    if(entry.event==='published'){
      if(entry.tenantId!==null||entry.reasonCode!==null){blockers.push('invalid_publication');break;}
      published=revision;revision++;
    }else{
      if(!UUID.test(entry.tenantId||'')||
        (entry.event==='revoked'?!REASONS.includes(entry.reasonCode):entry.reasonCode!==null)){
        blockers.push('invalid_actor_action');break;
      }
      if(entry.event==='enrolled'){
        if(enrolled.has(entry.tenantId))blockers.push('duplicate_enrollment');
        else enrolled.add(entry.tenantId);
      }else if(entry.event==='revoked'){
        if(!enrolled.has(entry.tenantId)||revoked.has(entry.tenantId))
          blockers.push('invalid_revocation');
        else revoked.set(entry.tenantId,{
          tenantId:entry.tenantId,reasonCode:entry.reasonCode,revokedAt:entry.occurredAt
        });
      }else if(entry.event==='reinstated'){
        if(!revoked.has(entry.tenantId))blockers.push('invalid_reinstatement');
        else revoked.delete(entry.tenantId);
      }else if(entry.event==='removed'){
        if(!enrolled.has(entry.tenantId)||revoked.has(entry.tenantId))
          blockers.push('invalid_removal');
        else enrolled.delete(entry.tenantId);
      }
    }
    head=entry.digest;expectedSeq++;
    if(blockers.length)break;
  }
  if(entries.at(-1)?.event!=='published'||published!==registry?.revision)
    blockers.push('journal_missing_publication');
  if(!Array.isArray(registry?.tenants)||!Array.isArray(registry?.revoked)||
    JSON.stringify([...enrolled].sort())!==
      JSON.stringify(registry.tenants.map(x=>x.tenantId).sort())||
    JSON.stringify([...revoked.values()].sort((a,b)=>a.tenantId.localeCompare(b.tenantId)))!==
      JSON.stringify([...registry.revoked].sort((a,b)=>a.tenantId.localeCompare(b.tenantId))))
    blockers.push('journal_registry_disagree');
  return {valid:blockers.length===0,blockers:[...new Set(blockers)],
    head:head,sequence:expectedSeq-1,registryRevision:published};
}
export function verifyWitnesses(owner,manager,keys,registry,journal,{now=new Date(),
  minSequence=1,minRevision=1,releaseCommit}={}){
  const blockers=[];
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw TypeError('Invalid clock');
  const j=verifyJournal(journal,registry,now);
  if(!j.valid)blockers.push(...j.blockers);
  const signatures=[owner,manager];
  const keyObjs={};
  try{
    keyObjs.owner=validKey(keys?.owner);keyObjs.manager=validKey(keys?.manager);
    if(keyObjs.owner.export({type:'spki',format:'der'}).equals(
      keyObjs.manager.export({type:'spki',format:'der'})))
      blockers.push('same_witness_key');
  }catch{blockers.push('untrusted_witness_keys');}
  const ref=digest(registry);
  const ts=new Set();
  for(const [i,role] of ['owner','manager'].entries()){
    const w=signatures[i];
    if(!exact(w,WITNESS_KEYS)||w.schema!==WITNESS_SCHEMA||w.role!==role||
       !ACTOR.test(w.actorId||'')||!SIG.test(w.signature||'')||
       Buffer.from(w.signature||'','base64').toString('base64')!==w.signature)
      {blockers.push('invalid_'+role+'_witness');continue;}
    ts.add(w.actorId);
    const start=utc(w.issuedAt)?Date.parse(w.issuedAt):NaN;
    const end=utc(w.expiresAt)?Date.parse(w.expiresAt):NaN;
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>now.getTime()||
       end<=now.getTime()||end-start>6*HOUR||now.getTime()-start>6*HOUR)
      blockers.push('expired_'+role+'_witness');
    if(!COMMIT.test(releaseCommit||'')||w.releaseCommit!==releaseCommit||
       w.registryRevision!==registry?.revision||w.registryDigest!==ref||
       w.journalSequence!==j.sequence||w.journalHead!==j.head||
       !validInt(minSequence)||!validInt(minRevision)||
       w.journalSequence<minSequence||w.registryRevision<minRevision)
      blockers.push('mismatch_'+role+'_checkpoint');
    try{
      if(!keyObjs[role]||!verify(null,Buffer.from(witnessMessage(w),'utf8'),
        keyObjs[role],Buffer.from(w.signature,'base64')))
        blockers.push('bad_'+role+'_signature');
    }catch{blockers.push('bad_'+role+'_signature');}
  }
  if(ts.size!==2)blockers.push('same_witness_human');
  if(owner?.issuedAt!==manager?.issuedAt||owner?.expiresAt!==manager?.expiresAt)
    blockers.push('witness_time_disagree');
  const checkpoint={revision:registry?.revision,sequence:j.sequence,
    registryDigest:ref,journalHead:j.head};
  return {schema:WITNESS_REPORT_SCHEMA,valid:blockers.length===0,
    blockers:[...new Set(blockers)],checkpoint,
    checkpointDigest:digest(checkpoint),writesChanged:false};
}
export function r17Configured(env=process.env){
  return Object.keys(env).some(k=>k.startsWith('GUEST_R17_'));
}
function config(env){
  if(ENV_KEYS.some(k=>typeof env[k]!=='string'||!env[k]))
    throw Error('R17 requires independent signed witnesses and journal');
  for(const k of ['GUEST_R17_MIN_SEQUENCE','GUEST_R17_MIN_REVISION'])
    if(!/^[1-9][0-9]{0,12}$/.test(env[k])||!validInt(Number(env[k])))
      throw Error('R17 requires pinned monotonic floors');
  if(!COMMIT.test(env.GUEST_RELEASE_COMMIT||''))
    throw Error('R17 requires immutable release SHA');
}
export async function loadR17Witness(env=process.env,now=new Date()){
  config(env);
  if(typeof env.GUEST_R16_REGISTRY_FILE!=='string')
    throw Error('R17 requires signed R16 registry');
  const ownerPath=resolve(env.GUEST_R17_OWNER_WITNESS_FILE);
  const managerPath=resolve(env.GUEST_R17_MANAGER_WITNESS_FILE);
  const journalPath=resolve(env.GUEST_R17_JOURNAL_FILE);
  if(ownerPath===managerPath||dirname(ownerPath)===dirname(managerPath)||
     dirname(ownerPath)===dirname(journalPath)||
     dirname(managerPath)===dirname(journalPath))
    throw Error('Independent R17 witness directories required');
  const r16=await loadR16Registry(env,now);
  const [journalText,ownerText,managerText,ownerKey,managerKey]=await Promise.all([
    readOutsideCheckout(journalPath,{privateFile:true}),
    readOutsideCheckout(ownerPath,{privateFile:true}),
    readOutsideCheckout(managerPath,{privateFile:true}),
    readOutsideCheckout(env.GUEST_R17_OWNER_PUBLIC_KEY),
    readOutsideCheckout(env.GUEST_R17_MANAGER_PUBLIC_KEY)
  ]);
  const report=verifyWitnesses(JSON.parse(ownerText),JSON.parse(managerText),
    {owner:ownerKey,manager:managerKey},r16.registry,JSON.parse(journalText),{
      now,minSequence:Number(env.GUEST_R17_MIN_SEQUENCE),
      minRevision:Number(env.GUEST_R17_MIN_REVISION),
      releaseCommit:env.GUEST_RELEASE_COMMIT
    });
  if(!report.valid)throw Error('R17 witness integrity or monotonic floor failed');
  return {checkpoint:report.checkpoint,checkpointDigest:report.checkpointDigest,
    registryDigest:r16.digest,sequence:report.checkpoint.sequence};
}
