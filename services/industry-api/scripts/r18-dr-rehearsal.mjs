/**
 * Independent R18 disaster-recovery drill. READ-ONLY against an ALREADY
 * RESTORED industry_dr_* database; this script never restores/drops DB.
 * A green application health check is not evidence of consistent recovery.
 */
import pg from 'pg';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyProofFile} from './r18-proof.mjs';

export async function rehearseRecovery({
  proofFile,env=process.env,now=new Date(),pool=null,proofVerifier=verifyProofFile
}={}){
  const blockers=[];
  const report={
    schema:'osmanx.guest.r18.recovery-rehearsal.v1',
    proofValid:false,drDatabaseIsolated:false,migration013Ready:false,
    r17CheckpointMatched:false,r18AnchorMatched:false,
    appendOnlyReceiptMatched:false,technicalRestoreReady:false,
    legalGo:false,customerGo:false,productionChanged:false,
    offsiteRetentionVerified:false,blockers
  };
  try{
    const proof=await proofVerifier(proofFile,env,now);
    report.proofValid=proof?.valid===true;
    if(!report.proofValid){blockers.push('untrusted_portable_proof');return report;}
    if(!pool){blockers.push('isolated_restore_not_connected');return report;}
    const client=await pool.connect();
    try{
      await client.query('BEGIN READ ONLY');
      const name=(await client.query('SELECT current_database() AS name')).rows[0]?.name;
      report.drDatabaseIsolated=typeof name==='string'&&
        /^industry_dr_[a-z0-9_]{2,40}$/.test(name);
      if(!report.drDatabaseIsolated){
        blockers.push('not_an_isolated_dr_database');
        return report;
      }
      const migrations=await client.query(
        "SELECT count(*)::int AS n FROM industry.schema_migrations WHERE name='013_guest_external_anchor_fence.sql'"
      );
      report.migration013Ready=Number(migrations.rows[0]?.n)===1;
      if(!report.migration013Ready)blockers.push('missing_migration_013');
      const [old,latest,history]=await Promise.all([
        client.query('SELECT max_revision,max_sequence,checkpoint_sha FROM industry.guest_registry_checkpoint_fence WHERE id=1'),
        client.query('SELECT max_revision,max_sequence,checkpoint_sha,anchor_sha FROM industry.guest_external_anchor_fence WHERE id=1'),
        client.query('SELECT journal_sequence,registry_revision,checkpoint_sha,anchor_sha FROM industry.guest_external_anchor_receipts WHERE journal_sequence=$1',
          [proof.sequence])
      ]);
      const equals=(v,revision,sequence)=>v?.max_revision!==undefined&&
        Number(v.max_revision)===revision&&Number(v.max_sequence)===sequence;
      const a=old.rows[0],b=latest.rows[0],c=history.rows[0];
      report.r17CheckpointMatched=old.rowCount===1&&
        equals(a,proof.revision,proof.sequence)&&a.checkpoint_sha===proof.checkpointDigest;
      report.r18AnchorMatched=latest.rowCount===1&&
        equals(b,proof.revision,proof.sequence)&&
        b.checkpoint_sha===proof.checkpointDigest&&
        b.anchor_sha===proof.anchorDigest;
      report.appendOnlyReceiptMatched=history.rowCount===1&&
        Number(c.journal_sequence)===proof.sequence&&
        Number(c.registry_revision)===proof.revision&&
        c.checkpoint_sha===proof.checkpointDigest&&
        c.anchor_sha===proof.anchorDigest;
      if(!report.r17CheckpointMatched)blockers.push('r17_restore_checkpoint_mismatch');
      if(!report.r18AnchorMatched)blockers.push('r18_restore_anchor_mismatch');
      if(!report.appendOnlyReceiptMatched)blockers.push('missing_accepted_anchor_receipt');
    }catch{
      blockers.push('dr_schema_or_checkpoint_unavailable');
    }finally{
      await client.query('ROLLBACK').catch(()=>{});
      client.release();
    }
  }catch{blockers.push('dr_rehearsal_unavailable');}
  report.technicalRestoreReady=blockers.length===0;
  return report;
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  let pool;
  try{
    if(process.argv.length!==3)throw Error('Usage: node scripts/r18-dr-rehearsal.mjs /private/proof.json');
    const u=new URL(process.env.DR_RESTORE_DB_URL||'');
    if(!/^industry_dr_[a-z0-9_]{2,40}$/.test(u.pathname.slice(1)))
      throw Error('Isolated industry_dr_* database required');
    pool=new pg.Pool({connectionString:process.env.DR_RESTORE_DB_URL,max:2});
    const result=await rehearseRecovery({proofFile:process.argv[2],pool});
    process.stdout.write(JSON.stringify(result)+'\n');
    if(!result.technicalRestoreReady)process.exitCode=2;
  }catch{
    process.stderr.write('R18 recovery drill failed closed; no production data or settings were changed.\n');
    process.exitCode=2;
  }finally{if(pool)await pool.end();}
}
