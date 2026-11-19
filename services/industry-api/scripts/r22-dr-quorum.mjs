/**
 * R22 TWO restored copies must independently pass R20 and match per-day
 * R17/R18/R19 checkpoints and aggregate event counts. READ ONLY only.
 * Different off-site archive and AGE recipient fingerprints are required,
 * but metadata alone does not prove physical offsite retention or custody.
 */
import {createHash} from 'node:crypto';
import {verifyR20Restore} from './r20-restore-crosscheck.mjs';

export const DR_SCHEMA='osmanx.guest.r22.two-copy-dr-quorum.v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const NAME=/^industry_dr_[a-z0-9_]{2,40}$/;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique=xs=>[...new Set(xs)];
function invalidMetadata(a,b){
  if(!a||!b||![a,b].every(s=>
    NAME.test(s.database||'')&&SHA.test(s.ciphertextSha||'')&&
    SHA.test(s.recipientPublicKeySha||'')&&SHA.test(s.offsiteReceiptSha||'')))
    return 'missing_copy_identity_or_receipt';
  if(a.database===b.database||a.ciphertextSha===b.ciphertextSha||
     a.recipientPublicKeySha===b.recipientPublicKeySha||
     a.offsiteReceiptSha===b.offsiteReceiptSha)
    return 'copy_provenance_not_independent';
  return null;
}
async function readSnapshot(pool,{tenantId,pilotId}){
  let db,started=false;
  try{
    db=await pool.connect();
    await db.query('BEGIN READ ONLY');started=true;
    const name=(await db.query('SELECT current_database() AS name')).rows[0]?.name;
    if(!NAME.test(name||''))throw Error('Not an isolated DR database');
    const [r17,r18,usage,events]=await Promise.all([
      db.query('SELECT max_revision,max_sequence,checkpoint_sha FROM industry.guest_registry_checkpoint_fence WHERE id=1'),
      db.query('SELECT max_revision,max_sequence,checkpoint_sha,anchor_sha FROM industry.guest_external_anchor_fence WHERE id=1'),
      db.query(
        'SELECT utc_day::text AS day,used_count,max_daily,last_scope_sha'+
        ' FROM industry.guest_r19_daily_usage WHERE tenant_id=$1 AND pilot_id=$2 ORDER BY utc_day ASC',
        [tenantId,pilotId]),
      db.query(
        'SELECT utc_day::text AS day,count(*)::int AS count'+
        ' FROM industry.guest_r19_collection_events'+
        ' WHERE tenant_id=$1 AND pilot_id=$2 GROUP BY utc_day ORDER BY utc_day ASC',
        [tenantId,pilotId])
    ]);
    if(r17.rowCount!==1||r18.rowCount!==1)
      throw Error('Missing checkpoint fences');
    const safeFence=(r,external=false)=>({
      revision:Number(r.max_revision),sequence:Number(r.max_sequence),
      checkpointSha:r.checkpoint_sha,
      ...(external?{anchorSha:r.anchor_sha}:{})
    });
    const checkpoint17=safeFence(r17.rows[0]);
    const checkpoint18=safeFence(r18.rows[0],true);
    if(![checkpoint17.revision,checkpoint17.sequence,
       checkpoint18.revision,checkpoint18.sequence].every(
      n=>Number.isSafeInteger(n)&&n>=0)||
       ![checkpoint17.checkpointSha,checkpoint18.checkpointSha,
         checkpoint18.anchorSha].every(x=>SHA.test(x||''))||
       checkpoint17.revision!==checkpoint18.revision||
       checkpoint17.sequence!==checkpoint18.sequence||
       checkpoint17.checkpointSha!==checkpoint18.checkpointSha)
      throw Error('Checkpoint parity failure');
    const days=usage.rows.map(x=>({
      day:x.day,used:Number(x.used_count),limit:Number(x.max_daily),
      scopeSha:x.last_scope_sha
    }));
    const dailyEvents=events.rows.map(x=>({
      day:x.day,count:Number(x.count)
    }));
    if(days.some(x=>!(/^\d{4}-\d{2}-\d{2}$/.test(x.day))||
      !Number.isSafeInteger(x.used)||x.used<1||x.used>100||
      !Number.isSafeInteger(x.limit)||x.limit<x.used||x.limit>100||
      !SHA.test(x.scopeSha||''))||
      dailyEvents.some(x=>!(/^\d{4}-\d{2}-\d{2}$/.test(x.day))||
        !Number.isSafeInteger(x.count)||x.count<1)||
      days.length!==dailyEvents.length||
      days.some((x,i)=>x.day!==dailyEvents[i].day||x.used!==dailyEvents[i].count))
      throw Error('Daily quota history mismatch');
    const report={checkpoint17,checkpoint18,days,dailyEvents};
    return {database:name,checkpointDigest:digest(report),
      days:days.length,totalSuccessfulOperations:days.reduce((n,x)=>n+x.used,0)};
  }finally{
    if(db){
      if(started)await db.query('ROLLBACK').catch(()=>{});
      db.release();
    }
  }
}
export async function verifyR22DrQuorum({
  a,b,tenantId,pilotId,scope,proofFile,
  firstVerifier=verifyR20Restore,now=new Date(),
  env=process.env
}={}){
  const report={schema:DR_SCHEMA,technicalQuorumReady:false,
    firstPassed:false,secondPassed:false,contentsIdentical:false,
    isolatedDatabasesDistinct:false,custodyMetadataDistinct:false,
    checkpointDigest:null,totalSuccessfulOperations:null,
    blockers:[],twoIndependentOfflineAttestationsVerified:false,
    offsiteWormVerified:false,customerGo:false,productionAuthorized:false,
    productionChanged:false};
  if(!UUID.test(tenantId||'')||!UUID.test(pilotId||'')||
     scope?.valid!==true||scope?.tenantId!==tenantId||
     scope?.pilotId!==pilotId||typeof proofFile!=='string'||
     !(now instanceof Date)||!Number.isFinite(now.getTime())){
    report.blockers.push('invalid_dr_scope');return report;
  }
  const invalid=invalidMetadata(a,b);
  if(invalid){report.blockers.push(invalid);return report;}
  report.custodyMetadataDistinct=true;
  try{
    const [x,y]=await Promise.all([
      firstVerifier({pool:a.pool,proofFile,scope,tenantId,pilotId,env,now}),
      firstVerifier({pool:b.pool,proofFile,scope,tenantId,pilotId,env,now})
    ]);
    report.firstPassed=x?.technicalRestoreReady===true;
    report.secondPassed=y?.technicalRestoreReady===true;
    if(!report.firstPassed)report.blockers.push('first_restore_rejected');
    if(!report.secondPassed)report.blockers.push('second_restore_rejected');
    if(!report.firstPassed||!report.secondPassed)return report;
    const [first,second]=await Promise.all([
      readSnapshot(a.pool,{tenantId,pilotId}),
      readSnapshot(b.pool,{tenantId,pilotId})
    ]);
    report.isolatedDatabasesDistinct=first.database!==second.database&&
      first.database===a.database&&second.database===b.database;
    if(!report.isolatedDatabasesDistinct)report.blockers.push('same_database_or_wrong_target');
    report.contentsIdentical=first.checkpointDigest===second.checkpointDigest;
    if(!report.contentsIdentical)report.blockers.push('restored_copies_differ');
    if(first.days>90||second.days>90)
      report.blockers.push('retention_history_requires_review');
    if(report.blockers.length===0){
      report.checkpointDigest=first.checkpointDigest;
      report.totalSuccessfulOperations=first.totalSuccessfulOperations;
      report.technicalQuorumReady=true;
    }
  }catch{report.blockers.push('read_only_dr_crosscheck_failed');}
  report.blockers=unique(report.blockers);
  return report;
}
