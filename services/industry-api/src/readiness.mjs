// R7: an API is ready only with all migrations, FORCE RLS and least privilege.
// This module is read-only and never returns credentials or private data.
export const REQUIRED_MIGRATIONS=Object.freeze([
  '004_guest_intelligence.sql',
  '005_guest_evidence_archive.sql',
  '006_guest_readiness_permissions.sql',
  '007_guest_protocol_governance.sql'
]);
export const GUARDED_TABLES=Object.freeze([
  'guest_requests','guest_pilots','guest_observations','guest_reviews','guest_quotas'
]);
function unavailable(){
  const e=new Error('Сервер ещё не готов к безопасной работе');
  e.statusCode=503;
  return e;
}
export function assertGuestDatabaseState(row){
  if(!row || Number(row.migration_count)!==REQUIRED_MIGRATIONS.length ||
     Number(row.table_count)!==GUARDED_TABLES.length ||
     row.forced_rls!==true || row.privileged_role!==false ||
     row.can_read_guests!==true || row.can_modify_migrations!==false)
    throw unavailable();
  return {schemaVersion:'007_guest_protocol_governance.sql',
    leastPrivilege:true,forcedRls:true};
}
export async function probeGuestDatabase(pool){
  const sql=[
    'WITH migrations AS (',
    ' SELECT count(*)::int AS applied FROM industry.schema_migrations WHERE name=ANY($1::text[])',
    '), guarded AS (',
    ' SELECT count(*)::int AS present,',
    ' COALESCE(bool_and(c.relrowsecurity AND c.relforcerowsecurity),false) AS forced',
    ' FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace',
    " WHERE n.nspname='industry' AND c.relname=ANY($2::text[]) AND c.relkind='r'",
    ')',
    'SELECT (SELECT applied FROM migrations) AS migration_count,',
    ' (SELECT present FROM guarded) AS table_count,',
    ' (SELECT forced FROM guarded) AS forced_rls,',
    ' COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user),true) AS privileged_role,',
    " (has_table_privilege(current_user,'industry.guest_pilots','SELECT') AND",
    " has_table_privilege(current_user,'industry.guest_observations','SELECT') AND",
    " has_table_privilege(current_user,'industry.guest_reviews','SELECT') AND
    has_table_privilege(current_user,'industry.guest_quotas','SELECT')) AS can_read_guests,",
    " has_table_privilege(current_user,'industry.schema_migrations','UPDATE') AS can_modify_migrations"
  ].join('\n');
  try{
    const res=await pool.query(sql,[REQUIRED_MIGRATIONS,GUARDED_TABLES]);
    return assertGuestDatabaseState(res.rows[0]);
  }catch(error){
    if(error.statusCode===503)throw error;
    // Avoid propagating SQL, credentials, role names or connection internals.
    throw unavailable();
  }
}
