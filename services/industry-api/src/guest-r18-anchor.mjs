/**
 * R18 optional external-custodian checkpoint. It can only ADD a veto to R17,
 * never replace R14-R17 permission checks. An anchor copied back to the API
 * server is NOT WORM storage; its custodian key/floors must remain independent.
 */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {basename,dirname,resolve} from 'node:path';
import {readOutsideCheckout} from './guest-tenant-authorization.mjs';
import {loadR17Witness,r17Configured} from './guest-r17-witness.mjs';

export const ANCHOR_SCHEMA='osmanx.guest.r18.external-anchor.v1';
export const ANCHOR_MESSAGE_SCHEMA='osmanx.guest.r18.external-anchor.message.v1';
export const ANCHOR_REPORT_SCHEMA='osmanx.guest.r18.anchor-report.v1';
export const ANCHOR_FIELDS=['schema','role','actorId','releaseCommit',
  'registryRevision','registryDigest','journalSequence','journalHead',
  'checkpointDigest','issuedAt','expiresAt','signature'];
export const PLAN_FIELDS=ANCHOR_FIELDS.filter(x=>x!=='signature');
const REQUIRE=['GUEST_R18_ANCHOR_FILE','GUEST_R18_CUSTODIAN_PUBLIC_KEY',
  'GUEST_R18_MIN_REVISION','GUEST_R18_MIN_SEQUENCE'];
const ID=/^[A-Za-z0-9._-]{3,80}$/;
const SHA=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const SIG=/^[A-Za-z0-9+/]{86}==$/;
const MAX=4*3600000;
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&
  Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const time=s=>typeof s==='string'&&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&
  Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
const positive=n=>Number.isSafeInteger(n)&&n>=1;
export const anchorDigest=anchor=>createHash('sha256')
  .update(JSON.stringify(anchor)).digest('hex');
function key(value){
  const k=createPublicKey(value);
  if(k.asymmetricKeyType!=='ed25519')throw Error('Trusted external Ed25519 key required');
  return k;
}
export function anchorMessage(a){
  return JSON.stringify({
    schema:ANCHOR_MESSAGE_SCHEMA,role:a.role,actorId:a.actorId,
    releaseCommit:a.releaseCommit,registryRevision:a.registryRevision,
    registryDigest:a.registryDigest,journalSequence:a.journalSequence,
    journalHead:a.journalHead,checkpointDigest:a.checkpointDigest,
    issuedAt:a.issuedAt,expiresAt:a.expiresAt
  });
}
export function anchorPlan(witness,{now=new Date(),minutes=90,actorId='external-auditor'}={}){
  const cp=witness?.checkpoint;
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isSafeInteger(minutes)||minutes<1||minutes>240||
    !ID.test(actorId)||!COMMIT.test(witness?.releaseCommit||'')||
    !positive(cp?.revision)||!positive(cp?.sequence)||
    !SHA.test(cp?.registryDigest||'')||!SHA.test(cp?.journalHead||'')||
    !SHA.test(witness?.checkpointDigest||''))
    throw Error('Invalid external anchor plan inputs');
  return {schema:ANCHOR_SCHEMA,role:'custodian',actorId,
    releaseCommit:witness.releaseCommit,registryRevision:cp.revision,
    registryDigest:cp.registryDigest,journalSequence:cp.sequence,
    journalHead:cp.journalHead,checkpointDigest:witness.checkpointDigest,
    issuedAt:now.toISOString(),
    expiresAt:new Date(now.getTime()+minutes*60000).toISOString()};
}
export function verifyAnchor(anchor,witness,keys,{
  releaseCommit,now=new Date(),minRevision=1,minSequence=1,
  witnessActors=[]
}={}){
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw new TypeError('Invalid clock');
  const blockers=[];
  if(!exact(anchor,ANCHOR_FIELDS)||anchor.schema!==ANCHOR_SCHEMA||
    anchor.role!=='custodian'||!ID.test(anchor.actorId||'')||
    !SIG.test(anchor.signature||'')||
    Buffer.from(anchor.signature||'','base64').toString('base64')!==anchor.signature)
    blockers.push('invalid_anchor_shape');
  if(!COMMIT.test(releaseCommit||'')||anchor?.releaseCommit!==releaseCommit||
    !SHA.test(anchor?.registryDigest||'')||!SHA.test(anchor?.journalHead||'')||
    !SHA.test(anchor?.checkpointDigest||'')||
    anchor?.registryRevision!==witness?.checkpoint?.revision||
    anchor?.journalSequence!==witness?.checkpoint?.sequence||
    anchor?.registryDigest!==witness?.checkpoint?.registryDigest||
    anchor?.journalHead!==witness?.checkpoint?.journalHead||
    anchor?.checkpointDigest!==witness?.checkpointDigest)
    blockers.push('checkpoint_mismatch');
  const start=time(anchor?.issuedAt)?Date.parse(anchor.issuedAt):NaN;
  const end=time(anchor?.expiresAt)?Date.parse(anchor.expiresAt):NaN;
  if(!Number.isFinite(start)||!Number.isFinite(end)||
    start>now.getTime()||end<=now.getTime()||end<=start||
    end-start>MAX||now.getTime()-start>MAX)
    blockers.push('expired_anchor');
  if(!positive(minRevision)||!positive(minSequence)||
    anchor?.registryRevision<minRevision||anchor?.journalSequence<minSequence)
    blockers.push('anchor_below_operator_floor');
  if(!Array.isArray(witnessActors)||witnessActors.includes(anchor?.actorId))
    blockers.push('custodian_not_independent_person');
  let custodian;
  try{
    custodian=key(keys?.custodian);
    for(const name of ['owner','manager']){
      const other=key(keys?.[name]);
      if(custodian.export({type:'spki',format:'der'}).equals(
        other.export({type:'spki',format:'der'})))
        blockers.push('custodian_key_not_independent');
    }
    if(!verify(null,Buffer.from(anchorMessage(anchor),'utf8'),custodian,
      Buffer.from(anchor.signature||'','base64')))
      blockers.push('bad_custodian_signature');
  }catch{blockers.push('untrusted_custodian_key');}
  return {schema:ANCHOR_REPORT_SCHEMA,valid:blockers.length===0,
    blockers:[...new Set(blockers)],
    anchorDigest:anchorDigest(anchor),
    sequence:positive(anchor?.journalSequence)?anchor.journalSequence:null,
    revision:positive(anchor?.registryRevision)?anchor.registryRevision:null,
    writesChanged:false,offsiteStorageVerified:false};
}
export function r18Configured(env=process.env){
  return Object.keys(env).some(k=>k.startsWith('GUEST_R18_'));
}
function config(env){
  if(REQUIRE.some(k=>typeof env[k]!=='string'||!env[k]))
    throw Error('R18 independent custodian checkpoint required');
  for(const k of ['GUEST_R18_MIN_REVISION','GUEST_R18_MIN_SEQUENCE'])
    if(!/^[1-9][0-9]{0,12}$/.test(env[k])||
      !positive(Number(env[k])))
      throw Error('R18 trusted external monotonic floor required');
  if(basename(env.GUEST_R18_ANCHOR_FILE)!=='anchor.json')
    throw Error('R18 anchor path must be named anchor.json');
}
export async function loadR18Anchor(env=process.env,witness=null,now=new Date()){
  config(env);
  if(!r17Configured(env))throw Error('R18 requires R17');
  const source=witness??await loadR17Witness(env,now);
  const anchorPath=resolve(env.GUEST_R18_ANCHOR_FILE);
  const independent=[
    env.GUEST_R17_OWNER_WITNESS_FILE,env.GUEST_R17_MANAGER_WITNESS_FILE,
    env.GUEST_R17_JOURNAL_FILE,env.GUEST_R16_REGISTRY_FILE
  ];
  if(independent.some(path=>typeof path!=='string'||
    dirname(resolve(path))===dirname(anchorPath)))
    throw Error('Anchor cannot share custody directory with R14-R17 evidence');
  const [record,custodian,owner,manager,ownerRecord,managerRecord]=await Promise.all([
    readOutsideCheckout(anchorPath,{privateFile:true}),
    readOutsideCheckout(env.GUEST_R18_CUSTODIAN_PUBLIC_KEY),
    readOutsideCheckout(env.GUEST_R17_OWNER_PUBLIC_KEY),
    readOutsideCheckout(env.GUEST_R17_MANAGER_PUBLIC_KEY),
    readOutsideCheckout(env.GUEST_R17_OWNER_WITNESS_FILE,{privateFile:true}),
    readOutsideCheckout(env.GUEST_R17_MANAGER_WITNESS_FILE,{privateFile:true})
  ]);
  const report=verifyAnchor(JSON.parse(record),
    {...source,releaseCommit:env.GUEST_RELEASE_COMMIT},
    {custodian,owner,manager},{
      releaseCommit:env.GUEST_RELEASE_COMMIT,now,
      minRevision:Number(env.GUEST_R18_MIN_REVISION),
      minSequence:Number(env.GUEST_R18_MIN_SEQUENCE),
      witnessActors:[JSON.parse(ownerRecord).actorId,JSON.parse(managerRecord).actorId]
    });
  if(!report.valid)throw Error('R18 external receipt cannot authorize writes');
  return {anchorDigest:report.anchorDigest,sequence:report.sequence,
    revision:report.revision,checkpointDigest:source.checkpointDigest,
    receiptVerified:true,offsiteStorageVerified:false};
}
