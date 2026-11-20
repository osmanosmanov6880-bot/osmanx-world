// CINEMA R7 - repeatable, read-only operator release gate.
import {makePool} from '../src/database.mjs';
import {inspectCinemaR6} from './cinema-r6-readiness.mjs';
export async function inspectCinemaR7(pool,env=process.env){
  const earlier=await inspectCinemaR6(pool,env);
  const checks={...earlier.checks,r7Index:false,r7OperatorReviewed:false,
    publicIntakeOff:false,aggregateActionsOff:false};
  if(!earlier.checks?.r6Schema)
    return {go:false,checks,reason:'Migration 015 prerequisite is missing'};
  const idx=await pool.query(
    "SELECT 1 FROM pg_indexes WHERE schemaname='industry' AND tablename='cinema_leads' AND indexname='cinema_r7_tenant_email_lookup_idx'"
  );
  checks.r7Index=idx.rowCount===1;
  checks.r7OperatorReviewed=env.CINEMA_R7_OPERATOR_REVIEWED==='true';
  checks.publicIntakeOff=env.CINEMA_PUBLIC_WRITE_ENABLED!=='true';
  checks.aggregateActionsOff=env.CINEMA_AGGREGATE_EVENTS_ENABLED!=='true';
  return {go:Boolean(earlier.go&&checks.r7Index&&checks.r7OperatorReviewed&&
    checks.publicIntakeOff&&checks.aggregateActionsOff),
    checks,reason:'Manual approvals and independent staging evidence are required. No automatic production activation.',
    checksAreOperatorAttestations:true};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  let pool;
  try{
    pool=makePool();
    const result=await inspectCinemaR7(pool);
    console.log(JSON.stringify(result));
    if(!result.go)process.exitCode=2;
  }catch(e){
    console.error('CINEMA R7 NO-GO: '+(e.code||'readiness_check_failed'));
    process.exitCode=2;
  }finally{if(pool)await pool.end();}
}
