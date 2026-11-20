// CINEMA R8: read-only release gate. Does not apply migrations or enable intake.
import {makePool,withTenant} from '../src/database.mjs';
import {inspectCinemaR7} from './cinema-r7-readiness.mjs';
export async function inspectCinemaR8(pool,env=process.env){
  const prior=await inspectCinemaR7(pool,env);
  const checks={...prior.checks,r8ReceiptRls:false,r8Schema:false,r8AuditAction:false,
    r8RecentRetentionObserved:false,r8OperatorReviewed:false,r8ImageDigestPinned:false};
  if(!prior.checks?.r7Index)return {go:false,checks,reason:'R7 prerequisite not installed'};
  const table=await pool.query(
    "SELECT c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='industry' AND c.relname='cinema_retention_runs'"
  );
  checks.r8Schema=table.rowCount===1;
  checks.r8ReceiptRls=checks.r8Schema&&table.rows[0].relrowsecurity===true&&table.rows[0].relforcerowsecurity===true;
  const constraint=await pool.query(
    "SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='industry' AND t.relname='cinema_access_events' AND c.conname='cinema_access_events_action_check'"
  );
  checks.r8AuditAction=constraint.rowCount===1&&constraint.rows[0].definition.includes('bulk_export_authorized');
  if(checks.r8Schema){
    // Publicly safe metadata only: last execution timestamp, no personal data.
    const tenant=env.CINEMA_TENANT_ID;
    if(typeof tenant==='string'&&/^[0-9a-f-]{36}$/i.test(tenant)){
      const x=await withTenant(pool,tenant,db=>db.query(
        "SELECT executed_at FROM industry.cinema_retention_runs WHERE tenant_id=$1 ORDER BY executed_at DESC LIMIT 1",
        [tenant]));
      checks.r8RecentRetentionObserved=x.rowCount>0&&
        (Date.now()-new Date(x.rows[0].executed_at).getTime())<48*3600000;
    }
  }
  checks.r8OperatorReviewed=env.CINEMA_R8_OPERATOR_REVIEWED==='true';
  checks.r8ImageDigestPinned=/^sha256:[0-9a-f]{64}$/.test(env.CINEMA_R8_IMAGE_DIGEST||'');
  return {go:Boolean(prior.go&&checks.r8ReceiptRls&&checks.r8AuditAction&&
      checks.r8RecentRetentionObserved&&checks.r8OperatorReviewed&&checks.r8ImageDigestPinned),
    checks,reason:'Independent human approval, pinned image and tested retention required.',
    note:'Attestation strings and the presence of past runs do not prove future timer operation.'};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  let pool;
  try{
    pool=makePool();
    const result=await inspectCinemaR8(pool);
    console.log(JSON.stringify(result));
    if(!result.go)process.exitCode=2;
  }catch(e){console.error('CINEMA R8 NO-GO: '+(e.code||'readiness_failed'));process.exitCode=2;}
  finally{if(pool)await pool.end();}
}
