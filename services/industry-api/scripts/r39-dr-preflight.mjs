/**
 * Read-only PostgreSQL preflight of an existing, explicitly local disposable
 * restore target. Invoked by restore-dr.sh itself on every entry path.
 * No use of production database, no mutations and no secrets in output.
 */
import pg from 'pg';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkR39TargetUrl,checkR39TargetSnapshot,R39_EMPTY_SQL}
  from '../src/guest-r39-dr-guard.mjs';
export async function preflightR39RestoreTarget({
  url=process.env.DR_RESTORE_DB_URL,
  clientFactory=(opts)=>new pg.Client(opts)
}={}){
  const parsed=checkR39TargetUrl(url);
  if(!parsed.valid)throw Error('R39 refused non-disposable or nonlocal PostgreSQL');
  const client=clientFactory({connectionString:url,
    connectionTimeoutMillis:4000,query_timeout:5000,
    statement_timeout:5000,
    application_name:'osmanx_r39_disposable_preflight'});
  try{
    await client.connect();
    const result=await client.query(R39_EMPTY_SQL);
    if(result.rowCount!==1)throw Error('R39 local DB probe returned unexpected rows');
    const safety=checkR39TargetSnapshot(result.rows[0],{
      expectedDb:parsed.allowedDb});
    if(!safety.valid)throw Error('R39_PREFLIGHT:'+safety.failures.join(','));
    return {schema:'osmanx.guest.r39.readonly-preflight.v1',
      targetDatabase:parsed.allowedDb,localHostValidated:true,
      emptyDatabaseVerified:true,networkMutations:0,
      customerGo:false,productionAuthorized:false};
  }finally{await client.end().catch(()=>{});}
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==2)throw Error('No arguments accepted; use operator env only');
    const result=await preflightR39RestoreTarget();
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(error){
    // Only whitelist internal reason codes. Never print SQL, URLs, passwords
    // or arbitrary PostgreSQL exception messages.
    const reason=typeof error?.message==='string'&&
      error.message.startsWith('R39_PREFLIGHT:')?
      error.message.slice('R39_PREFLIGHT:'.length).replace(/[^A-Z0-9_,]/g,''):
      /^[0-9A-Z]{5}$/.test(error?.code||'')?
        'POSTGRES_'+error.code:'DATABASE_PREFLIGHT_FAILED';
    process.stderr.write('R39 disposable restore preflight: NO-GO '+reason+'\n');
    process.exitCode=2;
  }
}
