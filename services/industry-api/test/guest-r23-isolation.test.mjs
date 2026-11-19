import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rehearseR23TenantIsolation,RLS_SCHEMA}
  from '../scripts/r23-tenant-isolation.mjs';
function fixture({leak=false,privileged=false}={}){
  const tenantA=randomUUID(),tenantB=randomUUID(),
    pilotA=randomUUID(),pilotB=randomUUID();
  let active=null,started=false,rolledBack=false;
  const queries=[];
  const client={release(){},
    async query(sql,params=[]){
      queries.push({sql,params});
      if(sql.startsWith('BEGIN TRANSACTION')){started=true;return {rows:[],rowCount:0};}
      if(sql==='ROLLBACK'){rolledBack=true;return {rows:[],rowCount:0};}
      if(sql.includes('pg_roles'))
        return {rowCount:1,rows:[{privileged}]};
      if(sql.startsWith("SELECT set_config('app.tenant_id'")){
        active=params[0];return {rowCount:1,rows:[{}]};
      }
      if(sql.includes('industry.guest_pilots')){
        const [own,foreign]=params;
        return {rowCount:1,rows:[{
          own:active===(own===pilotA?tenantA:tenantB),
          foreign:leak||active===(foreign===pilotA?tenantA:tenantB)
        }]};
      }
      throw Error('Unexpected query '+sql);
    }};
  return {tenantA,tenantB,pilotA,pilotB,queries,
    pool:{async connect(){return client;}},
    getState:()=>({started,rolledBack})};
}
test('R23 tests two populated tenants under the same least-privilege read-only connection',async()=>{
  const f=fixture();
  const report=await rehearseR23TenantIsolation(f.pool,f);
  assert.equal(report.schema,RLS_SCHEMA);
  assert.equal(report.technicalIsolationPass,true,JSON.stringify(report.blockers));
  assert.equal(report.firstOwnVisible,true);
  assert.equal(report.firstForeignHidden,true);
  assert.equal(report.secondOwnVisible,true);
  assert.equal(report.secondForeignHidden,true);
  assert.equal(report.transactionRolledBack,true);
  assert.equal(report.productionAuthorized,false);
  assert.equal(report.customerDataReturned,false);
  assert.ok(f.queries.every(x=>x.sql.startsWith('SELECT')||
    x.sql.startsWith('BEGIN TRANSACTION')||x.sql==='ROLLBACK'));
  assert.equal(f.queries.at(-1).sql,'ROLLBACK');
});
test('R23 stops on a false RLS policy leak or privileged service account',async()=>{
  const a=fixture({leak:true}),b=fixture({privileged:true});
  const leak=await rehearseR23TenantIsolation(a.pool,a);
  assert.equal(leak.technicalIsolationPass,false);
  assert.ok(leak.blockers.includes('rls_firstForeignHidden'));
  assert.ok(leak.blockers.includes('rls_secondForeignHidden'));
  const privilege=await rehearseR23TenantIsolation(b.pool,b);
  assert.equal(privilege.technicalIsolationPass,false);
  assert.ok(privilege.blockers.includes('rls_appRoleLeastPrivilege'));
});
test('R23 rejects duplicate control samples, missing pool and wrong pilot values',async()=>{
  const f=fixture();
  const duplicate=await rehearseR23TenantIsolation(f.pool,{
    ...f,tenantB:f.tenantA
  });
  assert.equal(duplicate.technicalIsolationPass,false);
  assert.ok(duplicate.blockers.includes('invalid_distinct_tenant_control_samples'));
  assert.equal(f.queries.length,0);
  const missing=await rehearseR23TenantIsolation(null,f);
  assert.equal(missing.customerGo,false);
  assert.equal(missing.technicalIsolationPass,false);
});
