/**
 * R37 operator-only local DB evidence. Never creates/drops databases, never
 * runs on GitHub CI. Credentials remain in operator-owned environment.
 */
import pg from 'pg';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {R35_PIN} from '../src/guest-r36-source.mjs';
import {R36_RESTORE_SCHEMA} from '../src/guest-r36-disposable-restore.mjs';
import {R37_DB_QUERY,runR37VerifiedRestore}
  from '../src/guest-r37-dr-verified.mjs';
import {R38_DB_QUERY} from '../src/guest-r38-dr-safety.mjs';
import {runApprovedR36LocalRestore}
  from './r36-disposable-restore.mjs';
export async function inspectR37LocalPg({dbUrl,phase}){
  const client=new pg.Client({connectionString:dbUrl,
    connectionTimeoutMillis:4000,statement_timeout:5000,
    query_timeout:5000,application_name:'osmanx_r37_local_dr_readonly'});
  try{
    await client.connect();
    const r=await client.query(R38_DB_QUERY);
    if(r.rowCount!==1)throw Error('Unexpected local database metadata count');
    const row=r.rows[0];
    row.migration_count=0;
    row.industry_schema_count=Number(row.industry_relation_count)>0?1:0;
    row.unexpected_relation_count=Number(row.user_relation_count)-Number(row.industry_relation_count);
    if(phase==='after'&&Number(row.industry_schema_count)===1){
      const count=await client.query(
        'SELECT count(*)::int AS count FROM industry.schema_migrations');
      row.migration_count=count.rows[0]?.count;
    }
    return row;
  }finally{await client.end().catch(()=>{});}
}
export async function runApprovedR37LocalRestore({plan,dbUrl,approved=false,
  inspectDatabase=inspectR37LocalPg,
  executeR36Restore=runApprovedR36LocalRestore,clock}={}){
  return runR37VerifiedRestore({plan,dbUrl,approved,
    inspectDatabase,executeR36Restore,
    ...(clock?{clock}:{})});
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==7||
      process.argv[2]!=='--approved-local-restore'||
      process.env.GUEST_R37_DR_ACK!=='RESTORE_DISPOSABLE_LOCAL_ONLY')
      throw Error('Explicit R37 local restore approval and four arguments required');
    const [pilotId,sourceTreeSha,archivePath,archiveSha256]=
      process.argv.slice(3);
    const dbUrl=process.env.DR_RESTORE_DB_URL,
      identityFile=process.env.AGE_IDENTITY_FILE,
      issued=new Date();
    const name=new URL(dbUrl).pathname.slice(1);
    const plan={schema:R36_RESTORE_SCHEMA,pilotId,
      releaseSha:R35_PIN.sha,sourceTreeSha,archivePath,archiveSha256,
      identityFile,allowedTargetDb:name,nonce:randomBytes(16).toString('hex'),
      issuedAt:issued.toISOString(),
      expiresAt:new Date(issued.getTime()+300000).toISOString()};
    const result=await runApprovedR37LocalRestore({
      plan,dbUrl,approved:true});
    process.stdout.write(JSON.stringify(result)+'\n');
    if(result.productionAuthorized!==false)process.exitCode=2;
  }catch(e){
    process.stderr.write('R37 DR NO-GO: '+e.message+'\n');
    process.exitCode=2;
  }
}
