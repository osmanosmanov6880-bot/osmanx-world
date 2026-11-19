/**
 * R28 independently pinned, offline Ed25519 evidence RECEIPT verifier.
 * Verifies who signed which redacted SHA snapshot; never purports to prove
 * source truth, contract validity, external WORM custody or production GO.
 * Private keys NEVER enter this module, API, repository or release.
 */
import {createHash,createPublicKey,verify} from 'node:crypto';
export const R28_EVIDENCE_SCHEMA='osmanx.guest.r28.offline-evidence-receipts.v1';
export const ROLES=Object.freeze(['host','recovery','privacy','release']);
export const R28_SIGNING_SCHEMA='osmanx.guest.r28.ed25519-receipt.v1';
const SHA=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===[...keys].sort().join('|');
const stamp=v=>typeof v==='string'&&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&
  Number.isFinite(Date.parse(v))&&new Date(Date.parse(v)).toISOString()===v;
export function r28SigningBytes(receipt,identity){
  // Explicit allowlisted canonical field order. Never sign an arbitrary JSON
  // blob whose property order changes by sender or compiler.
  return Buffer.from(JSON.stringify({
    schema:R28_SIGNING_SCHEMA,
    tenantId:identity.tenantId,pilotId:identity.pilotId,
    releaseSha:identity.releaseSha,
    r27HandoffSha:identity.r27HandoffSha,
    role:receipt.role,decision:receipt.decision,
    evidenceSha:receipt.evidenceSha,observedAt:receipt.observedAt,
    expiresAt:identity.expiresAt
  }),'utf8');
}
export function verifyR28IndependentReceipts({
  packet,publicKeys={},identity,now=new Date()
}={}){
  const errors=[],checks={};
  const fail=c=>errors.push(c);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
     !exact(identity,['tenantId','pilotId','releaseSha','r27HandoffSha','expiresAt'])||
     !UUID.test(identity?.tenantId||'')||
     !UUID.test(identity?.pilotId||'')||
     !COMMIT.test(identity?.releaseSha||'')||
     !SHA.test(identity?.r27HandoffSha||'')||
     !stamp(identity?.expiresAt))
    fail('INVALID_BOUND_IDENTITY');
  const until=Date.parse(identity?.expiresAt||'');
  if(!Number.isFinite(until)||until<=now.getTime()||
     until-now.getTime()>30*60000)
    fail('EXPIRED_OR_TOO_LONG');
  if(!exact(packet,['schema','receipts'])||
     packet?.schema!==R28_EVIDENCE_SCHEMA||
     !Array.isArray(packet?.receipts)||packet.receipts.length!==4)
    fail('INVALID_RECEIPT_PACKET');
  const seen=new Set(),keyIds=new Set();
  for(const role of ROLES)checks[role]=false;
  for(const item of Array.isArray(packet?.receipts)?packet.receipts.slice(0,8):[]){
    if(!exact(item,['role','decision','evidenceSha','observedAt','signature'])||
       !ROLES.includes(item.role)||!SHA.test(item.evidenceSha||'')||
       !['reviewed','rejected'].includes(item.decision)||
       !stamp(item.observedAt)||typeof item.signature!=='string'||
       !/^[A-Za-z0-9+/]{86}==$/.test(item.signature)){
      fail('INVALID_RECEIPT_SHAPE');continue;
    }
    if(seen.has(item.role)){fail('DUPLICATE_ROLE');continue;}
    seen.add(item.role);
    const time=Date.parse(item.observedAt);
    if(!Number.isFinite(time)||time>now.getTime()||
       now.getTime()-time>30*60000){
      fail('STALE_OR_FUTURE_OBSERVATION');continue;
    }
    try{
      const key=createPublicKey(publicKeys[item.role]);
      if(key.asymmetricKeyType!=='ed25519'){
        fail('NON_ED25519_KEY');continue;
      }
      const der=key.export({type:'spki',format:'der'}).toString('hex');
      if(keyIds.has(der)){
        fail('SIGNER_KEY_REUSED');continue;
      }
      keyIds.add(der);
      const raw=Buffer.from(item.signature,'base64');
      if(raw.length!==64||
         !verify(null,r28SigningBytes(item,identity),key,raw)){
        fail('INVALID_ED25519_SIGNATURE');continue;
      }
      checks[item.role]=item.decision==='reviewed';
      if(item.decision!=='reviewed')fail('REJECTED_'+item.role.toUpperCase());
    }catch{fail('PUBLIC_KEY_OR_SIGNATURE_INVALID');}
  }
  if(seen.size!==ROLES.length)fail('FOUR_DISTINCT_ROLES_REQUIRED');
  for(const role of ROLES)if(!checks[role])fail('RECEIPT_'+role.toUpperCase()+'_MISSING');
  const verified=errors.length===0;
  return {
    schema:'osmanx.guest.r28.offline-verification.v1',
    cryptographicReceiptsVerified:verified,checks,
    blockers:[...new Set(errors)],
    verifiedStatement:
      verified?'Distinct trusted keys signed role-specific evidence SHA and time, not the underlying truth.':
        'Missing, invalid, stale, declined or duplicated independent evidence receipts.',
    sourceFactsIndependentlyAudited:false,
    offsiteCustodyProven:false,legalBasisConfirmed:false,
    permissionToDeploy:false,customerGo:false
  };
}
export function hashR28EvidenceBytes(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length>2*1024*1024)
    throw new TypeError('Bounded redacted bytes required');
  return createHash('sha256').update(bytes).digest('hex');
}
