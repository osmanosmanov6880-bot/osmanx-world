import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {auditR21Database,AUDIT_SCHEMA} from '../src/guest-r21-db-audit.mjs';
import {runR21DatabaseAudit} from '../scripts/r21-db-audit.mjs';
function fixture(){
  const tenantId=randomUUID(),pilotId=randomUUID(),queries=[];
  const migrations=['011_guest_pilot_safety.sql',
    '012_guest_registry_checkpoint_fence.sql',
    '013_guest_external_anchor_fence.sql',
    '014_guest_single_pilot_rollout.sql'];
  const tables=['guest_registry_checkpoint_fence',
    'guest_external_anchor_fence','guest_external_anchor_receipts',
    'guest_r19_daily_usage','guest_r19_collection_events'];
  let force=true,privileged=false,update=false,del=false,
    r17=3,r18=3,quota=2,event=2,overdue=0;
  const db={async query(sql,params=[]){
    queries.push({sql,params});
    if(sql.startsWith('SELECT name FROM industry.schema_migrations'))
      return {rows:migrations.map(name=>({name})),rowCount:migrations.length};
    if(sql.includes('FROM pg_class'))
      return {rows:tables.map(relname=>({relname,rls:true,forced:force})),
        rowCount:tables.length};
    if(sql.includes('FROM pg_roles'))
      return {rows:[{privileged,history_update:update,history_delete:del,
        audit_update:update,audit_delete:del,quota_delete:del}],rowCount:1};
    if(sql.includes('guest_registry_checkpoint_fence WHERE id=1'))
      return {rows:[{r17,r18}],rowCount:1};
    if(sql.includes('FROM industry.guest_r19_daily_usage')&&
      sql.includes('SELECT used_count,max_daily'))
      return {rows:[{used_count:quota,max_daily:5}],rowCount:1};
    if(sql.includes('FROM industry.guest_r19_collection_events'))
      return {rows:[{total:event}],rowCount:1};
    if(sql.includes('count(*) FILTER'))
      return {rows:[{n:1,overdue}],rowCount:1};
    if(sql==='BEGIN READ ONLY'||sql==='ROLLBACK'||sql.startsWith('SELECT set_config'))
      return {rows:[],rowCount:0};
    throw Error('Unexpected SQL: '+sql);
  },release(){}};
  return {tenantId,pilotId,db,queries,
    setForce:x=>force=x,setPrivileged:x=>privileged=x,
    setUpdate:x=>update=x,setDelete:x=>del=x,
    setFences:(x,y)=>{r17=x;r18=y;},
    setQuota:x=>quota=x,setEvent:x=>event=x,
    setOverdue:x=>overdue=x};
}
test('R21 never mutates database while auditing migration 011-014, RLS, role grants and journal parity',async()=>{
  const f=fixture(),r=await auditR21Database(f.db,{
    tenantId:f.tenantId,pilotId:f.pilotId,retentionDays:30
  });
  assert.equal(r.schema,AUDIT_SCHEMA);
  assert.equal(r.technicalPostureReady,true,JSON.stringify(r.blockers));
  assert.equal(r.usageRows,1);
  assert.equal(r.auditEventCount,2);
  assert.equal(r.customerGo,false);
  assert.equal(r.productionAuthorized,false);
  assert.ok(f.queries.every(x=>x.sql.startsWith('SELECT')));
  assert.ok(f.queries.filter(x=>x.sql.includes('guest_r19_daily_usage')).every(
    x=>x.params[0]===f.tenantId&&x.params[1]===f.pilotId));
});
test('R21 refuses public role, mutable audit events, missing FORCE RLS, rollback and outdated logs',async()=>{
  const f=fixture();
  f.setPrivileged(true);f.setUpdate(true);f.setDelete(true);
  f.setForce(false);f.setFences(3,1);f.setEvent(1);f.setOverdue(3);
  const r=await auditR21Database(f.db,{
    tenantId:f.tenantId,pilotId:f.pilotId,retentionDays:30
  });
  assert.equal(r.technicalPostureReady,false);
  for(const key of ['runtimeRoleUnprivileged',
    'immutableHistoryNotWritable','dailyBudgetDoesNotAllowDelete',
    'allSecurityTablesForcedRls','checkpointsConsistent',
    'auditMatchesQuota','noOverRetentionDrift'])
    assert.equal(r.checks[key],false,key);
  assert.equal(r.customerGo,false);
});
test('R21 CLI wrapper uses BEGIN READ ONLY and ROLLBACK, no SQL change or unsafe DB target',async()=>{
  const f=fixture();
  const pool={async connect(){return f.db;}};
  const result=await runR21DatabaseAudit({
    pool,tenantId:f.tenantId,pilotId:f.pilotId,retentionDays:12});
  assert.equal(result.technicalPostureReady,true);
  assert.equal(f.queries[0].sql,'BEGIN READ ONLY');
  assert.equal(f.queries.at(-1).sql,'ROLLBACK');
  assert.ok(f.queries.every(x=>x.sql.startsWith('SELECT')||
    ['BEGIN READ ONLY','ROLLBACK'].includes(x.sql)));
});
test('R21 rejects invalid tenant/scope or missing PostgreSQL connection',async()=>{
  const f=fixture();
  const r=await auditR21Database(f.db,{
    tenantId:'invalid',pilotId:f.pilotId,retentionDays:120
  });
  assert.equal(r.technicalPostureReady,false);
  assert.equal(r.blockers[0],'invalid_audit_target');
  assert.equal(f.queries.length,0);
  const unavailable=await runR21DatabaseAudit({pool:null,
    tenantId:f.tenantId,pilotId:f.pilotId});
  assert.equal(unavailable.technicalPostureReady,false);
});
