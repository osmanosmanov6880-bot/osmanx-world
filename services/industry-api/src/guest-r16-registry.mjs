/**
 * R16 signed multi-tenant admission registry, hot revocation and rollback floor.
 *
 * No credentials / customer data are stored here. An allowlisted tenant still
 * needs its OWN fresh R14 evidence plus R15 two-human signed permit.
 *
 * Registry is operator-signed by two separate platform Ed25519 trust anchors.
 * R16 is opt-in; a malformed R16 configuration may NEVER fall back to R15.
 * STOP files are fail-closed on every mutation; no API can clear them.
 */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {lstat,open} from 'node:fs/promises';
import {dirname,basename,join,resolve} from 'node:path';
import {readOutsideCheckout,inspectTenantPermit} from './guest-tenant-authorization.mjs';

export const R16_SCHEMA='osmanx.guest.r16.registry.v1';
export const R16_SIGNING_SCHEMA='osmanx.guest.r16.registry.signature.v1';
export const R16_REPORT_SCHEMA='osmanx.guest.r16.tenant-status.v1';
const COMMIT=/^[a-f0-9]{40}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HUMAN=/^[A-Za-z0-9._-]{3,80}$/;
const SIGNATURE=/^[A-Za-z0-9+/]{86}==$/;
const REASONS=['operator_request','security_incident','consent_withdrawn','contract_expired'];
const MANIFEST_KEYS=['schema','releaseCommit','revision','issuedAt','expiresAt','tenants','revoked','attestations'];
const SIGNATURE_KEYS=['role','actorId','signature'];
const REVOKED_KEYS=['tenantId','reasonCode','revokedAt'];
const REQUIRED_ENV=['GUEST_RELEASE_COMMIT','GUEST_R16_REGISTRY_FILE','GUEST_R16_OWNER_PUBLIC_KEY',
  'GUEST_R16_MANAGER_PUBLIC_KEY','GUEST_R16_MIN_REVISION'];
const ONE_HOUR=3600000;
const seen=new Map(); // process-local rollback barrier; independent persistent floor lives in protected env.

const exact=(obj,keys)=>!!obj&&typeof obj==='object'&&!Array.isArray(obj)&&
  Object.keys(obj).sort().join('|')===[...keys].sort().join('|');
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validUtc=value=>typeof value==='string'&&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const validRevision=n=>Number.isSafeInteger(n)&&n>=1;
const approvalKey=pem=>{
  const key=createPublicKey(pem);
  if(key.asymmetricKeyType!=='ed25519')throw Error('Expected Ed25519 key');
  return key;
};
function uniqueSorted(ids){return ids.every((id,i)=>i===0||ids[i-1]<id)}
function validSignatures(values){
  return Array.isArray(values)&&values.length===2&&
    values.filter(x=>x?.role==='owner').length===1&&
    values.filter(x=>x?.role==='manager').length===1&&
    values.every(x=>exact(x,SIGNATURE_KEYS)&&HUMAN.test(x.actorId||'')&&
      typeof x.signature==='string'&&SIGNATURE.test(x.signature)&&
      Buffer.from(x.signature,'base64').toString('base64')===x.signature)&&
    values[0].actorId!==values[1].actorId;
}
export function registryMessage(registry,approval){
  return JSON.stringify({
    schema:R16_SIGNING_SCHEMA,role:approval.role,actorId:approval.actorId,
    registry:{
      schema:registry.schema,releaseCommit:registry.releaseCommit,
      revision:registry.revision,issuedAt:registry.issuedAt,
      expiresAt:registry.expiresAt,tenants:registry.tenants,revoked:registry.revoked
    }
  });
}
export function evaluateRegistry(registry,keys,releaseCommit,minRevision=1,now=new Date()){
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw TypeError('Invalid clock');
  const blockers=[];
  if(!exact(registry,MANIFEST_KEYS)||registry?.schema!==R16_SCHEMA)
    blockers.push('invalid_registry_shape');
  if(!COMMIT.test(releaseCommit||'')||registry?.releaseCommit!==releaseCommit)
    blockers.push('release_mismatch');
  if(!validRevision(registry?.revision)||!validRevision(minRevision)||
     registry?.revision<minRevision)blockers.push('rollback_floor');
  const start=validUtc(registry?.issuedAt)?Date.parse(registry.issuedAt):NaN;
  const end=validUtc(registry?.expiresAt)?Date.parse(registry.expiresAt):NaN;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>now.getTime()||
     end<=now.getTime()||end<=start||end-start>12*ONE_HOUR||
     now.getTime()-start>12*ONE_HOUR)
    blockers.push('registry_freshness');
  const tenants=registry?.tenants;
  if(!Array.isArray(tenants)||tenants.length>64||
     !tenants.every(x=>exact(x,['tenantId'])&&UUID.test(x.tenantId))||
     !uniqueSorted(tenants.map(x=>x?.tenantId)))
    blockers.push('invalid_tenant_index');
  const revoked=registry?.revoked;
  if(!Array.isArray(revoked)||revoked.length>256||
     !revoked.every(x=>exact(x,REVOKED_KEYS)&&UUID.test(x.tenantId)&&
       REASONS.includes(x.reasonCode)&&validUtc(x.revokedAt)&&
       Date.parse(x.revokedAt)<=now.getTime())||
     !uniqueSorted(revoked.map(x=>x?.tenantId)))
    blockers.push('invalid_revocation_index');
  if(!validSignatures(registry?.attestations))
    blockers.push('independent_operator_signatures');
  let owner,manager;
  try{
    owner=approvalKey(keys?.owner);manager=approvalKey(keys?.manager);
    if(owner.export({type:'spki',format:'der'}).equals(
      manager.export({type:'spki',format:'der'})))
      blockers.push('identical_operator_keys');
  }catch{blockers.push('invalid_operator_keys');}
  for(const role of ['owner','manager']){
    const entry=Array.isArray(registry?.attestations)?
      registry.attestations.find(x=>x?.role===role):null;
    if(!entry||!validSignatures(registry?.attestations))continue;
    try{
      if(!verify(null,Buffer.from(registryMessage(registry,entry),'utf8'),
        role==='owner'?owner:manager,Buffer.from(entry.signature,'base64')))
        blockers.push('bad_'+role+'_signature');
    }catch{blockers.push('bad_'+role+'_signature');}
  }
  return {
    schema:'osmanx.guest.r16.registry.report.v1',
    valid:blockers.length===0,
    blockers:[...new Set(blockers)],
    revision:validRevision(registry?.revision)?registry.revision:null,
    tenantCount:Array.isArray(tenants)?tenants.length:0,
    revokedCount:Array.isArray(revoked)?revoked.length:0,
    productionWritesEnabled:false
  };
}
export function r16Configured(env=process.env){
  return Object.keys(env).some(key=>key.startsWith('GUEST_R16_'));
}
function requiredConfig(env){
  if(REQUIRED_ENV.some(key=>typeof env[key]!=='string'||!env[key].length))
    throw Error('Incomplete R16 registry configuration');
  if(!/^[1-9][0-9]{0,12}$/.test(env.GUEST_R16_MIN_REVISION))
    throw Error('Missing signed revision floor');
  const floor=Number(env.GUEST_R16_MIN_REVISION);
  if(!validRevision(floor)||!COMMIT.test(env.GUEST_RELEASE_COMMIT))
    throw Error('Invalid immutable release/floor');
  if(basename(env.GUEST_R16_REGISTRY_FILE)!=='registry.json')
    throw Error('R16 registry file must be named registry.json');
  return floor;
}
function barrier(root,revision,digest){
  const prior=seen.get(root);
  if(prior&&(revision<prior.revision||
    (revision===prior.revision&&digest!==prior.digest)))
    throw Error('Signed registry rollback or revision replay');
  seen.set(root,{revision,digest});
}
async function stopped(path){
  try{await lstat(path);return true;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
}
export async function loadR16Registry(env=process.env,now=new Date()){
  const floor=requiredConfig(env);
  const [record,owner,manager]=await Promise.all([
    readOutsideCheckout(env.GUEST_R16_REGISTRY_FILE,{privateFile:true}),
    readOutsideCheckout(env.GUEST_R16_OWNER_PUBLIC_KEY),
    readOutsideCheckout(env.GUEST_R16_MANAGER_PUBLIC_KEY)
  ]);
  const registry=JSON.parse(record);
  const report=evaluateRegistry(registry,{owner,manager},
    env.GUEST_RELEASE_COMMIT,floor,now);
  if(!report.valid)throw Error('R16 registry is invalid or expired');
  const root=dirname(resolve(env.GUEST_R16_REGISTRY_FILE));
  barrier(root,registry.revision,sha(registry));
  return {root,registry,revision:registry.revision,digest:sha(registry)};
}
function restrictedStatus(tenantId,revision,reason,permitValid=false,validUntil=null){
  return {schema:R16_REPORT_SCHEMA,tenantId,
    registryRevision:revision,permitValid,reason,validUntil,
    writesChanged:false};
}
export async function inspectR16Tenant(tenantId,env=process.env,now=new Date()){
  if(!UUID.test(tenantId||''))return restrictedStatus(null,null,'invalid_tenant');
  let bundle;
  try{bundle=await loadR16Registry(env,now);}
  catch{return restrictedStatus(tenantId,null,'registry_unavailable');}
  const {root,registry,revision}=bundle;
  try{
    if(await stopped(join(root,'STOP')))
      return restrictedStatus(tenantId,revision,'global_emergency_stop');
    if(!registry.tenants.some(x=>x.tenantId===tenantId))
      return restrictedStatus(tenantId,revision,'not_enrolled');
    if(registry.revoked.some(x=>x.tenantId===tenantId))
      return restrictedStatus(tenantId,revision,'revoked');
    const prefix=join(root,'tenants',tenantId);
    if(await stopped(join(prefix,'STOP')))
      return restrictedStatus(tenantId,revision,'tenant_emergency_stop');
    // Deterministic paths, never user-controlled arbitrary file names.
    const [admissionText,permitText,owner,manager]=await Promise.all([
      readOutsideCheckout(join(prefix,'admission.json'),{privateFile:true}),
      readOutsideCheckout(join(prefix,'permit.json'),{privateFile:true}),
      readOutsideCheckout(join(prefix,'owner.pub.pem')),
      readOutsideCheckout(join(prefix,'manager.pub.pem'))
    ]);
    const report=inspectTenantPermit({
      admission:JSON.parse(admissionText),permit:JSON.parse(permitText),
      keys:{owner,manager},tenantId,releaseCommit:env.GUEST_RELEASE_COMMIT,now
    });
    if(!report.permitValid)
      return restrictedStatus(tenantId,revision,'invalid_signed_tenant_permit');
    // All revocation markers and exact operator-signed index are rechecked
    // after reading evidence, blocking file changes during the await.
    const check=await loadR16Registry(env,now);
    if(check.digest!==bundle.digest||await stopped(join(root,'STOP'))||
       await stopped(join(prefix,'STOP')))
      return restrictedStatus(tenantId,revision,'registry_changed_or_stopped');
    return restrictedStatus(tenantId,revision,'authorized',true,report.validUntil);
  }catch{
    return restrictedStatus(tenantId,revision,'private_evidence_unavailable');
  }
}
export async function assertR16Tenant(tenantId,env=process.env,now=new Date()){
  const report=await inspectR16Tenant(tenantId,env,now);
  if(!report.permitValid){
    const error=new Error('R16: запись компании остановлена или допуск недействителен');
    error.statusCode=503;
    throw error;
  }
  return report;
}
export async function emergencyStop(registryFile,{tenantId=null,ack=''}={}){
  if(ack!=='CONFIRM_R16_STOP_NO_RESUME')throw Error('Explicit stop acknowledgment required');
  if(typeof registryFile!=='string'||basename(registryFile)!=='registry.json')
    throw Error('Exact private registry.json path required');
  // Check operator-selected parent is a real external path, not repo/symlink.
  await readOutsideCheckout(registryFile,{privateFile:true});
  if(tenantId!==null&&!UUID.test(tenantId))throw Error('Invalid tenant for stop');
  const root=dirname(resolve(registryFile));
  const marker=tenantId?join(root,'tenants',tenantId,'STOP'):join(root,'STOP');
  if(tenantId)await readOutsideCheckout(join(root,'tenants',tenantId,'permit.json'),
    {privateFile:true});
  try{
    const handle=await open(marker,'wx',0o600);
    try{await handle.writeFile(JSON.stringify({
      schema:'osmanx.guest.r16.stop.v1',
      scope:tenantId?'tenant':'global',
      // No guest data or operator personal details in stop marker.
      stoppedAt:new Date().toISOString()
    })+'\n');await handle.sync();}
    finally{await handle.close();}
    return {stopped:true,alreadyStopped:false,scope:tenantId?'tenant':'global'};
  }catch(error){
    if(error.code==='EEXIST')
      return {stopped:true,alreadyStopped:true,scope:tenantId?'tenant':'global'};
    throw error;
  }
}
