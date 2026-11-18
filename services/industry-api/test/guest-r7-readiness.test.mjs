import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {makePool} from '../src/database.mjs';
import {probeGuestDatabase,assertGuestDatabaseState,REQUIRED_MIGRATIONS} from '../src/readiness.mjs';
import {buildApp} from '../src/app.mjs';

const safe={migration_count:7,table_count:9,forced_rls:true,privileged_role:false,
  can_read_guests:true,can_modify_migrations:false};
test('R7 pure readiness gate fails closed for missing schemas, bypass roles and weak RLS',()=>{
  assert.equal(assertGuestDatabaseState(safe).leastPrivilege,true);
  for(const bad of [
    {...safe,migration_count:6},{...safe,table_count:8},
    {...safe,forced_rls:false},{...safe,privileged_role:true},
    {...safe,can_modify_migrations:true},{...safe,can_read_guests:false},null
  ])assert.throws(()=>assertGuestDatabaseState(bad),{statusCode:503});
  assert.ok(REQUIRED_MIGRATIONS.includes('010_guest_launch_gate.sql'));
});
test('R7 live application role must pass only after 006 migration and enforced RLS',async()=>{
  const pool=makePool(process.env.DATABASE_URL);
  const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
  try{
    const result=await probeGuestDatabase(pool);
    assert.equal(result.leastPrivilege,true);
    assert.equal(result.forcedRls,true);
    assert.equal(result.schemaVersion,'010_guest_launch_gate.sql');
    const app=await buildApp(pool);
    try{
      const healthy=await app.inject({method:'GET',url:'/api/industry/v1/health/ready'});
      assert.equal(healthy.statusCode,200,healthy.body);
      assert.equal(healthy.json().schemaVersion,result.schemaVersion);
    }finally{await app.close()}
    const grant=await admin.query(
      "SELECT has_table_privilege('industry_app','industry.schema_migrations','SELECT') AS can_read, has_table_privilege('industry_app','industry.schema_migrations','UPDATE') AS can_write");
    assert.equal(grant.rows[0].can_read,true);
    assert.equal(grant.rows[0].can_write,false);
    const migrations=await admin.query('SELECT count(*)::int AS n FROM industry.schema_migrations WHERE name=ANY($1::text[])',[REQUIRED_MIGRATIONS]);
    assert.equal(migrations.rows[0].n,7);
    await assert.rejects(probeGuestDatabase(admin),{statusCode:503},'Migration/superuser role must never be accepted as the runtime DB role');
  }finally{await pool.end();await admin.end()}
});
test('R7 database outage yields a 503 and no credential information',async()=>{
  const fake={query:async()=>{throw Error('postgres://name:password@secret-host:5432/database')}};
  await assert.rejects(probeGuestDatabase(fake),e=>{
    assert.equal(e.statusCode,503);
    assert.doesNotMatch(e.message,/password|5432|secret-host/);
    return true;
  });
});
