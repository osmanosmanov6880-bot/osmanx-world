/** R34 domain-separated signatures for external custody and customer scope. */
import {createHash,createPublicKey,KeyObject,verify} from 'node:crypto';
export const R34_DOMAINS=Object.freeze([
  'osmanx.guest.r34.offsite-custody.v1',
  'osmanx.guest.r34.client-authorization.v1'
]);
export const digest34=value=>createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');
const DATE=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
export const valid34Time=x=>typeof x==='string'&&DATE.test(x)&&
  Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;
const SIGN_FIELDS=['role','keyId','nonce','decision','observedAt','signature'];
const exact=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===keys.slice().sort().join('|');
export function r34SigningBytes({domain,payload,statement}){
  return Buffer.from(JSON.stringify({
    domain,evidenceSha256:digest34(payload),
    role:statement.role,keyId:statement.keyId,
    nonce:statement.nonce,decision:statement.decision,
    observedAt:statement.observedAt
  }));
}
export function verifyR34Quorum({domain,payload,statements,roles,
  trustedKeys={},now=new Date()}={}){
  const blockers=[],fingers=new Set(),seenRoles=new Set(),nonces=new Set();
  if(!R34_DOMAINS.includes(domain)||!payload||
    typeof payload!=='object'||Array.isArray(payload)||
    !Array.isArray(roles)||roles.length!==2||new Set(roles).size!==2)
    blockers.push('INVALID_SIGNING_DOMAIN');
  if(!Array.isArray(statements)||statements.length!==2)
    blockers.push('TWO_SIGNATURES_REQUIRED');
  if(!valid34Time(payload?.issuedAt)||!valid34Time(payload?.expiresAt)||
    !(now instanceof Date)||!Number.isFinite(now.getTime())||
    Date.parse(payload?.issuedAt)>now.getTime()||
    now.getTime()>=Date.parse(payload?.expiresAt)||
    Date.parse(payload?.expiresAt)<=Date.parse(payload?.issuedAt)||
    Date.parse(payload?.expiresAt)-Date.parse(payload?.issuedAt)>600000)
    blockers.push('SIGNING_WINDOW_EXPIRED');
  for(const s of Array.isArray(statements)?statements.slice(0,3):[]){
    if(!exact(s,SIGN_FIELDS)||!roles?.includes(s.role)||
      !/^[a-z][a-z0-9_-]{2,39}$/.test(s.keyId||'')||
      !/^[a-f0-9]{32}$/.test(s.nonce||'')||
      s.decision!=='reviewed'||!valid34Time(s.observedAt)||
      typeof s.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(s.signature)){
      blockers.push('INVALID_SIGNATURE_FORMAT');continue;
    }
    if(seenRoles.has(s.role)||nonces.has(s.nonce)){
      blockers.push('REPEATED_ROLE_OR_NONCE');continue;
    }
    seenRoles.add(s.role);nonces.add(s.nonce);
    if(Date.parse(s.observedAt)<Date.parse(payload.issuedAt)||
      Date.parse(s.observedAt)>now.getTime()||
      Date.parse(s.observedAt)>=Date.parse(payload.expiresAt)){
      blockers.push('STATEMENT_OUT_OF_WINDOW');continue;
    }
    try{
      const pinned=trustedKeys?.[s.role];
      if(!exact(pinned,['keyId','publicKey'])||pinned.keyId!==s.keyId)
        throw Error('UNTRUSTED_KEY');
      const key=pinned.publicKey instanceof KeyObject?
        pinned.publicKey:createPublicKey(pinned.publicKey);
      if(key.type!=='public'||key.asymmetricKeyType!=='ed25519')
        throw Error('NOT_ED25519');
      const fp=key.export({format:'der',type:'spki'}).toString('hex');
      if(fingers.has(fp))throw Error('REUSED_KEY');
      fingers.add(fp);
      const sig=Buffer.from(s.signature,'base64');
      if(sig.length!==64||sig.toString('base64')!==s.signature||
        !verify(null,r34SigningBytes({domain,payload,statement:s}),key,sig))
        throw Error('BAD_SIGNATURE');
    }catch(err){
      blockers.push(err?.message==='REUSED_KEY'?
        'SHARED_SIGNER_KEY':'INVALID_OR_UNTRUSTED_SIGNATURE');
    }
  }
  if(!Array.isArray(roles)||roles.some(role=>!seenRoles.has(role))||
    fingers.size!==2)
    blockers.push('ROLE_QUORUM_INCOMPLETE');
  return {schema:'osmanx.guest.r34.signed-claim-review.v1',
    signaturesValid:blockers.length===0,
    realIdentityVerified:false,
    externallyVerified:false,productionAuthorized:false,
    blockers:[...new Set(blockers)]};
}
