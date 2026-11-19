/**
 * A manually approved, LOCAL, empty disposable Postgres target only.
 * Existing ops/restore-dr.sh runs actual AGE decryption + pg_restore.
 * Refuses remote hosts, production DBs and expired approvals before any IO.
 */
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {R35_PIN} from './guest-r36-source.mjs';
export const R36_RESTORE_SCHEMA='osmanx.guest.r36.local-disposable-restore.v1';
const SHA=/^[a-f0-9]{64}$/;
const TREE=/^[a-f0-9]{40}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const keys=['schema','pilotId','releaseSha','sourceTreeSha',
  'archiveSha256','archivePath','identityFile',
  'issuedAt','expiresAt','nonce','allowedTargetDb'];
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===keys.slice().sort().join('|');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function inspectR36DisposableTarget(url){
  const blockers=[];let db=null;
  try{
    const u=new URL(url);
    const host=u.hostname.replace(/^\[|\]$/g,'');
    db=decodeURIComponent(u.pathname.slice(1));
    if(!['postgres:','postgresql:'].includes(u.protocol)||
      !['localhost','127.0.0.1','::1'].includes(host)||
      !(u.port===''||u.port==='5432')||
      u.search!==''||u.hash!==''||
      !/^industry_dr_r36_[a-z0-9]{6,16}$/.test(db))
      blockers.push('NOT_ISOLATED_LOOPBACK_R36_DATABASE');
  }catch{blockers.push('INVALID_DB_URL')}
  return {safe:blockers.length===0,db,blockers};
}
export function verifyR36RestoreApproval(plan,{now=new Date()}={}){
  const blockers=[];
  if(!exact(plan,keys)||plan?.schema!==R36_RESTORE_SCHEMA||
    !UUID.test(plan?.pilotId||'')||
    plan?.releaseSha!==R35_PIN.sha||
    !TREE.test(plan?.sourceTreeSha||'')||
    !SHA.test(plan?.archiveSha256||'')||
    typeof plan?.archivePath!=='string'||
    !isAbsolute(plan.archivePath)||plan.archivePath.includes('\0')||
    plan.archivePath.length>1024||
    typeof plan?.identityFile!=='string'||
    !isAbsolute(plan.identityFile)||plan.identityFile.includes('\0')||
    plan.identityFile.length>1024||
    !/^industry_dr_r36_[a-z0-9]{6,16}$/.test(plan?.allowedTargetDb||'')||
    !/^[a-f0-9]{32}$/.test(plan?.nonce||''))
    blockers.push('INVALID_DISPOSABLE_RESTORE_APPROVAL');
  const start=Date.parse(plan?.issuedAt),end=Date.parse(plan?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(start)||!Number.isFinite(end)||
    start>now.getTime()||now.getTime()>=end||
    end<=start||end-start>300000)
    blockers.push('RESTORE_APPROVAL_EXPIRED');
  return {valid:blockers.length===0,blockers:[...new Set(blockers)]};
}
export async function runR36DisposableRestore({plan,dbUrl,approved=false,
  hashArchive,checkIdentity,restoreCommand,
  clock=()=>new Date()}={}){
  const checked=verifyR36RestoreApproval(plan,{now:clock()}),
    target=inspectR36DisposableTarget(dbUrl);
  if(!approved||!checked.valid||!target.safe||
    target.db!==plan?.allowedTargetDb)
    throw Error('R36 restore requires explicitly approved isolated loopback database');
  if(typeof hashArchive!=='function'||
    typeof checkIdentity!=='function'||typeof restoreCommand!=='function')
    throw Error('Restore adapters not available');
  // NO archive, key, database or process access before validating the plan.
  const proof=await hashArchive({
    path:plan.archivePath,expectedSha:plan.archiveSha256,
    maxBytes:64*1024*1024,requireAgeHeader:true
  });
  if(proof?.sha256!==plan.archiveSha256||
    proof?.ageEnvelopeHeaderSeen!==true)
    throw Error('Encrypted AGE archive SHA mismatch');
  await checkIdentity(plan.identityFile);
  if(!verifyR36RestoreApproval(plan,{now:clock()}).valid)
    throw Error('Restore approval expired before running script');
  const result=await restoreCommand({
    script:'ops/restore-dr.sh',archive:plan.archivePath,
    identityFile:plan.identityFile,dbUrl
  });
  if(result?.exitCode!==0||result?.verifiedEmptyTarget!==true)
    throw Error('Local disposable restore failed or target not empty');
  const data={schema:'osmanx.guest.r36.local-restore-evidence.v1',
    pilotId:plan.pilotId,sourceTreeSha:plan.sourceTreeSha,
    approvedPlanSha256:hash(plan),archiveSha256:plan.archiveSha256,
    databaseName:target.db,
    localDisposableRestoreExecuted:true,
    archiveDecryptedByAgeAndPgRestoreSucceeded:true,
    verifiedExistingR36TargetInitiallyEmpty:true,
    noProductionDatabaseUsed:true,
    actualRemoteOffsiteCustodyVerified:false,
    externalRestorationIndependentlyWitnessed:false,
    realProductionRollbackTested:false,customerGo:false,
    productionAuthorized:false};
  return {...data,sha256:hash(data)};
}
