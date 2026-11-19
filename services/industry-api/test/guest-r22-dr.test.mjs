import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {verifyR22DrQuorum,DR_SCHEMA} from '../scripts/r22-dr-quorum.mjs';
function fixture(){
  const tenantId=randomUUID(),pilotId=randomUUID();
  const scope={valid:true,tenantId,pilotId};
  const sql=[];
  function pool(database,{used=2,anchor='b'}={}){
    const client={
      release(){},
      async query(statement,params){
        sql.push({database,statement,params});
        if(statement==='BEGIN READ ONLY'||statement==='ROLLBACK')
          return {rows:[],rowCount:0};
        if(statement.includes('current_database()'))
          return {rows:[{name:database}],rowCount:1};
        if(statement.includes('guest_registry_checkpoint_fence'))
          return {rows:[{max_revision:1,max_sequence:3,
            checkpoint_sha:'a'.repeat(64)}],rowCount:1};
        if(statement.includes('guest_external_anchor_fence'))
          return {rows:[{max_revision:1,max_sequence:3,
            checkpoint_sha:'a'.repeat(64),anchor_sha:anchor.repeat(64)}],rowCount:1};
        if(statement.includes('guest_r19_daily_usage'))
          return {rows:[{day:'2026-11-19',used_count:used,
            max_daily:3,last_scope_sha:'c'.repeat(64)}],rowCount:1};
        if(statement.includes('guest_r19_collection_events'))
          return {rows:[{day:'2026-11-19',count:used}],rowCount:1};
        throw Error('R22 forbidden SQL '+statement);
      }
    };
    return {async connect(){return client;}};
  }
  const a={database:'industry_dr_r22_first',pool:pool('industry_dr_r22_first'),
    ciphertextSha:'d'.repeat(64),recipientPublicKeySha:'e'.repeat(64),
    offsiteReceiptSha:'f'.repeat(64)};
  const b={database:'industry_dr_r22_second',pool:pool('industry_dr_r22_second'),
    ciphertextSha:'1'.repeat(64),recipientPublicKeySha:'2'.repeat(64),
    offsiteReceiptSha:'3'.repeat(64)};
  const opts={a,b,tenantId,pilotId,scope,
    proofFile:'/private/r18-proof.json',
    now:new Date('2026-11-19T16:00:00.000Z'),
    firstVerifier:async()=>({technicalRestoreReady:true})};
  return {opts,sql,pool};
}
test('R22 reconciles two separately named, independently encrypted read-only DR restores',async()=>{
  const f=fixture(),result=await verifyR22DrQuorum(f.opts);
  assert.equal(result.schema,DR_SCHEMA);
  assert.equal(result.technicalQuorumReady,true,JSON.stringify(result.blockers));
  assert.equal(result.firstPassed,true);
  assert.equal(result.secondPassed,true);
  assert.equal(result.contentsIdentical,true);
  assert.equal(result.isolatedDatabasesDistinct,true);
  assert.equal(result.totalSuccessfulOperations,2);
  assert.match(result.checkpointDigest,/^[a-f0-9]{64}$/);
  assert.equal(result.offsiteWormVerified,false);
  assert.equal(result.twoIndependentOfflineAttestationsVerified,false);
  assert.equal(result.productionAuthorized,false);
  assert.ok(f.sql.every(x=>x.statement==='BEGIN READ ONLY'||x.statement==='ROLLBACK'||
    x.statement.startsWith('SELECT')));
  assert.equal(f.sql.filter(x=>x.statement==='ROLLBACK').length,2);
});
test('R22 detects different recovered event histories and old checkpoint anchors',async()=>{
  const f=fixture();
  f.opts.b.pool=f.pool('industry_dr_r22_second',{used:3});
  const mismatch=await verifyR22DrQuorum(f.opts);
  assert.equal(mismatch.technicalQuorumReady,false);
  assert.ok(mismatch.blockers.includes('restored_copies_differ'));
  f.opts.b.pool=f.pool('industry_dr_r22_second',{anchor:'c'});
  const anchor=await verifyR22DrQuorum(f.opts);
  assert.equal(anchor.technicalQuorumReady,false);
  assert.ok(anchor.blockers.includes('restored_copies_differ'));
});
test('R22 rejects same AGE recipient, reused ciphertext and two names pointing at one database',async()=>{
  const f=fixture();
  f.opts.b.recipientPublicKeySha=f.opts.a.recipientPublicKeySha;
  assert.ok((await verifyR22DrQuorum(f.opts)).blockers.includes('copy_provenance_not_independent'));
  f.opts.b={...fixture().opts.b,
    database:'industry_dr_r22_second',
    pool:f.pool('industry_dr_r22_first')};
  assert.ok((await verifyR22DrQuorum(f.opts)).blockers.includes('same_database_or_wrong_target'));
});
test('R22 treats failure of one R20 independent restore as hard veto',async()=>{
  const f=fixture();
  let count=0;
  f.opts.firstVerifier=async()=>({
    technicalRestoreReady:(++count)!==2
  });
  const result=await verifyR22DrQuorum(f.opts);
  assert.equal(result.firstPassed,true);
  assert.equal(result.secondPassed,false);
  assert.equal(result.technicalQuorumReady,false);
  assert.ok(result.blockers.includes('second_restore_rejected'));
});
