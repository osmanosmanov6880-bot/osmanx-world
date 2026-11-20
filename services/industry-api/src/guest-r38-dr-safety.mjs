/**
 * R38 empty-disposable DB hardening: account for public and extension schemas,
 * identify server/process and detect differences between pre/post inspection.
 */
import {createHash} from 'node:crypto';
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const db=/^industry_dr_r36_[a-z0-9]{6,16}$/;
export const R38_DR_SCHEMA='osmanx.guest.r38.local-db-proof.v1';
export function inspectR38DbState(row,{expectedName,phase='before',
  initialServer}={}){
  const issues=[];
  if(!db.test(expectedName||'')||!['before','after'].includes(phase)||
    row?.database_name!==expectedName||
    !['127.0.0.1','::1'].includes(row?.server_ip)||
    row?.in_recovery!==false||
    !Number.isInteger(Number(row?.server_port))||
    Number(row.server_port)<1||Number(row.server_port)>65535||
    !Number.isFinite(Date.parse(row?.server_started||'')))
    issues.push('DISPOSABLE_SERVER_IDENTITY_INVALID');
  const userRelations=Number(row?.user_relation_count);
  const industry=Number(row?.industry_relation_count);
  const migrations=Number(row?.migration_count);
  if(phase==='before'&&
    (userRelations!==0||industry!==0||migrations!==0))
    issues.push('DATABASE_ALREADY_HAS_USER_TABLES');
  if(phase==='after'&&
    (!(userRelations>=1)||industry<1||migrations<11))
    issues.push('RESTORED_CONTENT_NOT_PRESENT');
  if(initialServer&&(initialServer.database_name!==row?.database_name||
    initialServer.server_ip!==row?.server_ip||
    initialServer.server_port!==row?.server_port||
    initialServer.server_started!==row?.server_started))
    issues.push('SERVER_CHANGED_DURING_RESTORE');
  return {schema:R38_DR_SCHEMA,phase,valid:issues.length===0,
    blockers:[...new Set(issues)],serverMarker:row?.server_started||null,
    localDbName:db.test(expectedName||'')?expectedName:null,
    productionAuthorized:false,customerGo:false};
}
// Count all non-system user relations including those in public.
// pg_extension catalog relations are not in public except third-party
// extension objects; extension-owned tables are accounted conservatively.
export const R38_DB_QUERY=[
  'SELECT current_database()::text AS database_name,',
  'inet_server_addr()::text AS server_ip,',
  'inet_server_port() AS server_port,',
  'pg_is_in_recovery() AS in_recovery,',
  'pg_postmaster_start_time()::text AS server_started,',
  "(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%' AND c.relkind IN ('r','p','m','v','f')) AS user_relation_count,",
  "(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='industry' AND c.relkind IN ('r','p','m','v','f')) AS industry_relation_count"
].join(' ');
export function proofR38Restore({before,after,operatorResult}={}){
  if(!before?.valid||!after?.valid||
    operatorResult?.productionAuthorized!==false||
    operatorResult?.localDisposableRestoreExecuted!==true||
    typeof operatorResult?.sha256!=='string'||
    !/^[a-f0-9]{64}$/.test(operatorResult.sha256))
    throw Error('Real local restore evidence missing');
  const body={schema:'osmanx.guest.r38.local-restore-proof.v1',
    archiveProofSha:operatorResult.sha256,localDbVerified:true,
    publicAndIndustryChecked:true,realOffsiteWitness:false,
    productionRollbackVerified:false,productionAuthorized:false,
    customerGo:false};
  return {...body,sha256:sha(body)};
}
