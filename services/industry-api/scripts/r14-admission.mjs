/**
 * R14 signed, two-person external-operational acceptance.
 * No PII, passwords, database queries or write toggles. The trust anchors are
 * independent operator-owned Ed25519 PUBLIC keys outside the source checkout.
 */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {resolve} from 'node:path';
import {readR40Regular} from '../src/guest-r40-secure-files.mjs';
import {validateR40ApprovalTimeline,canonicalR40Utc}
  from '../src/guest-r40-admission-timeline.mjs';
import {fileURLToPath} from 'node:url';

export const ADMISSION_SCHEMA='osmanx.guest.r14.admission.v1';
export const ATTESTATION_SCHEMA='osmanx.guest.r14.attestation.v1';
export const REQUIRED_EVIDENCE=Object.freeze([
  'stagingPassed','rlsVerified','monitoringPassed','incidentDrill',
  'offsiteRestore','lawfulBasis','dataProcessingTerms','privacyNotice',
  'retentionPolicy','consentProcess','clientProtocol'
]);
const SHA=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const ID=/^[A-Za-z0-9._-]{3,80}$/;
const maxAge=(key)=>key==='offsiteRestore'?30*86400000:7*86400000;
export const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function evidenceDigest(record){
  return digest({schema:ADMISSION_SCHEMA,releaseCommit:record.releaseCommit,evidence:record.evidence});
}
export function attestationMessage({role,actorId,releaseCommit,evidenceDigest:sha,acceptedAt,expiresAt}){
  return JSON.stringify({schema:ATTESTATION_SCHEMA,role,actorId,releaseCommit,
    evidenceDigest:sha,acceptedAt,expiresAt});
}
function isValidDate(s){
  return canonicalR40Utc(s);
}
function keyInfo(pem){
  const key=createPublicKey(pem);
  if(key.asymmetricKeyType!=='ed25519')throw new Error('Requires independent Ed25519 public keys');
  return key;
}
export function evaluateAdmission(record,{owner,manager},now=new Date()){
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new TypeError('Invalid clock');
  const issues=[];
  if(!record||typeof record!=='object'||record.schema!==ADMISSION_SCHEMA||
      !COMMIT.test(record.releaseCommit||''))issues.push('invalid_release_manifest');
  const evidence=record?.evidence;
  if(!evidence||typeof evidence!=='object'||Array.isArray(evidence)||
    Object.keys(evidence).sort().join('|')!==[...REQUIRED_EVIDENCE].sort().join('|'))
    issues.push('missing_or_extra_evidence');
  for(const name of REQUIRED_EVIDENCE){
    const item=evidence?.[name];
    const age=isValidDate(item?.observedAt)?now.getTime()-Date.parse(item.observedAt):Infinity;
    if(item?.ok!==true||!SHA.test(item?.sha256||'')||age<0||age>maxAge(name))
      issues.push('evidence_'+name);
  }
  const keys={};
  try{
    keys.owner=keyInfo(owner);keys.manager=keyInfo(manager);
    if(keys.owner.export({type:'spki',format:'der'}).equals(
       keys.manager.export({type:'spki',format:'der'})))issues.push('same_signing_key');
  }catch{issues.push('invalid_public_keys');}
  const entries=record?.attestations;
  if(!Array.isArray(entries)||entries.length!==2||
    entries.filter(x=>x?.role==='owner').length!==1||
    entries.filter(x=>x?.role==='manager').length!==1){
    issues.push('two_distinct_roles_required');
  }
  const chronology=validateR40ApprovalTimeline(record,{now});
  issues.push(...chronology.blockers);
  const signingDigest=evidenceDigest(record||{});
  for(const role of ['owner','manager']){
    const entry=Array.isArray(entries)?entries.find(x=>x?.role===role):null;
    if(!entry||!ID.test(entry.actorId||'')||
       entry.releaseCommit!==record?.releaseCommit||
       entry.evidenceDigest!==signingDigest||
       !isValidDate(entry.acceptedAt)||!isValidDate(entry.expiresAt)||
       Date.parse(entry.acceptedAt)>now.getTime()||
       now.getTime()-Date.parse(entry.acceptedAt)>7*86400000||
       Date.parse(entry.expiresAt)<=now.getTime()||
       Date.parse(entry.expiresAt)-Date.parse(entry.acceptedAt)>14*86400000||
       typeof entry.signature!=='string'||
       !/^[A-Za-z0-9+/]{86}==$/.test(entry.signature)){
      issues.push('invalid_'+role+'_attestation');continue;
    }
    try{
      if(!keys[role]||!verify(null,
        Buffer.from(attestationMessage(entry),'utf8'),keys[role],
        Buffer.from(entry.signature,'base64')))issues.push('bad_'+role+'_signature');
    }catch{issues.push('bad_'+role+'_signature');}
  }
  const ownerEntry=Array.isArray(entries)?entries.find(x=>x?.role==='owner'):null;
  const managerEntry=Array.isArray(entries)?entries.find(x=>x?.role==='manager'):null;
  if(ownerEntry?.actorId&&ownerEntry.actorId===managerEntry?.actorId)
    issues.push('same_human_cannot_approve_twice');
  return {schema:'osmanx.guest.r14.admission.report.v1',releaseCommit:
    COMMIT.test(record?.releaseCommit||'')?record.releaseCommit:null,
    evidenceDigest:signingDigest,operatorGo:issues.length===0,
    blockers:[...new Set(issues)],productionWritesEnabled:false,
    disclaimer:'Подписи подтверждают решение операторов, но не заменяют договор и законные основания. Этот отчёт НЕ меняет режим записи, VPS, DNS или Nginx.'};
}
async function readRegular(path,privateFile=false){
  return readR40Regular(path,{privateFile,maxBytes:privateFile?131072:16384});
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  const args=process.argv.slice(2);
  if(args.length!==4||args[3]!=='--require-go')
    throw Error('Usage: node scripts/r14-admission.mjs /private/decision.json /private/owner.pub.pem /private/manager.pub.pem --require-go');
  let result;
  try{
    const record=JSON.parse(await readRegular(args[0],true));
    const owner=await readRegular(args[1]);
    const manager=await readRegular(args[2]);
    result=evaluateAdmission(record,{owner,manager});
  }catch{
    result={schema:'osmanx.guest.r14.admission.report.v1',operatorGo:false,
      blockers:['invalid_private_inputs'],productionWritesEnabled:false};
  }
  process.stdout.write(JSON.stringify(result)+'\n');
  if(!result.operatorGo)process.exitCode=2;
}
