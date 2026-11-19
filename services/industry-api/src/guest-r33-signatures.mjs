/**
 * Domain-separated Ed25519 verification of offline operator statements.
 * Public keys MUST come from a separately pre-pinned trusted operator file.
 * Signatures prove key control over bytes, never external facts or identities.
 */
import {createHash,createPublicKey,KeyObject,verify} from 'node:crypto';
export const R33_SIGN_DOMAINS=Object.freeze([
  'osmanx.guest.r33.stage-statement.v1',
  'osmanx.guest.r33.privacy-statement.v1'
]);
const B64=/^[A-Za-z0-9+/]{86}==$/;
const NONCE=/^[a-f0-9]{32}$/;
const KEY_ID=/^[a-z][a-z0-9_-]{2,39}$/;
const DATE=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const FIELDS=['role','keyId','decision','observedAt','nonce','signature'];
const exact=(obj,keys)=>obj&&typeof obj==='object'&&
  !Array.isArray(obj)&&Object.keys(obj).sort().join('|')===
    keys.slice().sort().join('|');
export const r33Hash=value=>createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');
export const r33Timestamp=value=>typeof value==='string'&&
  DATE.test(value)&&Number.isFinite(Date.parse(value))&&
  new Date(Date.parse(value)).toISOString()===value;
export function r33SignedBytes({domain,payload,receipt}){
  return Buffer.from(JSON.stringify({
    domain,payloadSha256:r33Hash(payload),
    role:receipt.role,keyId:receipt.keyId,decision:receipt.decision,
    observedAt:receipt.observedAt,nonce:receipt.nonce
  }),'utf8');
}
export function verifyR33Statements({domain,payload,receipts,roles,
  publicKeys={},issuedAt,expiresAt,now=new Date()}={}){
  const blockers=[],seenRoles=new Set(),seenKeys=new Set(),seenNonces=new Set();
  if(!R33_SIGN_DOMAINS.includes(domain)||!payload||
    typeof payload!=='object'||Array.isArray(payload)||
    !Array.isArray(roles)||roles.length!==2||
    new Set(roles).size!==2||roles.some(x=>!KEY_ID.test(x)))
    blockers.push('INVALID_SIGNING_SCOPE');
  if(!r33Timestamp(issuedAt)||!r33Timestamp(expiresAt)||
    !(now instanceof Date)||!Number.isFinite(now.getTime())||
    Date.parse(issuedAt)>now.getTime()||
    now.getTime()>=Date.parse(expiresAt)||
    Date.parse(expiresAt)-Date.parse(issuedAt)>10*60000||
    Date.parse(expiresAt)<=Date.parse(issuedAt))
    blockers.push('EXPIRED_OR_INVALID_SIGNING_WINDOW');
  if(!Array.isArray(receipts)||receipts.length!==2)
    blockers.push('TWO_INDEPENDENT_SIGNATURES_REQUIRED');
  for(const item of Array.isArray(receipts)?receipts.slice(0,4):[]){
    if(!exact(item,FIELDS)||!roles?.includes(item.role)||
      !KEY_ID.test(item.keyId||'')||item.decision!=='reviewed'||
      !r33Timestamp(item.observedAt)||!NONCE.test(item.nonce||'')||
      typeof item.signature!=='string'||!B64.test(item.signature)){
      blockers.push('MALFORMED_SIGNED_STATEMENT');continue;
    }
    if(seenRoles.has(item.role)||seenNonces.has(item.nonce)){
      blockers.push('DUPLICATE_ROLE_OR_NONCE');continue;
    }
    seenRoles.add(item.role);seenNonces.add(item.nonce);
    if(!r33Timestamp(issuedAt)||!r33Timestamp(expiresAt)||
      Date.parse(item.observedAt)<Date.parse(issuedAt)||
      Date.parse(item.observedAt)>now.getTime()||
      Date.parse(item.observedAt)>=Date.parse(expiresAt)){
      blockers.push('STATEMENT_OUT_OF_SCOPE');continue;
    }
    try{
      const trusted=publicKeys?.[item.role];
      if(!exact(trusted,['keyId','publicKey'])||
        trusted.keyId!==item.keyId)throw Error('KEY_NOT_PINNED');
      const key=trusted.publicKey instanceof KeyObject?
        trusted.publicKey:createPublicKey(trusted.publicKey);
      if(key.type!=='public'||key.asymmetricKeyType!=='ed25519')
        throw Error('WRONG_KEY_TYPE');
      const fingerprint=key.export({type:'spki',format:'der'}).toString('hex');
      if(seenKeys.has(fingerprint))throw Error('KEY_REUSED');
      seenKeys.add(fingerprint);
      const sig=Buffer.from(item.signature,'base64');
      if(sig.length!==64||sig.toString('base64')!==item.signature||
        !verify(null,r33SignedBytes({domain,payload,receipt:item}),key,sig))
        throw Error('BAD_SIGNATURE');
    }catch(e){
      blockers.push(e?.message==='KEY_REUSED'?'REPEATED_SIGNER':
        'UNTRUSTED_OR_INVALID_SIGNATURE');
    }
  }
  if(!Array.isArray(roles)||roles.some(x=>!seenRoles.has(x))||
    seenKeys.size!==2||blockers.length)
    blockers.push('SIGNATURE_QUORUM_MISSING');
  return {schema:'osmanx.guest.r33.offline-quorum.v1',
    signaturesValid:blockers.length===0,
    rolesObserved:[...seenRoles],externalIdentityVerified:false,
    blockers:[...new Set(blockers)],productionAuthorized:false};
}
