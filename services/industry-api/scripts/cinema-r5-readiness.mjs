// R5 independent read-only GO / NO-GO: never applies migrations or enables public intake.
import {makePool,withTenant} from '../src/database.mjs';
import {cinemaGoNoGo} from './cinema-r4-readiness.mjs';

const required=['assigned_to','contact_count','first_contact_at','last_contact_at'];
export async function inspectCinemaR5(pool,env=process.env){
  const previous=await cinemaGoNoGo(pool,env);
  if(!previous.checks.infrastructure){
    return {go:false,checks:{...previous.checks,r5Schema:false,r5Staff:false,r5Review:false},
      reason:previous.reason,note:'No configuration changes performed.'};
  }
  const columns=await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='industry' AND table_name='cinema_leads' AND column_name=ANY($1::text[])",
    [required]);
  const r5Schema=columns.rowCount===required.length;
  const roles=await withTenant(pool,env.CINEMA_TENANT_ID,db=>db.query(
    "SELECT count(*)::int AS n FROM industry.memberships m JOIN industry.accounts a ON a.id=m.account_id WHERE m.tenant_id=$1 AND m.role IN ('owner','manager') AND NOT a.disabled",
    [env.CINEMA_TENANT_ID]
  ));
  const r5Staff=Number(roles.rows[0]?.n||0)>0;
  const r5Review=env.CINEMA_R5_OPERATOR_REVIEWED==='true';
  return {go:previous.go&&r5Schema&&r5Staff&&r5Review,
    checks:{...previous.checks,r5Schema,r5Staff,r5Review},
    reason:r5Schema?'R5 schema present':'R5 migration 014 is missing',
    note:'Approval flags are human attestations, not independent evidence. No public writes or timers have been enabled.'};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  const pool=makePool();
  try{
    const result=await inspectCinemaR5(pool);
    console.log(JSON.stringify(result));
    if(!result.go)process.exitCode=2;
  }catch(e){
    console.error('CINEMA R5 NO-GO: verification failed ('+(e.code||'unknown')+')');
    process.exitCode=2;
  }finally{await pool.end();}
}
