/**
 * Independent offline Ed25519 approval of a limited STAGING review window.
 * Signature verification confirms only that trusted role keys signed the plan.
 * It does not authorize CLI execution, deployment or customer collection.
 */
import {createPublicKey,verify} from 'node:crypto';
import {R31_PIN} from './guest-r32-source.mjs';
export const R32_WINDOW_SCHEMA='osmanx.guest.r32.staging-change-window.v1';
export const R32_SIGN_SCHEMA='osmanx.guest.r32.window-signature.v1';
export const R32_APPROVERS=Object.freeze(['release_manager','recovery_lead']);
const SHA=/^[a-f0-9]{64}$/;
const SHA40=/^[a-f0-9]{40}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const NONCE=/^[a-f0-9]{32}$/;
const fields=['schema','changeId','tenantId','pilotId','releaseSha',
  'treeSha','environment','stagingOrigin','startAt','endAt','createdAt',
  'rollbackRunbookSha','recoveryEvidenceSha','maxDowntimeMinutes'];
const sigFields=['role','keyId','decision','observedAt','nonce','signature'];
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===keys.slice().sort().join('|');
const time=x=>typeof x==='string'&&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&
  Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;
function validPlan(p,now){
  if(!exact(p,fields)||p.schema!==R32_WINDOW_SCHEMA||
    !UUID.test(p.changeId||'')||!UUID.test(p.tenantId||'')||
    !UUID.test(p.pilotId||'')||p.releaseSha!==R31_PIN.sha||
    !SHA40.test(p.treeSha||'')||p.environment!=='staging'||
    p.stagingOrigin!=='https://staging.osmanx.world'||
    !SHA.test(p.rollbackRunbookSha||'')||
    !SHA.test(p.recoveryEvidenceSha||'')||
    !Number.isSafeInteger(p.maxDowntimeMinutes)||
    p.maxDowntimeMinutes<1||p.maxDowntimeMinutes>30||
    ![p.startAt,p.endAt,p.createdAt].every(time)||
    !(now instanceof Date)||!Number.isFinite(now.getTime()))return false;
  const s=Date.parse(p.startAt),e=Date.parse(p.endAt),
    c=Date.parse(p.createdAt),n=now.getTime();
  return c<=n&&n<=e&&s<=e&&e-s>0&&e-s<=30*60000&&
    c<=s&&s-c<=24*3600000&&e-c<=24*3600000;
}
export function r32WindowSigningBytes(p,r){
  return Buffer.from(JSON.stringify({schema:R32_SIGN_SCHEMA,
    changeId:p.changeId,tenantId:p.tenantId,pilotId:p.pilotId,
    releaseSha:p.releaseSha,treeSha:p.treeSha,
    environment:p.environment,stagingOrigin:p.stagingOrigin,
    startAt:p.startAt,endAt:p.endAt,createdAt:p.createdAt,
    rollbackRunbookSha:p.rollbackRunbookSha,
    recoveryEvidenceSha:p.recoveryEvidenceSha,
    maxDowntimeMinutes:p.maxDowntimeMinutes,
    role:r.role,keyId:r.keyId,decision:r.decision,
    observedAt:r.observedAt,nonce:r.nonce}),'utf8');
}
export function verifyR32ChangeWindow({plan,signatures,publicKeys={},
  now=new Date()}={}){
  const blockers=[],ids=new Set(),nonces=new Set(),roles=new Set();
  if(!validPlan(plan,now))blockers.push('BAD_CHANGE_SCOPE_OR_WINDOW');
  if(!Array.isArray(signatures)||signatures.length!==2)
    blockers.push('TWO_APPROVERS_REQUIRED');
  const approved=Object.fromEntries(R32_APPROVERS.map(x=>[x,false]));
  for(const r of Array.isArray(signatures)?signatures.slice(0,4):[]){
    if(!exact(r,sigFields)||!R32_APPROVERS.includes(r?.role)||
      !/^[a-z][a-z0-9_-]{2,39}$/.test(r?.keyId||'')||
      r.decision!=='approved'||!time(r.observedAt)||
      !NONCE.test(r.nonce||'')||
      typeof r.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(r.signature)){
      blockers.push('INVALID_WINDOW_RECEIPT');continue;
    }
    if(roles.has(r.role)||nonces.has(r.nonce)){
      blockers.push('DUPLICATE_ROLE_OR_NONCE');continue;
    }
    roles.add(r.role);nonces.add(r.nonce);
    if(!validPlan(plan,now)||Date.parse(r.observedAt)<Date.parse(plan.createdAt)||
      Date.parse(r.observedAt)>now.getTime()||
      Date.parse(r.observedAt)>Date.parse(plan.endAt)){
      blockers.push('RECEIPT_OUT_OF_WINDOW');continue;
    }
    try{
      const trusted=publicKeys?.[r.role];
      if(!exact(trusted,['keyId','publicKey'])||
        trusted.keyId!==r.keyId)throw Error('UNTRUSTED_APPROVER');
      const key=createPublicKey(trusted.publicKey);
      if(key.asymmetricKeyType!=='ed25519'||key.type!=='public')
        throw Error('WRONG_KEY_TYPE');
      const fingerprint=key.export({type:'spki',format:'der'}).toString('hex');
      if(ids.has(fingerprint))throw Error('SIGNER_REUSED');
      ids.add(fingerprint);
      const signature=Buffer.from(r.signature,'base64');
      if(signature.length!==64||signature.toString('base64')!==r.signature||
        !verify(null,r32WindowSigningBytes(plan,r),key,signature))
        throw Error('BAD_SIGNATURE');
      approved[r.role]=true;
    }catch(e){blockers.push(e?.message==='SIGNER_REUSED'?'SIGNER_REUSED':
      'UNTRUSTED_OR_INVALID_SIGNATURE');}
  }
  if(R32_APPROVERS.some(role=>!approved[role]))
    blockers.push('APPROVAL_QUORUM_INCOMPLETE');
  return {schema:'osmanx.guest.r32.window-verification.v1',
    metadataAndSignaturesValid:blockers.length===0,
    rolesVerified:approved,approvedStagingWindowOnly:blockers.length===0,
    externalHumanIdentityProven:false,
    actualStagingExecuted:false,productionAuthorized:false,customerGo:false,
    blockers:[...new Set(blockers)]};
}
