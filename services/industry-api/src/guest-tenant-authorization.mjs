/**
 * R15: independent, tenant-specific, short-lived production write permit.
 * The global flag is never sufficient. No client PII or private keys in source.
 * Both this permit AND a fresh R14 evidence bundle must verify.
 */
import {createPublicKey,verify} from 'node:crypto';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateAdmission,evidenceDigest} from '../scripts/r14-admission.mjs';

export const PERMIT_SCHEMA='osmanx.guest.r15.tenant-permit.v1';
export const SIGNING_SCHEMA='osmanx.guest.r15.tenant-permit.signature.v1';
const ID=/^[A-Za-z0-9._-]{3,80}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const HOUR=3600000;
const EXACT=(obj,keys)=>!!obj&&typeof obj==='object'&&!Array.isArray(obj)&&
  Object.keys(obj).sort().join('|')===[...keys].sort().join('|');
const FIELDS=['schema','tenantId','releaseCommit','admissionDigest','issuedAt','expiresAt','attestations'];
const APPROVAL=['role','actorId','signature'];
function iso(value){
  return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&
    Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
}
function publicKey(value){
  const key=createPublicKey(value);
  if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 public key required');
  return key;
}
export function permitMessage(permit,approval){
  return JSON.stringify({
    schema:SIGNING_SCHEMA,role:approval.role,actorId:approval.actorId,
    tenantId:permit.tenantId,releaseCommit:permit.releaseCommit,
    admissionDigest:permit.admissionDigest,issuedAt:permit.issuedAt,
    expiresAt:permit.expiresAt
  });
}
export function inspectTenantPermit({
  permit,admission,keys,releaseCommit,tenantId,now=new Date()
}={}){
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw new TypeError('Invalid clock');
  const blockers=[];
  if(!EXACT(permit,FIELDS)||permit.schema!==PERMIT_SCHEMA)blockers.push('permit_shape');
  if(!UUID.test(permit?.tenantId||'')||permit?.tenantId!==tenantId)
    blockers.push('tenant_scope');
  if(!COMMIT.test(releaseCommit||'')||permit?.releaseCommit!==releaseCommit)
    blockers.push('release_mismatch');
  if(!SHA.test(permit?.admissionDigest||''))blockers.push('invalid_evidence_digest');
  const start=iso(permit?.issuedAt)?Date.parse(permit.issuedAt):NaN;
  const end=iso(permit?.expiresAt)?Date.parse(permit.expiresAt):NaN;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>now.getTime()||
      end<=now.getTime()||end<=start||end-start>24*HOUR||now.getTime()-start>24*HOUR)
    blockers.push('permit_time_window');
  let admissionReport=null;
  try{
    admissionReport=evaluateAdmission(admission,keys,now);
    if(!admissionReport.operatorGo)blockers.push('r14_admission_no_go');
    if(admission?.releaseCommit!==releaseCommit||
       permit?.admissionDigest!==evidenceDigest(admission))
      blockers.push('admission_release_or_digest_mismatch');
  }catch{blockers.push('invalid_r14_admission');}
  let owner,manager;
  try{
    owner=publicKey(keys?.owner);
    manager=publicKey(keys?.manager);
    if(owner.export({type:'spki',format:'der'}).equals(
      manager.export({type:'spki',format:'der'})))blockers.push('same_signer_key');
  }catch{blockers.push('invalid_signer_keys');}
  const signatures=permit?.attestations;
  if(!Array.isArray(signatures)||signatures.length!==2||
    signatures.filter(a=>a?.role==='owner').length!==1||
    signatures.filter(a=>a?.role==='manager').length!==1)
    blockers.push('independent_signatures_required');
  for(const role of ['owner','manager']){
    const approval=Array.isArray(signatures)?signatures.find(a=>a?.role===role):null;
    const r14=Array.isArray(admission?.attestations)?
      admission.attestations.find(a=>a?.role===role):null;
    if(!EXACT(approval,APPROVAL)||!ID.test(approval?.actorId||'')||
        r14?.actorId!==approval?.actorId){
      blockers.push('invalid_'+role+'_identity');continue;
    }
    const sig=approval.signature;
    if(typeof sig!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(sig)||
       Buffer.from(sig,'base64').toString('base64')!==sig){
      blockers.push('invalid_'+role+'_signature');continue;
    }
    try{
      if(!verify(null,Buffer.from(permitMessage(permit,approval),'utf8'),
        role==='owner'?owner:manager,Buffer.from(sig,'base64')))
        blockers.push('bad_'+role+'_signature');
    }catch{blockers.push('bad_'+role+'_signature');}
  }
  const approverOwner=signatures?.find?.(a=>a?.role==='owner')?.actorId;
  const approverManager=signatures?.find?.(a=>a?.role==='manager')?.actorId;
  if(approverOwner&&approverOwner===approverManager)blockers.push('same_human');
  return {
    schema:'osmanx.guest.r15.tenant-permit.report.v1',
    permitValid:blockers.length===0,
    blockers:[...new Set(blockers)],
    // This report is evidence only. It can never change the global write flag.
    globalWriteFlagChanged:false,
    validUntil:iso(permit?.expiresAt)?permit.expiresAt:null
  };
}
const REQUIRED_PATHS=[
 'GUEST_R15_ADMISSION_FILE','GUEST_R15_PERMIT_FILE',
 'GUEST_R15_OWNER_PUBLIC_KEY','GUEST_R15_MANAGER_PUBLIC_KEY'
];
export async function readOutsideCheckout(path,{privateFile=false}={}){
  if(typeof path!=='string'||!path.startsWith('/'))throw Error('Absolute path required');
  const target=resolve(path);
  const stat=await lstat(target);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>131072)
    throw Error('Refusing symlink, non-file or oversized R15 evidence');
  if(privateFile&&(stat.mode&0o077)!==0)
    throw Error('R15 private permit must have mode 600');
  const actual=await realpath(target);
  if(actual!==target)throw Error('Refusing symbolic ancestor of evidence');
  const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
  if(actual===root||actual.startsWith(root+sep))
    throw Error('R15 evidence must live outside application source');
  return readFile(actual,'utf8');
}
export async function loadTenantPermit(env=process.env,now=new Date()){
  if(env.NODE_ENV!=='production'||env.GUEST_WRITES_ENABLED!=='true')return null;
  if(!COMMIT.test(env.GUEST_RELEASE_COMMIT||'')||
    REQUIRED_PATHS.some(name=>!env[name]))
    throw Error('R15 signed tenant admission is required before Guest writes');
  try{
    const [admissionRaw,permitRaw,owner,manager]=await Promise.all([
      readOutsideCheckout(env.GUEST_R15_ADMISSION_FILE,{privateFile:true}),
      readOutsideCheckout(env.GUEST_R15_PERMIT_FILE,{privateFile:true}),
      readOutsideCheckout(env.GUEST_R15_OWNER_PUBLIC_KEY),
      readOutsideCheckout(env.GUEST_R15_MANAGER_PUBLIC_KEY)
    ]);
    const admission=JSON.parse(admissionRaw),permit=JSON.parse(permitRaw);
    const keys={owner,manager};
    const report=inspectTenantPermit({
      permit,admission,keys,releaseCommit:env.GUEST_RELEASE_COMMIT,
      tenantId:permit?.tenantId,now
    });
    if(!report.permitValid)throw Error('Permit rejected');
    return {permit,admission,keys,releaseCommit:env.GUEST_RELEASE_COMMIT};
  }catch{
    // Never surface private file names, JSON, signatures or credentials in HTTP.
    throw Error('R15 signed tenant admission could not be verified');
  }
}
export function assertTenantPermission(bundle,tenantId,now=new Date()){
  const report=bundle&&inspectTenantPermit({...bundle,tenantId,now});
  if(!report?.permitValid){
    const e=new Error('Запись компании не разрешена: нужен действующий двойной допуск R15');
    e.statusCode=503;
    throw e;
  }
  return true;
}
