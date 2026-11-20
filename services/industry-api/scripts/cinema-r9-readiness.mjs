// CINEMA R9: read-only operator gate. No migrations, collection, or API restart.
import {makePool} from '../src/database.mjs';
import {inspectCinemaR8} from './cinema-r8-readiness.mjs';
export async function inspectCinemaR9(pool,env=process.env){
  const prior=await inspectCinemaR8(pool,env);
  const checks={...prior.checks,r9AuditAction:false,r9ContactIndex:false,r9OperatorReviewed:false};
  if(!prior.checks?.r8Schema)
    return {go:false,checks,reason:'Install and verify migration 017 first'};
  const row=await pool.query(
    "SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='industry' AND t.relname='cinema_access_events' AND c.conname='cinema_access_events_action_check'");
  checks.r9AuditAction=row.rowCount===1 &&
    row.rows[0].definition.includes('bulk_export_generated');
  const idx=await pool.query(
    "SELECT 1 FROM pg_indexes WHERE schemaname='industry' AND tablename='cinema_lead_events' AND indexname='cinema_r9_contact_first_event_idx'");
  checks.r9ContactIndex=idx.rowCount===1;
  checks.r9OperatorReviewed=env.CINEMA_R9_OPERATOR_REVIEWED==='true';
  return {go:Boolean(prior.go&&checks.r9AuditAction&&checks.r9ContactIndex&&
    checks.r9OperatorReviewed),checks,
    reason:'Independent operator evidence required; this tool cannot activate public intake.',
    note:'Version and RLS checks are technical. Approvals, timer and controller identity require independent human evidence.'};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  let pool;
  try{
    pool=makePool();
    const status=await inspectCinemaR9(pool);
    console.log(JSON.stringify(status));if(!status.go)process.exitCode=2;
  }catch(e){console.error('CINEMA R9 NO-GO: '+(e.code||'unverified'));process.exitCode=2;}
  finally{if(pool)await pool.end();}
}
