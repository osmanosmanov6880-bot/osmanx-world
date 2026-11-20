/**
 * R42 verify Ed25519-signed offsite *claim*, bound to an AGE archive digest.
 * This is NOT proof an offsite provider physically stored or can restore it.
 * Custodian SPKI pin must come from an independently trusted channel.
 */
import {verify,createPublicKey,timingSafeEqual}
  from 'node:crypto';
import {r41PublicKeyFingerprint} from './guest-r41-key-pins.mjs';
export const R42_CUSTODY_SCHEMA='osmanx.guest.r42.offsite-custody-claim.v1';
const SHA=/^[a-f0-9]{64}$/;
const NAME=/^industry-\d{8}T\d{6}Z-\d{1,10}\.dump\.age$/;
const ID=/^[A-Za-z0-9._:-]{3,128}$/;
const FIELDS=['schema','archiveName','archiveSha256','archiveBytes',
  'custodianId','objectVersion','storageClass','observedAt','expiresAt',
  'signature'].sort().join('|');
export function r42CustodyMessage(x){
  return JSON.stringify({schema:R42_CUSTODY_SCHEMA,
    archiveName:x.archiveName,archiveSha256:x.archiveSha256,
    archiveBytes:x.archiveBytes,custodianId:x.custodianId,
    objectVersion:x.objectVersion,storageClass:x.storageClass,
    observedAt:x.observedAt,expiresAt:x.expiresAt});
}
export function verifyR42Custody({receipt,publicKeyPem,trustedKeySha,
  expectedSha,expectedName,expectedBytes,now=new Date()}={}){
  const blockers=[];
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||
    Object.keys(receipt).sort().join('|')!==FIELDS||
    receipt.schema!==R42_CUSTODY_SCHEMA)
    blockers.push('RECEIPT_SHAPE_OR_SCHEMA_INVALID');
  if(!NAME.test(receipt?.archiveName||'')||
    receipt?.archiveName!==expectedName||
    !SHA.test(receipt?.archiveSha256||'')||
    receipt?.archiveSha256!==expectedSha||
    !Number.isSafeInteger(receipt?.archiveBytes)||
    receipt.archiveBytes<=0||receipt.archiveBytes>5368709120||
    receipt.archiveBytes!==expectedBytes)
    blockers.push('RECEIPT_NOT_BOUND_TO_VERIFIED_AGE_BYTES');
  if(!ID.test(receipt?.custodianId||'')||
    !ID.test(receipt?.objectVersion||'')||
    receipt?.storageClass!=='independent-offsite')
    blockers.push('INDEPENDENT_OFFSITE_CUSTODY_UNVERIFIED');
  const begin=Date.parse(receipt?.observedAt),
    end=Date.parse(receipt?.expiresAt);
  const canonical=s=>typeof s==='string'&&
    Number.isFinite(Date.parse(s))&&
    new Date(s).toISOString()===s;
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !canonical(receipt?.observedAt)||
    !canonical(receipt?.expiresAt)||
    begin>now.getTime()||now.getTime()>=end||
    end<=begin||end-begin>30*86400000)
    blockers.push('CUSTODY_CLAIM_EXPIRED_OR_NONCANONICAL');
  let signatureValid=false;
  try{
    if(!SHA.test(trustedKeySha||''))
      throw Error('Missing trusted pin');
    const actual=r41PublicKeyFingerprint(publicKeyPem);
    if(!timingSafeEqual(Buffer.from(actual,'hex'),
      Buffer.from(trustedKeySha,'hex')))
      throw Error('Untrusted public key');
    if(typeof receipt?.signature!=='string'||
      !/^[A-Za-z0-9+/]{86}==$/.test(receipt.signature))
      throw Error('Not Ed25519 signature');
    const key=createPublicKey(publicKeyPem);
    signatureValid=verify(null,Buffer.from(r42CustodyMessage(receipt)),
      key,Buffer.from(receipt.signature,'base64'));
    if(!signatureValid)throw Error('Signature not verified');
  }catch{blockers.push('CUSTODIAN_SIGNATURE_OR_TRUST_PIN_INVALID')}
  return {schema:'osmanx.guest.r42.custody-verification.v1',
    claimValid:blockers.length===0,signatureVerified:signatureValid,
    externalObjectIdentityClaimed:receipt?.objectVersion||null,
    actualProviderObjectFetched:false,
    actualOffsiteRestoreWitnessed:false,
    proofOfExternalCustody:false,customerGo:false,
    productionAuthorized:false,blockers:[...new Set(blockers)]};
}
