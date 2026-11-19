/**
 * R21 PostgreSQL security audit, SELECT ONLY inside caller's tenant-bound
 * transaction. This reports access control and data-retention drift; it
 * NEVER deletes customer data, migrates, edits RLS, or re-enables writes.
 */
export const AUDIT_SCHEMA='osmanx.guest.r21.database-posture.v1';
const REQUIRED_MIGRATIONS=[
  '011_guest_pilot_safety.sql',
  '012_guest_registry_checkpoint_fence.sql',
  '013_guest_external_anchor_fence.sql',
  '014_guest_single_pilot_rollout.sql'
];
const GUARDED_TABLES=[
  'guest_registry_checkpoint_fence',
  'guest_external_anchor_fence',
  'guest_external_anchor_receipts',
  'guest_r19_daily_usage',
  'guest_r19_collection_events'
];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function report(){
  return {schema:AUDIT_SCHEMA,
    checks:{allMigrationsPresent:false,allSecurityTablesForcedRls:false,
      runtimeRoleUnprivileged:false,immutableHistoryNotWritable:false,
      dailyBudgetDoesNotAllowDelete:false,checkpointsConsistent:false,
      auditMatchesQuota:false,noOverRetentionDrift:false},
    retainedDays:0,usageRows:0,auditEventCount:0,activeQuota:null,
    blockers:[],technicalPostureReady:false,queriesReadOnly:true,
    legalGo:false,productionAuthorized:false,customerGo:false,
    productionChanged:false};
}
export async function auditR21Database(db,{tenantId,pilotId,retentionDays=30}={}){
  const out=report();
  if(!UUID.test(tenantId||'')||!UUID.test(pilotId||'')||
    !Number.isSafeInteger(retentionDays)||retentionDays<1||
    retentionDays>90){
    out.blockers.push('invalid_audit_target');return out;
  }
  try{
    const migration=await db.query(
      'SELECT name FROM industry.schema_migrations WHERE name=ANY($1::text[])',
      [REQUIRED_MIGRATIONS]
    );
    const migrations=new Set(migration.rows.map(r=>r.name));
    out.checks.allMigrationsPresent=REQUIRED_MIGRATIONS.every(n=>migrations.has(n));
    const tables=await db.query(
      "SELECT c.relname,c.relrowsecurity AS rls,c.relforcerowsecurity AS forced"+
      " FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace"+
      " WHERE n.nspname='industry' AND c.relname=ANY($1::text[]) AND c.relkind='r'",
      [GUARDED_TABLES]
    );
    out.checks.allSecurityTablesForcedRls=GUARDED_TABLES.every(n=>
      tables.rows.some(t=>t.relname===n&&t.rls===true&&t.forced===true));
    const rights=await db.query(
      "SELECT COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles"+
      " WHERE rolname=current_user),true) AS privileged,"+
      " has_table_privilege(current_user,'industry.guest_external_anchor_receipts','UPDATE') AS history_update,"+
      " has_table_privilege(current_user,'industry.guest_external_anchor_receipts','DELETE') AS history_delete,"+
      " has_table_privilege(current_user,'industry.guest_r19_collection_events','UPDATE') AS audit_update,"+
      " has_table_privilege(current_user,'industry.guest_r19_collection_events','DELETE') AS audit_delete,"+
      " has_table_privilege(current_user,'industry.guest_r19_daily_usage','DELETE') AS quota_delete"
    );
    const right=rights.rows[0];
    out.checks.runtimeRoleUnprivileged=rights.rowCount===1&&right.privileged===false;
    out.checks.immutableHistoryNotWritable=rights.rowCount===1&&
      right.history_update===false&&right.history_delete===false&&
      right.audit_update===false&&right.audit_delete===false;
    out.checks.dailyBudgetDoesNotAllowDelete=right?.quota_delete===false;
    const fence=await db.query(
      'SELECT '+
      ' (SELECT max_sequence FROM industry.guest_registry_checkpoint_fence WHERE id=1) AS r17,'+
      ' (SELECT max_sequence FROM industry.guest_external_anchor_fence WHERE id=1) AS r18'
    );
    const r17=Number(fence.rows[0]?.r17),r18=Number(fence.rows[0]?.r18);
    out.checks.checkpointsConsistent=Number.isSafeInteger(r17)&&r17>=0&&
      Number.isSafeInteger(r18)&&r18>=0&&r17===r18;
    const daily=await db.query(
      "SELECT used_count,max_daily FROM industry.guest_r19_daily_usage"+
      " WHERE tenant_id=$1 AND pilot_id=$2 AND utc_day=(now() AT TIME ZONE 'UTC')::date",
      [tenantId,pilotId]
    );
    const history=await db.query(
      "SELECT count(*)::int AS total FROM industry.guest_r19_collection_events"+
      " WHERE tenant_id=$1 AND pilot_id=$2 AND utc_day=(now() AT TIME ZONE 'UTC')::date",
      [tenantId,pilotId]
    );
    const today=Number(daily.rows[0]?.used_count??0);
    const count=Number(history.rows[0]?.total);
    const ceiling=Number(daily.rows[0]?.max_daily??0);
    out.activeQuota=ceiling||null;
    out.auditEventCount=count;
    out.checks.auditMatchesQuota=Number.isSafeInteger(today)&&today>=0&&
      Number.isSafeInteger(count)&&count>=0&&today===count&&
      (daily.rowCount===0||Number.isSafeInteger(ceiling)&&
       ceiling>=today&&ceiling<=100);
    const retained=await db.query(
      "SELECT count(*)::int AS n,"+
      " count(*) FILTER (WHERE utc_day < (now() AT TIME ZONE 'UTC')::date-$3::int)::int AS overdue"+
      " FROM industry.guest_r19_daily_usage WHERE tenant_id=$1 AND pilot_id=$2",
      [tenantId,pilotId,retentionDays]
    );
    out.usageRows=Number(retained.rows[0]?.n??0);
    out.retainedDays=retentionDays;
    out.checks.noOverRetentionDrift=retained.rowCount===1&&
      Number(retained.rows[0].overdue)===0;
  }catch{
    out.blockers.push('database_metadata_or_read_permission_unavailable');
  }
  for(const [check,valid] of Object.entries(out.checks))
    if(valid!==true)out.blockers.push('failed_'+check);
  out.blockers=[...new Set(out.blockers)];
  out.technicalPostureReady=out.blockers.length===0;
  return out;
}
