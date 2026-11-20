/**
 * R39 direct-restore last line of defense. This function is used even when
 * an operator bypasses the R36/R37 convenience wrappers and runs sh restore-dr.
 * No database mutation; returns no DB URL, credential or file contents.
 */
export const R39_DR_SCHEMA='osmanx.guest.r39.direct-dr-local-only.v1';
const DB=/^industry_dr_[a-z0-9_]{6,48}$/;
const HOSTS=new Set(['127.0.0.1','::1','localhost']);
// Server-side inet_server_addr() reports a Docker bridge IP when the client
// connects through the local host's 127.0.0.1 published port. Accept only
// loopback/RFC1918 here; URL routing must ALSO be loopback. This is not
// independent physical-host attestation.
const safeBackendIp=ip=>typeof ip==='string'&&(
  ip==='::1'||/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(ip)||
  /^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(ip)||
  /^192\.168\.(?:\d{1,3}\.)\d{1,3}$/.test(ip)||
  /^172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}$/.test(ip)
);
const HEX40=/^[a-f0-9]{40}$/;
export function checkR39TargetUrl(url){
  const problems=[];let dbName=null,host=null;
  try{
    const p=new URL(url);
    dbName=decodeURIComponent(p.pathname.slice(1));
    host=p.hostname.replace(/^\[|\]$/g,'').toLowerCase();
    if(!['postgresql:','postgres:'].includes(p.protocol)||
      !HOSTS.has(host)||!(p.port===''||p.port==='5432')||
      p.search!==''||p.hash!==''||p.username.length===0||
      !DB.test(dbName)||dbName==='industry_dr_production'||
      /(^|_)(prod|production|live|main)(_|$)/.test(dbName))
      problems.push('TARGET_NOT_LOCAL_DISPOSABLE');
  }catch{problems.push('INVALID_CONNECTION_URL')}
  return {schema:R39_DR_SCHEMA,valid:problems.length===0,
    allowedDb:problems.length===0?dbName:null,
    localHost:problems.length===0?host:null,
    failures:problems,productionAuthorized:false};
}
export function checkR39TargetSnapshot(snapshot,{expectedDb}={}){
  const problems=[];
  if(!snapshot||!DB.test(expectedDb||'')||
    snapshot.database_name!==expectedDb)
    problems.push('WRONG_DISPOSABLE_DATABASE');
  const reportedIp=typeof snapshot?.server_ip==='string'?
    snapshot.server_ip.replace(/^::ffff:/i,''):null;
  if(!safeBackendIp(reportedIp))
    problems.push('NON_PRIVATE_BACKEND_ADDRESS');
  if(Number(snapshot?.server_port)!==5432)
    problems.push('UNEXPECTED_SERVER_PORT');
  if(snapshot?.in_recovery!==false)
    problems.push('POSTGRES_STANDBY_NOT_ALLOWED');
  if(typeof snapshot?.server_started!=='string'||
    !Number.isFinite(Date.parse(snapshot.server_started)))
    problems.push('UNVERIFIED_POSTGRES_START_TIME');
  if(snapshot?.non_system_relations!==0||
    !Number.isSafeInteger(snapshot?.non_system_relations))
    problems.push('NONEMPTY_USER_SCHEMAS');
  if(snapshot?.other_connections!==0||
    !Number.isSafeInteger(snapshot?.other_connections))
    problems.push('UNEXPECTED_DATABASE_CONNECTIONS');
  return {valid:problems.length===0,failures:problems,
    dbName:problems.length===0?expectedDb:null,
    sourceObservedReadOnly:true,productionAuthorized:false};
}
// Counts non-system tables, materialized views, partition tables and sequences
// in public, industry or any other non-system schema. Extension objects count
// conservatively: a preexisting populated DB must not be overwritten.
export const R39_EMPTY_SQL=[
  'SELECT current_database()::text AS database_name,',
  'inet_server_addr()::text AS server_ip,',
  'inet_server_port() AS server_port,',
  'pg_is_in_recovery() AS in_recovery,',
  'pg_postmaster_start_time()::text AS server_started,',
  "(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid",
  " WHERE n.nspname NOT IN ('pg_catalog','information_schema')",
  " AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'",
  " AND c.relkind IN ('r','p','m','v','f','S')) AS non_system_relations,",
  '(SELECT count(*)::int FROM pg_stat_activity',
  " WHERE datname=current_database() AND pid<>pg_backend_pid()) AS other_connections"
].join(' ');
