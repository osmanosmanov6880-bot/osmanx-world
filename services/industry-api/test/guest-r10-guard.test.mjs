import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/app.mjs';

const safe=()=>({
  migration_count:7,table_count:9,forced_rls:true,
  privileged_role:false,can_read_guests:true,can_modify_migrations:false
});
const preserve={node:process.env.NODE_ENV,origin:process.env.ALLOWED_ORIGIN,
  writes:process.env.GUEST_WRITES_ENABLED};
function env(write){
  process.env.NODE_ENV='production';
  process.env.ALLOWED_ORIGIN='https://osmanx.world';
  if(write===undefined)delete process.env.GUEST_WRITES_ENABLED;
  else process.env.GUEST_WRITES_ENABLED=write;
}
async function tryMutation(row,writes='true'){
  env(writes==='__unset__'?undefined:writes);
  let probed=0,unexpected=0;
  const pool={query:async sql=>{
    if(String(sql).includes('WITH migrations AS')){probed++;return {rows:[row],rowCount:1}}
    unexpected++;return {rows:[],rowCount:0};
  }};
  const app=await buildApp(pool);
  try{
    const result=await app.inject({method:'POST',url:'/api/industry/v1/guest/requests',
      headers:{origin:'https://osmanx.world','content-type':'application/json'},
      payload:{title:'Synthetic guard-only check',source:'field'}});
    return {status:result.statusCode,probed,unexpected,
      error:result.json()?.error};
  }finally{await app.close()}
}
test.after(()=>{
  for(const [key,value] of [
    ['NODE_ENV',preserve.node],['ALLOWED_ORIGIN',preserve.origin],
    ['GUEST_WRITES_ENABLED',preserve.writes]]){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
});
test('R10 production mutation stays disabled when operator flag is absent or false',async()=>{
  for(const setting of ['__unset__','false']){
    const r=await tryMutation(safe(),setting);
    assert.equal(r.status,503);
    assert.equal(r.probed,0);
    assert.equal(r.unexpected,0);
  }
});
test('R10 explicit writes flag never bypasses database migration, RLS or least privilege',async()=>{
  for(const corrupt of [
    {migration_count:6},{table_count:8},{forced_rls:false},
    {privileged_role:true},{can_read_guests:false},{can_modify_migrations:true}
  ]){
    const r=await tryMutation({...safe(),...corrupt});
    assert.equal(r.status,503,JSON.stringify(corrupt));
    assert.equal(r.probed,1,JSON.stringify(corrupt));
    assert.equal(r.unexpected,0);
    assert.doesNotMatch(r.error||'',/PASSWORD|postgres:|[0-9a-f]{64}/i);
  }
});
test('R10 even safe schema and operator flag never bypass authentication',async()=>{
  const r=await tryMutation(safe());
  assert.equal(r.status,401);
  assert.equal(r.probed,1);
  assert.equal(r.unexpected,0); // No session means auth must fail before business writes.
});
test('R10 readiness outages fail closed without exposing database credentials',async()=>{
  env('true');
  const app=await buildApp({
    query:async()=>{throw Error('postgres://operator:supersecret@internal.invalid:5432/industry_prod')}
  });
  try{
    const r=await app.inject({method:'POST',url:'/api/industry/v1/guest/requests',
      headers:{origin:'https://osmanx.world'},
      payload:{title:'Outage',source:'field'}});
    assert.equal(r.statusCode,503);
    assert.doesNotMatch(r.body,/supersecret|internal\.invalid|industry_prod/);
  }finally{await app.close()}
});
