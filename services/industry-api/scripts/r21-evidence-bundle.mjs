/**
 * R21 portable, non-PII and non-secret preproduction evidence envelope.
 * Do NOT treat SHA-256 as a signature: independent R20 ticket signatures,
 * operator trust anchors, legal review and WORM upload remain separate.
 */
import {createHash} from 'node:crypto';
import {open,realpath} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {R21_CHAIN_SCHEMA} from './r21-release-chain.mjs';
import {HOST_SCHEMA} from './r21-host-posture.mjs';
import {AUDIT_SCHEMA} from '../src/guest-r21-db-audit.mjs';

export const BUNDLE_SCHEMA='osmanx.guest.r21.readiness-evidence.v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&
  Object.keys(v).sort().join('|')===[...keys].sort().join('|');
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// R22: a blocker is a MACHINE CODE, not arbitrary user text.
 // Blockers from external operator JSON must never smuggle email, file paths,
 // token values or private messages into a supposedly secret-free bundle.
function safeBlockers(value,max){
  if(value===undefined||value===null)return [];
  if(!Array.isArray(value)||value.length>max)
    throw Error('Unsafe external evidence blocker list');
  const valid=/^[a-z][a-z0-9_:-]{0,79}$/;
  if(!value.every(x=>typeof x==='string'&&valid.test(x)))
    throw Error('Evidence blocker must be an allowlisted machine code');
  return [...value];
}
function compact(input){
  // Hardcoded allowlist guarantees no database URL, filename, auth header,
  // email, raw guest record, secret key, or consent document is serialized.
  const c=input?.chain,h=input?.host,d=input?.database,
    r=input?.restore,t=input?.ticket;
  return {
    chain:{schema:c?.schema||null,stagedCodeVerified:c?.stagedCodeVerified===true,
      allDependenciesMerged:c?.allDependenciesMerged===true,
      blockers:safeBlockers(c?.blockers,80)},
    host:{schema:h?.schema||null,liveHostInspected:h?.liveHostInspected===true,
      safeIsolatedRehearsal:h?.safeIsolatedRehearsal===true,
      blockers:safeBlockers(h?.blockers,30)},
    database:{schema:d?.schema||null,technicalPostureReady:d?.technicalPostureReady===true,
      blockers:safeBlockers(d?.blockers,30),
      usageRows:Number.isSafeInteger(d?.usageRows)?d.usageRows:null,
      auditEventCount:Number.isSafeInteger(d?.auditEventCount)?d.auditEventCount:null},
    restore:{schema:r?.schema||null,technicalRestoreReady:r?.technicalRestoreReady===true,
      blockers:safeBlockers(r?.blockers,30)},
    ticket:{schema:t?.schema||null,valid:t?.valid===true,
      ticketDigest:SHA.test(t?.ticketDigest||'')?t.ticketDigest:null,
      blockers:safeBlockers(t?.blockers,30)}
  };
}
function blockersFor(bundle){
  const r=bundle.reports;
  const blockers=[];
  if(r.chain.schema!==R21_CHAIN_SCHEMA||!r.chain.stagedCodeVerified||
     !r.chain.allDependenciesMerged)blockers.push('release_chain_unmerged_or_changed');
  if(r.host.schema!==HOST_SCHEMA||!r.host.safeIsolatedRehearsal||
    !r.host.liveHostInspected)blockers.push('host_not_independently_verified');
  if(r.database.schema!==AUDIT_SCHEMA||!r.database.technicalPostureReady)
    blockers.push('database_posture_failed');
  if(r.restore.schema!=='osmanx.guest.r20.restore-crosscheck.v1'||
     !r.restore.technicalRestoreReady)blockers.push('dr_reconciliation_failed');
  if(r.ticket.schema!=='osmanx.guest.r20.change-ticket-check.v1'||
     !r.ticket.valid||!SHA.test(r.ticket.ticketDigest||''))
    blockers.push('two_human_ticket_not_verified');
  return blockers;
}
export function makeR21Bundle({tenantId,pilotId,releaseCommit,
  scopeDigest,reports,now=new Date()}={}){
  if(!UUID.test(tenantId||'')||!UUID.test(pilotId||'')||
     !COMMIT.test(releaseCommit||'')||!SHA.test(scopeDigest||'')||
     !(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw Error('R21 bundle requires exact pilot and source release');
  const values=compact(reports);
  const base={schema:BUNDLE_SCHEMA,
    tenantId,pilotId,releaseCommit,scopeDigest,
    createdAt:now.toISOString(),
    expiresAt:new Date(now.getTime()+3600000).toISOString(),
    reports:values};
  const blockers=blockersFor(base);
  return {...base,blockers,manifestDigest:digest({...base,blockers}),
    // Intentionally NO automatic authorization, even with empty blockers.
    documentOnly:true,legalGo:false,customerGo:false,
    productionActivationAllowed:false,offsiteWormVerified:false,
    changedProduction:false};
}
export function verifyR21Bundle(bundle,{now=new Date(),releaseCommit,
  tenantId,pilotId,scopeDigest}={}){
  const errors=[];
  if(!exact(bundle,['schema','tenantId','pilotId','releaseCommit','scopeDigest',
    'createdAt','expiresAt','reports','blockers','manifestDigest',
    'documentOnly','legalGo','customerGo','productionActivationAllowed',
    'offsiteWormVerified','changedProduction'])||
    bundle.schema!==BUNDLE_SCHEMA||!UUID.test(bundle.tenantId||'')||
    !UUID.test(bundle.pilotId||'')||!COMMIT.test(bundle.releaseCommit||'')||
    !SHA.test(bundle.scopeDigest||'')||!SHA.test(bundle.manifestDigest||''))
    errors.push('invalid_bundle_shape');
  const created=ISO.test(bundle?.createdAt||'')?Date.parse(bundle.createdAt):NaN;
  const expires=ISO.test(bundle?.expiresAt||'')?Date.parse(bundle.expiresAt):NaN;
  if(!Number.isFinite(created)||!Number.isFinite(expires)||
     created>now.getTime()||expires<=now.getTime()||
     expires-created!==3600000)errors.push('bundle_expired_or_clock_invalid');
  if(releaseCommit!==undefined&&releaseCommit!==bundle?.releaseCommit)
    errors.push('wrong_release');
  if(tenantId!==undefined&&tenantId!==bundle?.tenantId)
    errors.push('wrong_tenant');
  if(pilotId!==undefined&&pilotId!==bundle?.pilotId)
    errors.push('wrong_pilot');
  if(scopeDigest!==undefined&&scopeDigest!==bundle?.scopeDigest)
    errors.push('wrong_scope');
  let recomputed;
  try{
    const {manifestDigest,documentOnly,legalGo,customerGo,
      productionActivationAllowed,offsiteWormVerified,changedProduction,...base}=bundle;
    recomputed=digest(base);
    if(recomputed!==manifestDigest)errors.push('bundle_digest_mismatch');
    if(JSON.stringify(compact(base.reports))!==JSON.stringify(base.reports))
      errors.push('unapproved_report_fields');
    if(JSON.stringify(blockersFor(base))!==JSON.stringify(base.blockers))
      errors.push('blocker_reconciliation_changed');
  }catch{errors.push('bundle_canonicalization_invalid');}
  if(bundle?.documentOnly!==true||bundle?.legalGo!==false||
     bundle?.customerGo!==false||bundle?.productionActivationAllowed!==false||
     bundle?.offsiteWormVerified!==false||bundle?.changedProduction!==false)
    errors.push('unsafe_bundle_authorization_fields');
  return {schema:'osmanx.guest.r21.readiness-evidence-check.v1',
    valid:errors.length===0,errors:[...new Set(errors)],
    evidenceDigest:SHA.test(bundle?.manifestDigest||'')?bundle.manifestDigest:null,
    readinessBlockers:Array.isArray(bundle?.blockers)?bundle.blockers:[],
    documentaryOnly:true,legalGo:false,customerGo:false,
    changedProduction:false};
}
export async function writeR21Bundle(output,bundle){
  if(typeof output!=='string'||!output.startsWith('/')||resolve(output)!==output)
    throw Error('Absolute private destination required');
  const checkout=resolve(fileURLToPath(new URL('..',import.meta.url)));
  if(output===checkout||output.startsWith(checkout+sep))
    throw Error('R21 evidence never stored in source checkout');
  const parent=dirname(output);
  if(await realpath(parent)!==parent)
    throw Error('Symlinked output directory refused');
  const h=await open(output,'wx',0o600);
  try{await h.writeFile(JSON.stringify(bundle)+'\n');await h.sync();}
  finally{await h.close();}
  return {written:true,checksum:bundle.manifestDigest,
    offsiteUploadPerformed:false,productionChanged:false};
}
