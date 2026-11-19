/**
 * R29 actual PostgreSQL transaction rollback drill on a disposable synthetic
 * R26/R29 database ONLY. Uses the existing tenant-RLS protected review table.
 * This is NOT a restore of live backup, production rollback or migration down.
 * The sole candidate INSERT is always ROLLBACK-ed, even on assertion failure.
 */
import {createHash,randomBytes} from 'node:crypto';
export const R29_ROLLBACK_SCHEMA='osmanx.guest.r29.disposable-sql-rollback.v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SYNTHETIC_DB=/^industry_r(?:26|29)_[a-f0-9]{12}$/;
const TABLES=Object.freeze([
  'industry.guest_r26_source_reviews',
  'industry.guest_r25_operational_tallies',
  'industry.guest_r19_daily_usage',
  'industry.guest_r19_collection_events',
  'industry.guest_pilot_holds'
]);
function onlySyntheticEnvironment(){
  if(process.env.NODE_ENV!=='test')
    throw Error('R29 rollback is forbidden outside the isolated test process');
  const safe=url=>{
    const parsed=new URL(url||'');
    return parsed.protocol==='postgres:'&&
      parsed.hostname==='127.0.0.1'&&parsed.pathname==='/industry_ci';
  };
  if(!safe(process.env.MIGRATION_DB_URL)||!safe(process.env.DATABASE_URL))
    throw Error('R29 requires loopback industry_ci migration and runtime');
}
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function readSnapshot(client,tenantId,pilotId){
  const counts=[];
  for(const table of TABLES){
    // table names are hardcoded, not user-controlled SQL identifiers.
    const r=await client.query(
      'SELECT count(*)::int AS count FROM '+table+
      ' WHERE tenant_id=$1 AND pilot_id=$2',[tenantId,pilotId]);
    counts.push(r.rows[0].count);
  }
  return {counts,sha256:hash(counts)};
}
export async function rehearseR29DisposableRollback({
  pool,tenantId,pilotId,actorId
}={}){
  onlySyntheticEnvironment();
  if(!UUID.test(tenantId||'')||!UUID.test(pilotId||'')||
     !UUID.test(actorId||'')||!pool||typeof pool.connect!=='function')
    throw new TypeError('Synthetic tenant, pilot and actor UUID required');
  let client,insideVisible=false,rollbackSucceeded=false,before,after;
  try{
    client=await pool.connect();
    const name=(await client.query('SELECT current_database() AS name'))
      .rows[0]?.name;
    if(!SYNTHETIC_DB.test(name||''))
      throw Error('R29 cannot use production or shared CI DB');
    await client.query('BEGIN READ ONLY');
    await client.query(
      "SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    before=await readSnapshot(client,tenantId,pilotId);
    await client.query('ROLLBACK');
    const key='r29-disposable-'+randomBytes(12).toString('hex');
    // Deliberately bound to a non-current synthetic version, never a real
    // verified R26 declaration. Even the successful INSERT is rolled back.
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    const inserted=await client.query(
      'INSERT INTO industry.guest_r26_source_reviews'+
      '(tenant_id,pilot_id,pilot_version,tally_source_sha,'+
      'r24_evidence_sha,tally_rows,actor_id,actor_role,'+
      'method,verdict,evidence_sha,idempotency_key,payload_digest)'+
      ' VALUES($1,$2,100001,$3,$4,1,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
      [tenantId,pilotId,'d'.repeat(64),'e'.repeat(64),actorId,
        'owner','independent_aggregate_recount','rejected',
        'f'.repeat(64),key,'a'.repeat(64)]
    );
    if(inserted.rowCount!==1)throw Error('SQL rollback probe INSERT refused');
    const inside=await readSnapshot(client,tenantId,pilotId);
    insideVisible=inside.counts[0]===before.counts[0]+1&&
      TABLES.slice(1).every((_,i)=>inside.counts[i+1]===before.counts[i+1]);
    if(!insideVisible)throw Error('Probe was not visible in own transaction');
    await client.query('ROLLBACK');
    rollbackSucceeded=true;
    await client.query('BEGIN READ ONLY');
    await client.query(
      "SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    after=await readSnapshot(client,tenantId,pilotId);
    await client.query('ROLLBACK');
    if(before.sha256!==after.sha256)
      throw Error('Disposal database counts changed after rollback');
    return {
      schema:R29_ROLLBACK_SCHEMA,
      targetIsDisposable:true,tenantRlsApplied:true,
      probedExistingAppendOnlyTable:true,
      uncommittedProbeVisible:insideVisible,
      transactionRolledBack:rollbackSucceeded,
      beforeSha:before.sha256,afterSha:after.sha256,
      snapshotsIdentical:true,tableCount:TABLES.length,
      changedRecordsPersisted:0,
      productionDatabaseTouched:false,
      externalOffsiteRestoreVerified:false,
      actualLiveMigrationRollbackVerified:false,
      customerGo:false,productionAuthorized:false
    };
  }catch(error){
    if(client)await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{client?.release();}
}
