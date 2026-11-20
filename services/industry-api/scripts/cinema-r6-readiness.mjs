// CINEMA R6: read-only schema/privilege/operations gate. Never toggles live flags.
import {makePool} from '../src/database.mjs';
import {inspectCinemaR5} from './cinema-r5-readiness.mjs';
export async function inspectCinemaR6(pool,env=process.env){
  const previous=await inspectCinemaR5(pool,env);
  const checks={...previous.checks,r6Schema:false,r6AuditRls:false,r6ContactUnique:false,r6OperatorReviewed:false};
  if(!previous.checks?.r5Schema)
    return {go:false,checks,reason:'R5 schema is required before R6; operator action needed'};
  const columns=await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='industry' AND table_name='cinema_lead_events' AND column_name=ANY($1::text[])",
    [['contact_request_key','contact_request_digest']]
  );
  checks.r6Schema=columns.rowCount===2;
  const rls=await pool.query(
    "SELECT c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='industry' AND c.relname='cinema_access_events'"
  );
  checks.r6AuditRls=rls.rowCount===1&&rls.rows[0].relrowsecurity&&rls.rows[0].relforcerowsecurity;
  const index=await pool.query(
    "SELECT 1 FROM pg_indexes WHERE schemaname='industry' AND tablename='cinema_lead_events' AND indexname='cinema_r6_contact_idempotency_idx'"
  );
  checks.r6ContactUnique=index.rowCount===1;
  checks.r6OperatorReviewed=env.CINEMA_R6_OPERATOR_REVIEWED==='true';
  return {go:previous.go&&checks.r6Schema&&checks.r6AuditRls&&checks.r6ContactUnique&&checks.r6OperatorReviewed,
    checks,note:'Human attestations require independent evidence. This CLI only reads state; it cannot deploy the API, enable intake or schedule tasks.'};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  const pool=makePool();
  try{
    const status=await inspectCinemaR6(pool);
    console.log(JSON.stringify(status));
    if(!status.go)process.exitCode=2;
  }catch(e){console.error('CINEMA R6 NO-GO ('+(e.code||'verification_failed')+')');process.exitCode=2;}
  finally{await pool.end();}
}
