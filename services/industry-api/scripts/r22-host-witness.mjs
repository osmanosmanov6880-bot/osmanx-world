/**
 * R22 independent operator witness for a LOCAL host posture snapshot.
 * Only a signed redacted fact digest is exportable. Signature is evidence
 * of the operator's attestation, NOT proof of actual VPS physical inspection
 * and NEVER deployment authorization.
 */
import {createHash,createPublicKey,createPrivateKey,sign,verify}
  from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateHostPosture,HOST_SCHEMA} from './r21-host-posture.mjs';

export const ATTEST_SCHEMA='osmanx.guest.r22.host-witness.v1';
export const ATTEST_FIELDS=['schema','operatorId','role','releaseCommit',
  'tenantId','pilotId','hostFactsSha','issuedAt','expiresAt','signature'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const ID=/^[A-Za-z0-9._-]{3,80}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SIG=/^[A-Za-z0-9+/]{86}==$/;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&
  Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const sha=text=>createHash('sha256').update(text).digest('hex');
export function sanitizedHostFacts(snapshot){
  const observed={
    schema:HOST_SCHEMA,
    os:snapshot?.os==='linux'?'linux':'other-or-unknown',
    nodeMajor:Number.isSafeInteger(snapshot?.nodeMajor)?snapshot.nodeMajor:null,
    environmentMode:snapshot?.environmentMode==='production'?'production':'unknown',
    allowedOriginIsExact:snapshot?.allowedOriginIsExact===true,
    writesEnabled:snapshot?.writesEnabled===true,
    custodyConfigured:snapshot?.custodyConfigured===true,
    pathsOutsideCheckout:snapshot?.pathsOutsideCheckout===true,
    privateFilesSafe:snapshot?.privateFilesSafe===true,
    publicKeysSafe:snapshot?.publicKeysSafe===true,
    canaryListener:['loopback','public','absent'].includes(snapshot?.canaryListener)?
      snapshot.canaryListener:'unknown',
    postgresExposed:snapshot?.postgresExposed===false?false:
      snapshot?.postgresExposed===true?true:null,
    gatheredOnHost:snapshot?.gatheredOnHost===true
  };
  return observed;
}
export function hostFactsSha(snapshot){
  return sha(JSON.stringify(sanitizedHostFacts(snapshot)));
}
export function hostAttestationMessage(record){
  return JSON.stringify({
    schema:ATTEST_SCHEMA,operatorId:record.operatorId,
    role:record.role,releaseCommit:record.releaseCommit,
    tenantId:record.tenantId,pilotId:record.pilotId,
    hostFactsSha:record.hostFactsSha,
    issuedAt:record.issuedAt,expiresAt:record.expiresAt
  });
}
export function makeHostAttestation(snapshot,{operatorId,privatePem,
  releaseCommit,tenantId,pilotId,now=new Date()}={}){
  const facts=sanitizedHostFacts(snapshot);
  if(!facts.gatheredOnHost||!ID.test(operatorId||'')||
     !COMMIT.test(releaseCommit||'')||
     !UUID.test(tenantId||'')||!UUID.test(pilotId||''))
    throw Error('R22 requires a verified local operator snapshot and pilot');
  if(snapshot?.writesEnabled===true||snapshot?.postgresExposed===true)
    throw Error('R22 cannot attest unsafe host conditions');
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw Error('Invalid attestation time');
  const key=createPrivateKey(privatePem);
  if(key.asymmetricKeyType!=='ed25519')
    throw Error('Independent Ed25519 signing key required');
  const record={schema:ATTEST_SCHEMA,operatorId,
    role:'independent_host_operator',releaseCommit,tenantId,pilotId,
    hostFactsSha:hostFactsSha(snapshot),
    issuedAt:now.toISOString(),
    expiresAt:new Date(now.getTime()+30*60000).toISOString()
  };
  return {...record,signature:sign(null,
    Buffer.from(hostAttestationMessage(record),'utf8'),key).toString('base64')};
}
export function verifyHostAttestation(snapshot,record,{
  operatorPublicKey,r18CustodianPublicKey,r19SignerPublicKey,
  r20ReleasePublicKey,releaseCommit,tenantId,pilotId,
  now=new Date()
}={}){
  const blockers=[],facts=sanitizedHostFacts(snapshot);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw TypeError('Invalid attestation clock');
  if(!exact(record,ATTEST_FIELDS)||record.schema!==ATTEST_SCHEMA||
     record.role!=='independent_host_operator'||
     !ID.test(record.operatorId||'')||!COMMIT.test(record.releaseCommit||'')||
     !UUID.test(record.tenantId||'')||!UUID.test(record.pilotId||'')||
     !SHA.test(record.hostFactsSha||'')||!SIG.test(record.signature||'')||
     Buffer.from(record.signature||'','base64').toString('base64')!==record.signature)
    blockers.push('bad_attestation_shape');
  const start=ISO.test(record?.issuedAt||'')?Date.parse(record.issuedAt):NaN;
  const end=ISO.test(record?.expiresAt||'')?Date.parse(record.expiresAt):NaN;
  if(!Number.isFinite(start)||!Number.isFinite(end)||
     new Date(start).toISOString()!==record.issuedAt||
     new Date(end).toISOString()!==record.expiresAt||
     end-start!==30*60000||start>now.getTime()||end<=now.getTime())
    blockers.push('expired_or_future_witness');
  if(record?.releaseCommit!==releaseCommit||record?.tenantId!==tenantId||
     record?.pilotId!==pilotId)blockers.push('wrong_release_or_pilot');
  if(record?.hostFactsSha!==hostFactsSha(snapshot))
    blockers.push('host_facts_modified');
  if(!facts.gatheredOnHost)blockers.push('host_not_inspected');
  if(facts.writesEnabled||facts.postgresExposed!==false||
     facts.canaryListener!=='loopback')blockers.push('unsafe_host_listeners');
  try{
    const key=createPublicKey(operatorPublicKey);
    if(key.asymmetricKeyType!=='ed25519')throw Error('Wrong key type');
    const bytes=key.export({type:'spki',format:'der'});
    for(const other of [r18CustodianPublicKey,r19SignerPublicKey,r20ReleasePublicKey]){
      if(!other)throw Error('Missing independent trust anchor');
      if(bytes.equals(createPublicKey(other).export({type:'spki',format:'der'})))
        blockers.push('shared_operator_trust_key');
    }
    if(!verify(null,Buffer.from(hostAttestationMessage(record),'utf8'),key,
      Buffer.from(record.signature||'','base64')))
      blockers.push('invalid_host_signature');
  }catch{blockers.push('missing_or_invalid_trust_keys');}
  // Existing R21 host policy's "independentOperatorConfirmed" is supplied
  // only if the detached signature and trust separation are fully valid.
  const attestPass=blockers.length===0;
  const assessed=evaluateHostPosture({
    ...facts,independentOperatorConfirmed:attestPass
  });
  if(!assessed.safeIsolatedRehearsal)
    blockers.push(...assessed.blockers);
  return {schema:'osmanx.guest.r22.host-attestation-check.v1',
    valid:blockers.length===0,blockers:[...new Set(blockers)],
    factsDigest:hostFactsSha(snapshot),
    hostTechnicalChecksPassed:assessed.safeIsolatedRehearsal,
    independentSignatureValid:attestPass,
    actualHostVerifiedByThisSoftware:false,
    independentPhysicalAuditStillRequired:true,
    customerGo:false,productionAuthorized:false,changedProduction:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  // No CLI sign action in application or CI: independent operator signatures
  // must be produced offline on an approved machine with a hardware-backed key.
  process.stdout.write('Use imported R22 host witness verification from an approved offline operator; no automatic sign/deploy command.\n');
}
