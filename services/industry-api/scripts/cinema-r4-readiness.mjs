// CINEMA R4 operator evidence gate. Read-only: never enables public writes.
import {makePool,withTenant} from '../src/database.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUIRED=[
  ['legalControllerApproved','CINEMA_LEGAL_CONTROLLER_APPROVED'],
  ['contactMailboxVerified','CINEMA_MAILBOX_VERIFIED'],
  ['retentionTimerVerified','CINEMA_RETENTION_TIMER_VERIFIED'],
  ['encryptedRestoreVerified','CINEMA_RESTORE_VERIFIED']
];
export function operatorAttestations(env=process.env){
  const checks=Object.fromEntries(REQUIRED.map(([label,key])=>[label,env[key]==='true']));
  return {checks,complete:Object.values(checks).every(Boolean)};
}
export async function inspectCinemaInfrastructure(pool,tenantId) {
  if(!UUID.test(tenantId||''))return {ready:false,reason:'tenant_id missing or invalid'};
  const roles=await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user');
  if(!roles.rowCount || roles.rows[0].rolsuper || roles.rows[0].rolbypassrls)
    return {ready:false,reason:'runtime database role must not bypass RLS'};
  const required=['cinema_leads','cinema_lead_events','cinema_rate_limits','cinema_daily_events'];
  const tables=await pool.query(
    "SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='industry' AND c.relname=ANY($1::text[])",
    [required]
  );
  if(tables.rowCount!==required.length || tables.rows.some(x=>!x.relrowsecurity||!x.relforcerowsecurity))
    return {ready:false,reason:'CINEMA tables require enforced RLS'};
  const columns=await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='industry' AND table_name='cinema_leads' AND column_name=ANY($1::text[])",
    [['campaign_code','next_action_at','next_action_kind','loss_reason_code']]
  );
  if(columns.rowCount!==4)return {ready:false,reason:'migration 013 is not applied'};
  const tenant=await withTenant(pool,tenantId,db=>db.query('SELECT id FROM industry.tenants WHERE id=$1',[tenantId]));
  if(tenant.rowCount!==1)return {ready:false,reason:'configured operator tenant not found'};
  return {ready:true,reason:'schema, role and operator tenant validated'};
}
export async function cinemaGoNoGo(pool,env=process.env){
  const attestation=operatorAttestations(env);
  const infrastructure=await inspectCinemaInfrastructure(pool,env.CINEMA_TENANT_ID);
  const secretOk=(env.CINEMA_RATE_SECRET||'').length>=32;
  return {
    go:infrastructure.ready&&attestation.complete&&secretOk,
    checks:{...attestation.checks,infrastructure:infrastructure.ready,rateSecretConfigured:secretOk},
    reason:infrastructure.reason,
    note:'Manual attestations must be backed by real operator records; this command does not enable public intake.'
  };
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  let pool;
  try{
    pool=makePool();
    const summary=await cinemaGoNoGo(pool);
    console.log(JSON.stringify(summary));
    process.exitCode=summary.go?0:2;
  }catch(e){console.error('CINEMA operator readiness: NO-GO; '+(e.code||'check failed'));process.exitCode=2;}
  finally{if(pool)await pool.end();}
}
