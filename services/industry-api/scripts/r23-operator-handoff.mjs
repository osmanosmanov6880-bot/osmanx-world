/**
 * R23 strictly allowlisted hand-off packet for independent release review.
 * Binds GitHub stack, two-origin GET canary, real two-tenant RLS rehearsal,
 * two-copy DR and R22 attestation to one pilot and full release SHA.
 *
 * A hash proves integrity against a trusted expected hash, NOT independent
 * identity. The packet is always NO-GO and cannot trigger any action.
 */
import {createHash} from 'node:crypto';
import {open,realpath} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MERGE_SCHEMA} from './r23-merge-plan.mjs';
import {CANARY_SCHEMA} from './r23-http-canary.mjs';
import {RLS_SCHEMA} from './r23-tenant-isolation.mjs';
import {DR_SCHEMA} from './r22-dr-quorum.mjs';
import {REVIEW_SCHEMA} from './r22-preflight-review.mjs';
export const HANDOFF_SCHEMA='osmanx.guest.r23.operator-handoff.v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const code=/^[a-z][A-Za-z0-9_:-]{0,79}$/;
const exact=(obj,fields)=>obj&&typeof obj==='object'&&!Array.isArray(obj)&&
  Object.keys(obj).sort().join('|')===[...fields].sort().join('|');
const hash=obj=>createHash('sha256').update(JSON.stringify(obj)).digest('hex');
function takeBlockers(x,n=80){
  if(!Array.isArray(x)||x.length>n||!x.every(s=>typeof s==='string'&&code.test(s)))
    throw Error('Unsafe report blockers');
  return [...new Set(x)];
}
function compact(reports){
  const m=reports?.merge,c=reports?.canary,t=reports?.tenants,
    d=reports?.dr,r=reports?.prior;
  return {
    merge:{schema:m?.schema||null,stagedCodeVerified:m?.stagedCodeVerified===true,
      allMerged:m?.allMerged===true,mainProtected:m?.mainProtected===true,
      mainTipStable:m?.mainTipStable===true,
      blockers:takeBlockers(m?.blockers)},
    canary:{schema:c?.schema||null,technicalCanaryReady:c?.technicalCanaryReady===true,
      blockers:takeBlockers(c?.blockers)},
    tenants:{schema:t?.schema||null,technicalIsolationPass:t?.technicalIsolationPass===true,
      transactionRolledBack:t?.transactionRolledBack===true,
      blockers:takeBlockers(t?.blockers)},
    dr:{schema:d?.schema||null,technicalQuorumReady:d?.technicalQuorumReady===true,
      contentsIdentical:d?.contentsIdentical===true,
      blockers:takeBlockers(d?.blockers)},
    prior:{schema:r?.schema||null,derivedTechnicalChecksPassed:r?.derivedTechnicalChecksPassed===true,
      blockers:takeBlockers(r?.blockers)}
  };
}
function outcomes(entries){
  const checks={
    stackMerged:entries.merge.schema===MERGE_SCHEMA&&entries.merge.allMerged&&
      entries.merge.mainProtected&&entries.merge.mainTipStable,
    canaryPrivate:entries.canary.schema===CANARY_SCHEMA&&
      entries.canary.technicalCanaryReady,
    tenantRlsIsolated:entries.tenants.schema===RLS_SCHEMA&&
      entries.tenants.technicalIsolationPass&&entries.tenants.transactionRolledBack,
    twoDrCopiesVerified:entries.dr.schema===DR_SCHEMA&&
      entries.dr.technicalQuorumReady&&entries.dr.contentsIdentical,
    priorEvidenceAccepted:entries.prior.schema===REVIEW_SCHEMA&&
      entries.prior.derivedTechnicalChecksPassed
  };
  const blockers=Object.entries(checks).filter(([,v])=>v!==true)
    .map(([name])=>'handoff_'+name);
  return {checks,blockers};
}
export function makeR23Handoff({tenantId,pilotId,releaseCommit,
  scopeDigest,reports,now=new Date()}={}){
  if(!UUID.test(tenantId||'')||!UUID.test(pilotId||'')||
    !COMMIT.test(releaseCommit||'')||!SHA.test(scopeDigest||'')||
    !(now instanceof Date)||!Number.isFinite(now.getTime())||
    reports?.merge?.sourceHeadSha!==releaseCommit||
    reports?.prior?.tenantId!==tenantId||
    reports?.prior?.pilotId!==pilotId||
    reports?.prior?.releaseCommit!==releaseCommit)
    throw Error('Handoff source release, tenant or scope mismatch');
  const normalized=compact(reports);
  const {checks,blockers}=outcomes(normalized);
  const payload={
    schema:HANDOFF_SCHEMA,tenantId,pilotId,releaseCommit,scopeDigest,
    createdAt:now.toISOString(),
    expiresAt:new Date(now.getTime()+30*60000).toISOString(),
    checks,reports:normalized,blockers
  };
  return {...payload,payloadSha:hash(payload),
    unsignedDocument:true,independentOperatorVerified:false,
    offsiteWormVerified:false,legalGo:false,customerGo:false,
    automaticMergeAllowed:false,productionAuthorized:false,
    productionChanged:false};
}
export function verifyR23Handoff(packet,{
  tenantId,pilotId,releaseCommit,scopeDigest,now=new Date()
}={}){
  const blockers=[];
  if(!exact(packet,['schema','tenantId','pilotId','releaseCommit',
    'scopeDigest','createdAt','expiresAt','checks','reports','blockers',
    'payloadSha','unsignedDocument','independentOperatorVerified',
    'offsiteWormVerified','legalGo','customerGo','automaticMergeAllowed',
    'productionAuthorized','productionChanged'])||
    packet.schema!==HANDOFF_SCHEMA||!UUID.test(packet.tenantId||'')||
    !UUID.test(packet.pilotId||'')||!COMMIT.test(packet.releaseCommit||'')||
    !SHA.test(packet.scopeDigest||'')||!SHA.test(packet.payloadSha||''))
    blockers.push('invalid_packet_shape');
  if(tenantId!==undefined&&packet?.tenantId!==tenantId)blockers.push('wrong_tenant');
  if(pilotId!==undefined&&packet?.pilotId!==pilotId)blockers.push('wrong_pilot');
  if(releaseCommit!==undefined&&packet?.releaseCommit!==releaseCommit)
    blockers.push('wrong_commit');
  if(scopeDigest!==undefined&&packet?.scopeDigest!==scopeDigest)
    blockers.push('wrong_scope');
  const start=ISO.test(packet?.createdAt||'')?Date.parse(packet.createdAt):NaN;
  const end=ISO.test(packet?.expiresAt||'')?Date.parse(packet.expiresAt):NaN;
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(start)||!Number.isFinite(end)||end-start!==30*60000||
    start>now.getTime()||end<=now.getTime())blockers.push('expired_packet');
  try{
    const expected=compact(packet.reports);
    const fromData=outcomes(expected);
    if(JSON.stringify(packet.reports)!==JSON.stringify(expected))
      blockers.push('unapproved_report_fields');
    if(JSON.stringify(packet.checks)!==JSON.stringify(fromData.checks)||
       JSON.stringify(packet.blockers)!==JSON.stringify(fromData.blockers))
      blockers.push('derived_blockers_changed');
    const {payloadSha,unsignedDocument,independentOperatorVerified,
      offsiteWormVerified,legalGo,customerGo,automaticMergeAllowed,
      productionAuthorized,productionChanged,...body}=packet;
    if(hash(body)!==packet.payloadSha)blockers.push('hash_mismatch');
  }catch{blockers.push('invalid_packet_content');}
  for(const key of ['independentOperatorVerified','offsiteWormVerified',
    'legalGo','customerGo','automaticMergeAllowed','productionAuthorized',
    'productionChanged'])if(packet?.[key]!==false)blockers.push('unsafe_authorization_fields');
  if(packet?.unsignedDocument!==true)blockers.push('invalid_document_kind');
  return {schema:'osmanx.guest.r23.operator-handoff-check.v1',
    valid:blockers.length===0,blockers:[...new Set(blockers)],
    independentlySigned:false,customerGo:false,productionAuthorized:false,
    changedProduction:false};
}
export async function writeR23Handoff(path,packet){
  if(typeof path!=='string'||!path.startsWith('/')||resolve(path)!==path)
    throw Error('Absolute private path required');
  const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
  if(path===root||path.startsWith(root+sep))throw Error('Checkout path forbidden');
  if(await realpath(dirname(path))!==dirname(path))
    throw Error('Symlinked directory forbidden');
  const f=await open(path,'wx',0o600);
  try{await f.writeFile(JSON.stringify(packet)+'\n');await f.sync();}
  finally{await f.close();}
  return {created:true,payloadSha:packet.payloadSha,uploaded:false,
    productionChanged:false};
}
