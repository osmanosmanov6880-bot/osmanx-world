/**
 * R18 portable, non-PII evidentiary snapshot. A copy is NOT a verified offsite
 * upload or immutable WORM object; its custodian and platform keys must be
 * pinned separately by the recovery team.
 */
import {digest as hash,verifyWitnesses} from './guest-r17-witness.mjs';
import {evaluateRegistry} from './guest-r16-registry.mjs';
import {verifyAnchor} from './guest-r18-anchor.mjs';
export const PROOF_SCHEMA='osmanx.guest.r18.portable-proof.v1';
const FIELDS=['schema','createdAt','releaseCommit','records','manifest','bundleDigest'];
const RECORD_KEYS=['registry','journal','ownerWitness','managerWitness','anchor'];
const REGEX=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const exact=(obj,keys)=>obj!==null&&typeof obj==='object'&&!Array.isArray(obj)&&
  Object.keys(obj).sort().join('|')===[...keys].sort().join('|');
const iso=value=>typeof value==='string'&&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export function createPortableProof(records,releaseCommit,now=new Date()){
  if(!exact(records,RECORD_KEYS)||!COMMIT.test(releaseCommit||'')||
    !(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw Error('Invalid non-PII archive source');
  const createdAt=now.toISOString();
  const manifest=Object.fromEntries(RECORD_KEYS.map(key=>[key,hash(records[key])]));
  const basic={schema:PROOF_SCHEMA,createdAt,releaseCommit,records,manifest};
  return {...basic,bundleDigest:hash(basic)};
}
export function verifyPortableProof(proof,keys,{
  now=new Date(),minRevision=1,minSequence=1,releaseCommit
}={}){
  const blockers=[];
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw TypeError('Invalid verification clock');
  if(!exact(proof,FIELDS)||proof.schema!==PROOF_SCHEMA||
    !exact(proof.records,RECORD_KEYS)||
    !exact(proof.manifest,RECORD_KEYS)||!iso(proof.createdAt)||
    Date.parse(proof.createdAt)>now.getTime()||
    !COMMIT.test(proof.releaseCommit||'')||
    proof.releaseCommit!==releaseCommit||!REGEX.test(proof.bundleDigest||''))
    blockers.push('proof_shape');
  for(const name of RECORD_KEYS){
    try{
      if(!REGEX.test(proof?.manifest?.[name]||'')||
        hash(proof.records[name])!==proof.manifest[name])
        blockers.push('record_digest_'+name);
    }catch{blockers.push('record_digest_'+name);}
  }
  try{
    const {bundleDigest,...base}=proof;
    if(hash(base)!==bundleDigest)blockers.push('bundle_digest');
  }catch{blockers.push('bundle_digest');}
  let r17=null,r18=null;
  try{
    const r16=evaluateRegistry(proof.records.registry,{
      owner:keys?.platformOwner,manager:keys?.platformManager
    },releaseCommit,minRevision,now);
    if(!r16.valid)blockers.push('invalid_signed_r16_registry');
    r17=verifyWitnesses(proof.records.ownerWitness,proof.records.managerWitness,{
      owner:keys?.witnessOwner,manager:keys?.witnessManager
    },proof.records.registry,proof.records.journal,{
      now,minSequence,minRevision,releaseCommit
    });
    if(!r17.valid)blockers.push('invalid_signed_r17_witness');
    const r18=verifyAnchor(proof.records.anchor,{
      checkpoint:r17.checkpoint,checkpointDigest:r17.checkpointDigest
    },{
      custodian:keys?.custodian,owner:keys?.witnessOwner,
      manager:keys?.witnessManager
    },{
      now,releaseCommit,minSequence,minRevision,
      witnessActors:[
        proof.records.ownerWitness?.actorId,
        proof.records.managerWitness?.actorId
      ]
    });
    if(!r18.valid)blockers.push('invalid_signed_r18_custodian');
  }catch{blockers.push('invalid_evidence_chain');}
  return {schema:'osmanx.guest.r18.portable-proof.report.v1',
    valid:blockers.length===0,blockers:[...new Set(blockers)],
    checkpointDigest:r17?.checkpointDigest||null,
    revision:r17?.checkpoint?.revision||null,
    sequence:r17?.checkpoint?.sequence||null,
    proofDigest:typeof proof?.bundleDigest==='string'?proof.bundleDigest:null,
    productionChanged:false,offsiteStorageVerified:false};
}
