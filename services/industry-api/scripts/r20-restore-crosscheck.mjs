/**
 * R20 recovery cross-check. NEVER executes restore, DDL, UPDATE or DELETE.
 * It examines an already restored, separately named DR database through a
 * READ ONLY transaction and independently reconciles R18/R19 evidence.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {verifyProofFile} from './r18-proof.mjs';
import {rehearseRecovery} from './r18-dr-rehearsal.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA=/^[0-9a-f]{64}$/;
const isoDay=/^\d{4}-\d{2}-\d{2}$/;
const DR=/^industry_dr_[a-z0-9_]{2,40}$/;
const unique=(xs)=>[...new Set(xs)];
const fail=(x,reason)=>{x.blockers.push(reason);};
export async function verifyR20Restore({
  pool,proofFile,scope,tenantId,pilotId,env=process.env,
  now=new Date(),proofVerifier=verifyProofFile,baseVerifier=rehearseRecovery
}={}){
  const out={schema:'osmanx.guest.r20.restore-crosscheck.v1',
    evidenceValid:false,r18RestoreMatched:false,isolatedDrDatabase:false,
    migration014Ready:false,scopeMatchesEvidence:false,
    protocolMatches:false,r19QuotaLedgerConsistent:false,
    r19AuditConsistent:false,retentionReviewPassed:false,
    technicalRestoreReady:false,offsiteWormVerified:false,
    customerGo:false,legalGo:false,productionChanged:false,blockers:[]};
  if(!pool||!UUID.test(tenantId||'')||!UUID.test(pilotId||'')||
    !(now instanceof Date)||!Number.isFinite(now.getTime())||
    typeof proofFile!=='string'){
    fail(out,'missing_isolated_db_or_ids');return out;
  }
  let proof;
  try{
    proof=await proofVerifier(proofFile,env,now);
    out.evidenceValid=proof?.valid===true&&SHA.test(proof?.anchorDigest||'')&&
      SHA.test(proof?.checkpointDigest||'');
    if(!out.evidenceValid){fail(out,'invalid_r18_portable_proof');return out;}
  }catch{fail(out,'invalid_r18_portable_proof');return out;}
  try{
    const base=await baseVerifier({pool,proofFile,env,now,
      proofVerifier:async()=>proof});
    out.r18RestoreMatched=base?.technicalRestoreReady===true;
    if(!out.r18RestoreMatched)fail(out,'r18_restore_does_not_match');
  }catch{fail(out,'r18_restore_does_not_match');}
  const expectedScope=scope;
  out.scopeMatchesEvidence=!!expectedScope&&expectedScope.valid===true&&
    expectedScope.tenantId===tenantId&&expectedScope.pilotId===pilotId&&
    expectedScope.record?.checkpointDigest===proof.checkpointDigest&&
    expectedScope.record?.journalSequence===proof.sequence&&
    SHA.test(expectedScope.scopeDigest||'');
  if(!out.scopeMatchesEvidence)fail(out,'scope_not_bound_to_restored_evidence');
  let client;
  try{
    client=await pool.connect();
    await client.query('BEGIN READ ONLY');
    const db=(await client.query('SELECT current_database() AS name')).rows[0]?.name;
    out.isolatedDrDatabase=DR.test(db||'');
    if(!out.isolatedDrDatabase){fail(out,'db_not_dr_isolated');return out;}
    const migration=await client.query(
      "SELECT count(*)::int AS n FROM industry.schema_migrations WHERE name='014_guest_single_pilot_rollout.sql'"
    );
    out.migration014Ready=Number(migration.rows[0]?.n)===1;
    if(!out.migration014Ready){fail(out,'migration_014_missing');return out;}
    const pilot=await client.query(
      'SELECT tenant_id,id,protocol,protocol_registered_at FROM industry.guest_pilots WHERE tenant_id=$1 AND id=$2',
      [tenantId,pilotId]
    );
    if(pilot.rowCount!==1){fail(out,'restored_pilot_missing');return out;}
    if(expectedScope?.record?.protocolDigest){
      try{
        const {protocolDigest}=await import('../src/guest-r19-scope.mjs');
        out.protocolMatches=protocolDigest(pilot.rows[0])===
          expectedScope.record.protocolDigest;
      }catch{out.protocolMatches=false;}
    }
    if(!out.protocolMatches)fail(out,'restored_protocol_mismatch');
    // Totals must exactly match successful commit-only audit entries for
    // each UTC day. No raw guest identities or observations are exported.
    const usage=await client.query(
      'SELECT utc_day::text AS day,used_count,max_daily,last_scope_sha FROM industry.guest_r19_daily_usage WHERE tenant_id=$1 AND pilot_id=$2 ORDER BY utc_day DESC LIMIT 92',
      [tenantId,pilotId]
    );
    const events=await client.query(
      'SELECT utc_day::text AS day,count(*)::int AS n FROM industry.guest_r19_collection_events WHERE tenant_id=$1 AND pilot_id=$2 GROUP BY utc_day ORDER BY utc_day DESC LIMIT 92',
      [tenantId,pilotId]
    );
    const dayCounts=new Map(events.rows.map(x=>[x.day,Number(x.n)]));
    const days=new Set(usage.rows.map(x=>x.day));
    out.r19QuotaLedgerConsistent=usage.rows.length<92&&events.rows.length<92&&
      usage.rows.every(r=>isoDay.test(r.day)&&
        Number.isInteger(Number(r.used_count))&&
        Number(r.used_count)>=1&&Number(r.used_count)<=100&&
        Number(r.max_daily)>=Number(r.used_count)&&
        Number(r.max_daily)<=100&&SHA.test(r.last_scope_sha||''))&&
      events.rows.every(r=>days.has(r.day));
    out.r19AuditConsistent=out.r19QuotaLedgerConsistent&&
      usage.rows.every(r=>dayCounts.get(r.day)===Number(r.used_count));
    if(!out.r19QuotaLedgerConsistent)fail(out,'quota_ledger_invalid_or_truncated');
    if(!out.r19AuditConsistent)fail(out,'audit_event_count_mismatch');
    const retention=expectedScope?.record?.policy?.retentionDays;
    out.retentionReviewPassed=Number.isSafeInteger(retention)&&retention>=1&&retention<=90&&
      usage.rows.every(x=>{
        const timestamp=Date.parse(x.day+'T00:00:00.000Z');
        return Number.isFinite(timestamp)&&
          timestamp<=now.getTime()&&
          (now.getTime()-timestamp)<(retention+1)*86400000;
      });
    if(!out.retentionReviewPassed)fail(out,'retention_or_day_window_requires_review');
  }catch{fail(out,'dr_read_only_inspection_failed');}
  finally{
    if(client){
      await client.query('ROLLBACK').catch(()=>{});
      client.release();
    }
  }
  out.blockers=unique(out.blockers);
  out.technicalRestoreReady=out.blockers.length===0;
  return out;
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  let pool;
  try{
    const [proofFile,tenantId,pilotId,...extra]=process.argv.slice(2);
    if(extra.length||!proofFile||!tenantId||!pilotId)
      throw Error('Usage: /private/proof.json TENANT_UUID PILOT_UUID');
    const target=new URL(process.env.DR_RESTORE_DB_URL||'');
    if(target.hostname!=='127.0.0.1'&&!['localhost','::1'].includes(target.hostname))
      throw Error('DR host must be local to the approved recovery station');
    if(!DR.test(target.pathname.slice(1)))throw Error('Not an isolated industry_dr_* database');
    const {loadR19Scope}=await import('../src/guest-r19-scope.mjs');
    const scope=await loadR19Scope();
    pool=new pg.Pool({connectionString:process.env.DR_RESTORE_DB_URL,max:2});
    const report=await verifyR20Restore({pool,proofFile,tenantId,pilotId,scope});
    process.stdout.write(JSON.stringify(report)+'\n');
    if(!report.technicalRestoreReady)process.exitCode=2;
  }catch{
    process.stderr.write('R20 recovery cross-check refused; no DB or production changes performed.\n');
    process.exitCode=2;
  }finally{if(pool)await pool.end();}
}
