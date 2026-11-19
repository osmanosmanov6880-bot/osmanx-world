/**
 * R30 independent review receipts. Verification proves a pinned key signed
 * scoped bytes, NOT the underlying host, DR or legal claims. Public keys must
 * be pinned by a trusted offline operator; user-supplied keys are not trust.
 */
import {createPublicKey,KeyObject,verify} from 'node:crypto';
export const R30_RECEIPT_SCHEMA='osmanx.guest.r30.independent-receipts.v1';
export const R30_SIGN_SCHEMA='osmanx.guest.r30.ed25519-statement.v1';
export const R30_ROLES=Object.freeze([
  'source_reviewer','staging_witness','recovery_auditor','privacy_officer'
]);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const NONCE=/^[a-f0-9]{32}$/;
const TIME=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const exact=(x,n)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===n.slice().sort().join('|');
const timestamp=x=>typeof x==='string'&&TIME.test(x)&&
  Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;
const receiptKeys=['role','keyId','evidenceSha','decision','observedAt',
  'nonce','signature'];
const identityKeys=['tenantId','pilotId','releaseCommit','r29ReportSha',
  'issuedAt','expiresAt'];
export function r30ReceiptSigningBytes(receipt,identity){
  return Buffer.from(JSON.stringify({
    schema:R30_SIGN_SCHEMA,tenantId:identity.tenantId,
    pilotId:identity.pilotId,releaseCommit:identity.releaseCommit,
    r29ReportSha:identity.r29ReportSha,
    issuedAt:identity.issuedAt,expiresAt:identity.expiresAt,
    role:receipt.role,keyId:receipt.keyId,
    evidenceSha:receipt.evidenceSha,decision:receipt.decision,
    observedAt:receipt.observedAt,nonce:receipt.nonce
  }),'utf8');
}
function validIdentity(i,now){
  if(!exact(i,identityKeys)||!UUID.test(i.tenantId||'')||
      !UUID.test(i.pilotId||'')||!COMMIT.test(i.releaseCommit||'')||
      !SHA.test(i.r29ReportSha||'')||
      !timestamp(i.issuedAt)||!timestamp(i.expiresAt)||
      !(now instanceof Date)||!Number.isFinite(now.getTime()))return false;
  const issued=Date.parse(i.issuedAt),until=Date.parse(i.expiresAt);
  return issued<=now.getTime()&&now.getTime()<until&&
    until>issued&&until-issued<=10*60000;
}
export function verifyR30IndependentReceipts({identity,packet,publicKeys={},
  now=new Date()}={}){
  const blockers=[],checks=Object.fromEntries(R30_ROLES.map(x=>[x,false]));
  if(!validIdentity(identity,now))blockers.push('INVALID_OR_EXPIRED_SCOPE');
  if(!exact(packet,['schema','receipts'])||
      packet?.schema!==R30_RECEIPT_SCHEMA||
      !Array.isArray(packet.receipts)||packet.receipts.length!==4)
    blockers.push('MISSING_FOUR_RECEIPTS');
  const roles=new Set(),keys=new Set(),nonces=new Set();
  for(const receipt of Array.isArray(packet?.receipts)?
    packet.receipts.slice(0,8):[]){
    if(!exact(receipt,receiptKeys)||!R30_ROLES.includes(receipt.role)||
      !/^[a-z][a-z0-9_-]{2,39}$/.test(receipt.keyId||'')||
      !SHA.test(receipt.evidenceSha||'')||
      !['reviewed','rejected'].includes(receipt.decision)||
      !timestamp(receipt.observedAt)||!NONCE.test(receipt.nonce||'')||
      typeof receipt.signature!=='string'||
      !/^[A-Za-z0-9+/]{86}==$/.test(receipt.signature)){
      blockers.push('INVALID_RECEIPT_SHAPE');continue;
    }
    if(roles.has(receipt.role)||nonces.has(receipt.nonce)){
      blockers.push('DUPLICATE_ROLE_OR_NONCE');continue;
    }
    roles.add(receipt.role);nonces.add(receipt.nonce);
    const observed=Date.parse(receipt.observedAt);
    if(!validIdentity(identity,now)||
      observed<Date.parse(identity.issuedAt)||
      observed>now.getTime()||observed>Date.parse(identity.expiresAt)||
      now.getTime()-observed>10*60000){
      blockers.push('STALE_OR_OUT_OF_SCOPE_RECEIPT');continue;
    }
    try{
      const trusted=publicKeys?.[receipt.role];
      if(!exact(trusted,['keyId','publicKey'])||
        trusted.keyId!==receipt.keyId)throw Error('UNPINNED_KEY');
      const key=trusted.publicKey instanceof KeyObject?trusted.publicKey:
        createPublicKey(trusted.publicKey);
      if(key.type!=='public'||key.asymmetricKeyType!=='ed25519')
        throw Error('WRONG_KEY_TYPE');
      const fingerprint=key.export({type:'spki',format:'der'}).toString('hex');
      if(keys.has(fingerprint))throw Error('REUSED_SIGNER_KEY');
      keys.add(fingerprint);
      const raw=Buffer.from(receipt.signature,'base64');
      if(raw.length!==64||raw.toString('base64')!==receipt.signature||
        !verify(null,r30ReceiptSigningBytes(receipt,identity),key,raw))
        throw Error('INVALID_SIGNATURE');
      if(receipt.decision==='rejected')blockers.push('WITNESS_REJECTED_'+receipt.role);
      else checks[receipt.role]=true;
    }catch(e){
      blockers.push(['UNPINNED_KEY','WRONG_KEY_TYPE','REUSED_SIGNER_KEY',
        'INVALID_SIGNATURE'].includes(e?.message)?e.message:
        'UNTRUSTED_OR_BAD_SIGNATURE');
    }
  }
  if(roles.size!==R30_ROLES.length||R30_ROLES.some(x=>!checks[x]))
    blockers.push('INDEPENDENT_REVIEW_INCOMPLETE');
  const signaturesVerified=blockers.length===0;
  return {
    schema:'osmanx.guest.r30.receipt-verification.v1',
    signatureChecks:checks,signatureQuorumVerified:signaturesVerified,
    // Signatures alone do not establish that the real infrastructure was tested.
    externalFactsAudited:false,realStagingVerified:false,
    legalConsentVerified:false,offsiteRestoreVerified:false,
    blockers:[...new Set(blockers)],automaticApproval:false,
    customerGo:false,productionAuthorized:false
  };
}
