/**
 * Operator-only, read-only PostgreSQL audit. No remote DB URLs, no migrations,
 * no data exports. Run from an approved VPS loopback or isolated DB station.
 */
import pg from 'pg';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditR21Database} from '../src/guest-r21-db-audit.mjs';

export async function runR21DatabaseAudit({pool,tenantId,pilotId,
  retentionDays=30}={}){
  const blocked={schema:'osmanx.guest.r21.database-posture.v1',
    technicalPostureReady:false,queriesReadOnly:true,
    blockers:['no_read_only_connection'],productionAuthorized:false,
    customerGo:false,productionChanged:false};
  if(!pool)return blocked;
  let client;
  try{
    client=await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    return await auditR21Database(client,{tenantId,pilotId,retentionDays});
  }catch{return blocked;}
  finally{
    if(client){await client.query('ROLLBACK').catch(()=>{});client.release();}
  }
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  let pool;
  try{
    const [flagA,tenantId,flagB,pilotId,flagC,retention,...extra]=process.argv.slice(2);
    if(flagA!=='--tenant'||flagB!=='--pilot'||flagC!=='--retention-days'||
       extra.length||!/^[1-9]\d{0,1}$/.test(retention||''))
      throw Error('Usage: --tenant UUID --pilot UUID --retention-days 1..90');
    const connection=process.env.R21_AUDIT_DB_URL;
    if(!connection)throw Error('Missing separate read-only DB URL');
    const url=new URL(connection);
    if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||
       !['postgresql:','postgres:'].includes(url.protocol))
      throw Error('R21 only audits a loopback PostgreSQL instance');
    pool=new pg.Pool({connectionString:connection,max:1,
      application_name:'osmanx_r21_read_only_audit'});
    const report=await runR21DatabaseAudit({
      pool,tenantId,pilotId,retentionDays:Number(retention)});
    process.stdout.write(JSON.stringify(report)+'\n');
    if(!report.technicalPostureReady)process.exitCode=2;
  }catch{
    process.stdout.write(JSON.stringify({
      schema:'osmanx.guest.r21.database-posture.v1',
      technicalPostureReady:false,queriesReadOnly:true,
      blockers:['database_audit_connection_or_policy_unavailable'],
      productionAuthorized:false,customerGo:false,
      productionChanged:false
    })+'\n');process.exitCode=2;
  }finally{if(pool)await pool.end();}
}
