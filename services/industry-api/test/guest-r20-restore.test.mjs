import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {protocolDigest} from '../src/guest-r19-scope.mjs';
import {verifyR20Restore} from '../scripts/r20-restore-crosscheck.mjs';

function makeFixture(){
  const now=new Date('2026-11-19T14:00:00.000Z');
  const tenantId=randomUUID(),pilotId=randomUUID();
  const pilot={id:pilotId,tenant_id:tenantId,
    protocol:{startDate:'2026-11-15',endDate:'2026-11-26',source:'pos',
      allocation:'random',outcomeWindowDays:7,primaryMetric:'repeat_visit'},
    protocol_registered_at:new Date('2026-11-14T00:00:00.000Z')};
  const proof={valid:true,anchorDigest:'a'.repeat(64),
    checkpointDigest:'b'.repeat(64),revision:1,sequence:3};
  const scope={valid:true,tenantId,pilotId,scopeDigest:'c'.repeat(64),
    record:{checkpointDigest:proof.checkpointDigest,journalSequence:3,
      protocolDigest:protocolDigest(pilot),
      policy:{retentionDays:30}}};
  const calls=[];
  let dbName='industry_dr_r20_synthetic';
  let used=2,eventCount=2,day='2026-11-19';
  const client={
    release(){},
    async query(sql,params){
      calls.push({sql,params});
      if(sql==='BEGIN READ ONLY'||sql==='ROLLBACK')return {rowCount:0,rows:[]};
      if(sql.includes('current_database()'))
        return {rowCount:1,rows:[{name:dbName}]};
      if(sql.includes('schema_migrations'))
        return {rowCount:1,rows:[{n:1}]};
      if(sql.includes('FROM industry.guest_pilots'))
        return {rowCount:1,rows:[pilot]};
      if(sql.includes('FROM industry.guest_r19_daily_usage'))
        return {rowCount:1,rows:[{day,used_count:used,max_daily:5,
          last_scope_sha:'c'.repeat(64)}]};
      if(sql.includes('FROM industry.guest_r19_collection_events'))
        return {rowCount:1,rows:[{day,n:eventCount}]};
      throw Error('Forbidden or unsupported SQL in R20 DR test: '+sql);
    }
  };
  const pool={async connect(){return client;}};
  const proofVerifier=async()=>proof;
  const baseVerifier=async()=>({technicalRestoreReady:true});
  const exercise=async()=>verifyR20Restore({
    pool,proofFile:'/private/synthetic-proof.json',scope,tenantId,pilotId,
    now,proofVerifier,baseVerifier
  });
  return {now,tenantId,pilotId,scope,proof,calls,exercise,
    setDbName:x=>dbName=x,setUsed:x=>used=x,setCount:x=>eventCount=x,
    setDay:x=>day=x};
}
test('R20 cross-check reconciles signed R18 archive, DR pilot protocol and every successful R19 collection event',async()=>{
  const f=makeFixture(),r=await f.exercise();
  assert.equal(r.technicalRestoreReady,true,JSON.stringify(r.blockers));
  for(const key of ['evidenceValid','r18RestoreMatched','isolatedDrDatabase',
    'migration014Ready','scopeMatchesEvidence','protocolMatches',
    'r19QuotaLedgerConsistent','r19AuditConsistent','retentionReviewPassed'])
    assert.equal(r[key],true,key);
  assert.equal(r.customerGo,false);assert.equal(r.productionChanged,false);
  assert.equal(r.offsiteWormVerified,false);assert.equal(r.legalGo,false);
  assert.ok(f.calls.every(x=>x.sql==='BEGIN READ ONLY'||x.sql==='ROLLBACK'||
    x.sql.startsWith('SELECT')));
  assert.ok(f.calls.some(x=>x.sql==='ROLLBACK'));
});
test('R20 refuses stale or inconsistent restored collection quotas without touching the database',async()=>{
  const f=makeFixture();
  f.setCount(1);
  const wrong=await f.exercise();
  assert.equal(wrong.technicalRestoreReady,false);
  assert.ok(wrong.blockers.includes('audit_event_count_mismatch'));
  f.setCount(2);f.setUsed(9);
  const quota=await f.exercise();
  assert.equal(quota.technicalRestoreReady,false);
  assert.ok(quota.blockers.includes('quota_ledger_invalid_or_truncated'));
  f.setUsed(2);f.setDay('2026-10-01');
  const expired=await f.exercise();
  assert.equal(expired.retentionReviewPassed,false);
  assert.ok(expired.blockers.includes('retention_or_day_window_requires_review'));
});
test('R20 rejects non-isolated database and untrusted external evidence',async()=>{
  const f=makeFixture();f.setDbName('industry_ci');
  const unsafe=await f.exercise();
  assert.equal(unsafe.technicalRestoreReady,false);
  assert.ok(unsafe.blockers.includes('db_not_dr_isolated'));
  const invalid=await verifyR20Restore({
    proofFile:'/private/synthetic-proof.json',pool:{connect:async()=>{throw Error('Must not connect');}},
    tenantId:f.tenantId,pilotId:f.pilotId,scope:f.scope,
    proofVerifier:async()=>({...f.proof,valid:false}),
    baseVerifier:async()=>{throw Error('Should not reach DR');},
    now:f.now
  });
  assert.equal(invalid.technicalRestoreReady,false);
  assert.ok(invalid.blockers.includes('invalid_r18_portable_proof'));
});
