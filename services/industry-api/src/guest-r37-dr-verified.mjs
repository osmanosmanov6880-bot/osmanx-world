/**
 * R37 real, read-only PostgreSQL pre/post inspections for local disposable DR.
 * Never creates/drops a DB. Existing R36 operator restoration is separately
 * approved and can only run after the real server reports an empty target.
 */
import {createHash} from 'node:crypto';
import {inspectR36DisposableTarget,verifyR36RestoreApproval}
  from './guest-r36-disposable-restore.mjs';
export const R37_DR_SCHEMA='osmanx.guest.r37.verified-disposable-postgres.v1';
const DB=/^industry_dr_r36_[a-z0-9]{6,16}$/;
const SHA=/^[a-f0-9]{64}$/;
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function evaluateR37DatabaseInspection({
  row,expectedName,phase='before'
}={}){
  const blockers=[];
  if(!DB.test(expectedName||'')||!['before','after'].includes(phase))
    blockers.push('INVALID_DISPOSABLE_DB_SCOPE');
  if(!row||typeof row!=='object'||
    row.database_name!==expectedName||
    !['127.0.0.1','::1'].includes(row.server_ip)||
    !(Number(row.server_port)>=1&&Number(row.server_port)<=65535)||
    row.in_recovery!==false||
    typeof row.server_started!=='string'||
    !Number.isFinite(Date.parse(row.server_started)))
    blockers.push('REAL_POSTGRES_IDENTITY_NOT_VERIFIED');
  const schemas=Number(row?.industry_schema_count);
  const relations=Number(row?.industry_relation_count);
  const extra=Number(row?.unexpected_relation_count);
  const migrations=Number(row?.migration_count);
  if(phase==='before'){
    if(schemas!==0||relations!==0||extra!==0||migrations!==0)
      blockers.push('TARGET_NOT_EMPTY_DISPOSABLE');
  }else{
    if(schemas!==1||relations<1||extra!==0||
      !Number.isSafeInteger(migrations)||migrations<11)
      blockers.push('RESTORE_MIGRATIONS_OR_SCHEMA_INCOMPLETE');
  }
  return {schema:R37_DR_SCHEMA,phase,valid:blockers.length===0,
    targetDatabase:DB.test(expectedName||'')?expectedName:null,
    blockers:[...new Set(blockers)],
    databaseIntegrityVerified:phase==='after'&&blockers.length===0,
    productionDatabaseTouched:false};
}
export const R37_DB_QUERY=[
  'SELECT current_database()::text AS database_name,',
  'inet_server_addr()::text AS server_ip,',
  'inet_server_port() AS server_port,',
  'pg_is_in_recovery() AS in_recovery,',
  'pg_postmaster_start_time()::text AS server_started,',
  "(SELECT count(*)::int FROM pg_namespace WHERE nspname='industry') AS industry_schema_count,",
  '(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid',
  " WHERE n.nspname='industry' AND c.relkind IN ('r','p','m','v','f')) AS industry_relation_count,",
  '(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid',
  " WHERE n.nspname NOT IN ('industry','pg_catalog','information_schema')",
  " AND n.nspname NOT LIKE 'pg_toast%'",
  " AND n.nspname NOT LIKE 'pg_temp_%'",
  " AND c.relkind IN ('r','p','m','v','f')) AS unexpected_relation_count"
].join(' ');
export async function runR37VerifiedRestore({
  plan,dbUrl,approved=false,inspectDatabase,executeR36Restore,
  clock=()=>new Date()
}={}){
  const allowed=inspectR36DisposableTarget(dbUrl),
    permit=verifyR36RestoreApproval(plan,{now:clock()});
  if(approved!==true||!allowed.safe||!permit.valid||
    allowed.db!==plan?.allowedTargetDb)
    throw Error('No explicit loopback disposable R36 restore approval');
  if(typeof inspectDatabase!=='function'||
    typeof executeR36Restore!=='function')
    throw TypeError('Database introspection and restore functions required');
  const before=evaluateR37DatabaseInspection({
    row:await inspectDatabase({dbUrl,expectedName:allowed.db,phase:'before'}),
    expectedName:allowed.db,phase:'before'});
  if(!before.valid)throw Error('Existing or remote database refused: '+before.blockers.join(','));
  if(!verifyR36RestoreApproval(plan,{now:clock()}).valid)
    throw Error('Restore approval expired after real preflight');
  const performed=await executeR36Restore({
    plan,dbUrl,approved:true,clock
  });
  if(performed?.localDisposableRestoreExecuted!==true||
    performed?.noProductionDatabaseUsed!==true||
    performed?.productionAuthorized!==false||
    !SHA.test(performed?.sha256||''))
    throw Error('R36 restore did not return positive disposable evidence');
  const after=evaluateR37DatabaseInspection({
    row:await inspectDatabase({dbUrl,expectedName:allowed.db,phase:'after'}),
    expectedName:allowed.db,phase:'after'});
  if(!after.valid)throw Error('Local restore validation failed: '+after.blockers.join(','));
  const body={schema:'osmanx.guest.r37.local-restore-verified.v1',
    pilotId:plan.pilotId,sourceTreeSha:plan.sourceTreeSha,
    archiveSha256:plan.archiveSha256,
    boundedOperatorRestoreProofSha:performed.sha256,
    databaseName:allowed.db,
    beforeEmptyVerified:true,afterIndustrySchemaVerified:true,
    afterSchemaMigrationsVerified:true,
    sourceWasLocalDisposableDb:true,
    remoteOffsiteCustodyIndependentlyVerified:false,
    externalRollbackDrillVerified:false,
    twoPersonWitnessed:false,productionAuthorized:false,
    customerGo:false};
  return {...body,sha256:sha(body)};
}
