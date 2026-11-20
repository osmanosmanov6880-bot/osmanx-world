// CINEMA R4 -- tenant-bounded, idempotent retention under a transaction advisory lock.
import {withTenant} from './database.mjs';
export async function sweepCinemaRows(db,tenant){
  const lock=await db.query(
    "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
    ['cinema:retention:'+tenant]
  );
  if(lock.rows[0]?.acquired!==true){
    const e=new Error('Retention already running');
    e.statusCode=409;throw e;
  }
  const leads=await db.query(
    "DELETE FROM industry.cinema_leads WHERE tenant_id=$1 AND created_at<now()-interval '90 days'",[tenant]
  );
  // Lead events cascade and are also purged when consented lead records expire.
  const events=await db.query(
    "DELETE FROM industry.cinema_daily_events WHERE tenant_id=$1 AND date_utc<(now() AT TIME ZONE 'UTC')::date-interval '180 days'",[tenant]
  );
  const buckets=await db.query(
    "DELETE FROM industry.cinema_rate_limits WHERE tenant_id=$1 AND bucket_hour<now()-interval '48 hours'",[tenant]
  );
  const access=await db.query(
    "DELETE FROM industry.cinema_access_events WHERE tenant_id=$1 AND created_at<now()-interval '90 days'",[tenant]
  );
  await db.query(
    "DELETE FROM industry.cinema_retention_runs WHERE tenant_id=$1 AND executed_at<now()-interval '180 days'",[tenant]
  );
  // Evidence is inserted in the same transaction. Failed receipts roll back the entire sweep.
  await db.query(
    'INSERT INTO industry.cinema_retention_runs(tenant_id,erased_leads,expired_metrics,expired_rate_buckets,expired_access_receipts) VALUES($1,$2,$3,$4,$5)',
    [tenant,leads.rowCount,events.rowCount,buckets.rowCount,access.rowCount]
  );
  return {erasedLeads:leads.rowCount,expiredMetrics:events.rowCount,expiredRateBuckets:buckets.rowCount,
    expiredAccessReceipts:access.rowCount,retentionRecorded:true,retentionDays:90};
}
export function sweepCinemaTenant(pool,tenant) {
  return withTenant(pool,tenant,db=>sweepCinemaRows(db,tenant));
}
