/**
 * R19: deliberately scoped first-customer collection permit. An independently
 * signed pilot scope ADDS to R12-R18 and never substitutes for legal consent.
 * A one-way private STOP is available to operators even if the API is down.
 */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import {resolve,dirname,basename,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readOutsideCheckout} from './guest-tenant-authorization.mjs';
import {loadR18Anchor,r18Configured} from './guest-r18-anchor.mjs';

export const SCOPE_SCHEMA='osmanx.guest.r19.single-pilot-scope.v1';
export const SCOPE_MESSAGE_SCHEMA='osmanx.guest.r19.scope.message.v1';
export const POLICY_KEYS=Object.freeze([
  'purpose','maxDailyWrites','retentionDays','contractEvidenceSha',
  'privacyEvidenceSha','consentEvidenceSha'
]);
export const SCOPE_FIELDS=Object.freeze([
  'schema','tenantId','pilotId','releaseCommit','checkpointDigest',
  'journalSequence','protocolDigest','policy','actorId','issuedAt',
  'expiresAt','signature'
]);
export const UNSIGNED_FIELDS=SCOPE_FIELDS.filter(x=>x!=='signature');
const REQUIRED=['GUEST_R19_SCOPE_FILE','GUEST_R19_OPERATOR_PUBLIC_KEY',
  'GUEST_R19_STOP_FILE','GUEST_R19_MIN_SEQUENCE','GUEST_R19_ROLLOUT_ENABLED'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT=/^[0-9a-f]{40}$/;
const SHA=/^[0-9a-f]{64}$/;
const HUMAN=/^[A-Za-z0-9._-]{3,80}$/;
const SIGNATURE=/^[A-Za-z0-9+/]{86}==$/;
const MAX_WINDOW=7*86400000;
const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).sort().join('|')===[...keys].sort().join('|');
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const utc=value=>typeof value==='string'&&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export const scopeDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function protocolDigest({id,protocol,protocol_registered_at}){
  if(!UUID.test(id||'')||!protocol||typeof protocol!=='object'||
     !protocol_registered_at)throw Error('R19 requires a previously registered protocol');
  const timestamp=protocol_registered_at instanceof Date?
    protocol_registered_at.toISOString():new Date(protocol_registered_at).toISOString();
  return scopeDigest({
    schema:'osmanx.guest.r19.protocol.v1',pilotId:id,protocol,
    protocolRegisteredAt:timestamp
  });
}
export function scopeMessage(record){
  return JSON.stringify({
    schema:SCOPE_MESSAGE_SCHEMA,tenantId:record.tenantId,pilotId:record.pilotId,
    releaseCommit:record.releaseCommit,checkpointDigest:record.checkpointDigest,
    journalSequence:record.journalSequence,protocolDigest:record.protocolDigest,
    policy:record.policy,actorId:record.actorId,
    issuedAt:record.issuedAt,expiresAt:record.expiresAt
  });
}
export function collectionOperation(url,method){
  if(method!=='POST'||typeof url!=='string')return null;
  const path=url.split('?')[0];
  const matched=/^\/api\/industry\/v1\/guest\/pilots\/([0-9a-f-]{36})\/(start|observations|observations\/import)$/.exec(path);
  if(!matched||!UUID.test(matched[1]))return null;
  return {pilotId:matched[1],kind:matched[2]};
}
export function r19Configured(env=process.env){
  return Object.keys(env).some(k=>k.startsWith('GUEST_R19_'));
}
export function verifyR19Scope(record,{operator,externalCustodian},anchor,{
  releaseCommit,now=new Date(),minSequence=1,externalActor=null
}={}){
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw TypeError('R19 invalid clock');
  const blockers=[];
  if(!exact(record,SCOPE_FIELDS)||record.schema!==SCOPE_SCHEMA||
    !UUID.test(record.tenantId||'')||!UUID.test(record.pilotId||'')||
    !COMMIT.test(record.releaseCommit||'')||
    !SHA.test(record.checkpointDigest||'')||
    !SHA.test(record.protocolDigest||'')||
    !integer(record.journalSequence,1,Number.MAX_SAFE_INTEGER)||
    !HUMAN.test(record.actorId||'')||
    !SIGNATURE.test(record.signature||'')||
    Buffer.from(record.signature||'','base64').toString('base64')!==record.signature)
    blockers.push('invalid_scope_structure');
  const policy=record?.policy;
  if(!exact(policy,POLICY_KEYS)||
    policy.purpose!=='repeat_visit_aggregate_only'||
    !integer(policy.maxDailyWrites,1,100)||
    !integer(policy.retentionDays,1,90)||
    !SHA.test(policy.contractEvidenceSha||'')||
    !SHA.test(policy.privacyEvidenceSha||'')||
    !SHA.test(policy.consentEvidenceSha||'')||
    new Set([policy.contractEvidenceSha,policy.privacyEvidenceSha,
      policy.consentEvidenceSha]).size!==3)
    blockers.push('invalid_evidence_policy');
  const issued=utc(record?.issuedAt)?Date.parse(record.issuedAt):NaN;
  const expiry=utc(record?.expiresAt)?Date.parse(record.expiresAt):NaN;
  if(!Number.isFinite(issued)||!Number.isFinite(expiry)||
    issued>now.getTime()||expiry<=now.getTime()||expiry<=issued||
    expiry-issued>MAX_WINDOW)
    blockers.push('expired_scope');
  if(!COMMIT.test(releaseCommit||'')||record?.releaseCommit!==releaseCommit||
    record?.checkpointDigest!==anchor?.checkpointDigest||
    record?.journalSequence!==anchor?.sequence||
    !integer(minSequence,1,Number.MAX_SAFE_INTEGER)||
    record?.journalSequence<minSequence)
    blockers.push('scope_checkpoint_mismatch');
  if(record?.actorId===externalActor||!HUMAN.test(externalActor||''))
    blockers.push('not_independent_custodian');
  try{
    const one=createPublicKey(operator),two=createPublicKey(externalCustodian);
    if(one.asymmetricKeyType!=='ed25519'||two.asymmetricKeyType!=='ed25519'||
       one.export({type:'spki',format:'der'}).equals(
         two.export({type:'spki',format:'der'})))
      blockers.push('untrusted_operator_key');
    if(!verify(null,Buffer.from(scopeMessage(record),'utf8'),one,
      Buffer.from(record.signature||'','base64')))
      blockers.push('bad_operator_signature');
  }catch{blockers.push('bad_operator_signature');}
  return {schema:'osmanx.guest.r19.scope-report.v1',valid:blockers.length===0,
    blockers:[...new Set(blockers)],tenantId:UUID.test(record?.tenantId||'')?record.tenantId:null,
    pilotId:UUID.test(record?.pilotId||'')?record.pilotId:null,
    scopeDigest:record&&typeof record==='object'?scopeDigest(record):null,
    maxDailyWrites:integer(policy?.maxDailyWrites,1,100)?policy.maxDailyWrites:null,
    expiresAt:utc(record?.expiresAt)?record.expiresAt:null,
    writesChanged:false,customerGo:false,legalEvidenceReviewedExternally:false};
}
const privatePath=(path,name)=>{
  if(typeof path!=='string'||!path.startsWith('/')||
    basename(path)!==name||resolve(path)!==path)throw Error('R19 private path rejected');
  const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
  if(path===root||path.startsWith(root+sep))throw Error('R19 sources cannot reside in checkout');
  return path;
};
async function stopped(path){
  privatePath(path,'STOP');
  const parent=dirname(path);
  if(await realpath(parent)!==parent)throw Error('R19 stop location is symlinked');
  try{
    const st=await lstat(path);
    if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0)
      throw Error('R19 stop marker invalid; fail closed');
    return true;
  }catch(e){if(e?.code==='ENOENT')return false;throw e;}
}
function assertConfig(env){
  if(REQUIRED.some(key=>typeof env[key]!=='string'||!env[key])||
     env.GUEST_R19_ROLLOUT_ENABLED!=='true')
    throw Error('R19 operator-controlled rollout not enabled');
  if(!r18Configured(env))throw Error('R19 requires independent R18 custodian');
  if(!/^[1-9]\d{0,12}$/.test(env.GUEST_R19_MIN_SEQUENCE)||!integer(
    Number(env.GUEST_R19_MIN_SEQUENCE),1,Number.MAX_SAFE_INTEGER))
    throw Error('R19 external sequence floor invalid');
  privatePath(env.GUEST_R19_SCOPE_FILE,'scope.json');
  privatePath(env.GUEST_R19_STOP_FILE,'STOP');
  if(dirname(env.GUEST_R19_OPERATOR_PUBLIC_KEY)===dirname(env.GUEST_R19_SCOPE_FILE))
    throw Error('R19 public trust key cannot share scope directory');
}
export async function loadR19Scope(env=process.env,anchor=null,now=new Date()){
  assertConfig(env);
  if(await stopped(env.GUEST_R19_STOP_FILE))throw Error('R19 one-way STOP active');
  const source=anchor??await loadR18Anchor(env,null,now);
  const [scopeText,keyText,custodianText,anchorText]=await Promise.all([
    readOutsideCheckout(env.GUEST_R19_SCOPE_FILE,{privateFile:true}),
    readOutsideCheckout(env.GUEST_R19_OPERATOR_PUBLIC_KEY),
    readOutsideCheckout(env.GUEST_R18_CUSTODIAN_PUBLIC_KEY),
    readOutsideCheckout(env.GUEST_R18_ANCHOR_FILE,{privateFile:true})
  ]);
  const report=verifyR19Scope(JSON.parse(scopeText),{
    operator:keyText,externalCustodian:custodianText
  },source,{
    releaseCommit:env.GUEST_RELEASE_COMMIT,now,
    minSequence:Number(env.GUEST_R19_MIN_SEQUENCE),
    externalActor:JSON.parse(anchorText).actorId
  });
  if(!report.valid)throw Error('R19 scope signature, evidence or checkpoint failed');
  return {...report,
    // Internal source record never goes to a browser.
    record:JSON.parse(scopeText)};
}
export async function inspectR19Scope(tenantId,env=process.env,anchor=null,now=new Date()){
  try{
    const value=await loadR19Scope(env,anchor,now);
    if(value.tenantId!==tenantId)
      return {valid:false,reason:'tenant_not_in_rollout',pilotId:null};
    return {valid:true,reason:'signed_pilot_scope',pilotId:value.pilotId,
      expiresAt:value.expiresAt,maxDailyWrites:value.maxDailyWrites,
      scopeDigest:value.scopeDigest};
  }catch{return {valid:false,reason:'scope_unavailable_or_stopped',pilotId:null};}
}
