// Real PostgreSQL RLS and API acceptance for five new R11 operational features.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {hashPassword} from '../src/password.mjs';
import {makePool,withTenant} from '../src/database.mjs';
import {buildApp} from '../src/app.mjs';

const tag=randomUUID().slice(0,8),P='/api/industry/v1',pass='R11-Synthetic-Strong-Password-2026!';
const orgs=[
  {slug:'r11-a-'+tag,name:'R11 synthetic team A'},
  {slug:'r11-b-'+tag,name:'R11 synthetic team B'}
];
const accounts=[
  {key:'owner',email:'r11-owner-'+tag+'@example.test',role:'owner',org:0},
  {key:'manager',email:'r11-manager-'+tag+'@example.test',role:'manager',org:0},
  {key:'operator',email:'r11-operator-'+tag+'@example.test',role:'operator',org:0},
  {key:'viewer',email:'r11-viewer-'+tag+'@example.test',role:'viewer',org:0},
  {key:'outsider',email:'r11-outsider-'+tag+'@example.test',role:'owner',org:1}
];
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL}),db=makePool();
const protocol={startDate:'2026-11-01',endDate:'2026-11-16',outcomeWindowDays:1,
  allocation:'random',source:'pos',primaryMetric:'repeat_visit'};
const plan={baselinePct:20,liftPp:10,margin:250,discount:5,fixed:100,fee:25000};
const readiness=Object.fromEntries(['repeatDefinition','sameWindow','independentGroups',
  'marginVerified','contactConsent','ownerAgreed'].map(x=>[x,true]));
const csv='date,control,controlReturn,offer,offerReturn\n2026-11-09,900,180,900,270\n';
const due=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
let app,staff={};
const call=(method,path,who,payload,headers={})=>app.inject({
  method,url:P+path,
  headers:{...(who?{cookie:who.cookie,'x-csrf-token':who.csrf}:{}),...headers},
  ...(payload===undefined?{}:{payload})
});
const expect=(r,code)=>{assert.equal(r.statusCode,code,r.body);return r.json()};
function loginCookie(r){
  const pairs=[].concat(r.headers['set-cookie']||[]).map(x=>x.split(';')[0]);
  const token=pairs.find(x=>x.startsWith('osmanx_industry_csrf='));
  assert.ok(token);
  return {cookie:pairs.join('; '),csrf:token.slice(token.indexOf('=')+1)};
}
before(async()=>{
  for(const org of orgs)
    org.id=(await admin.query(
      "INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
      [org.slug,org.name])).rows[0].id;
  for(const user of accounts){
    user.id=(await admin.query(
      'INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [user.email,await hashPassword(pass)])).rows[0].id;
    await admin.query(
      'INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',
      [orgs[user.org].id,user.id,user.role]);
  }
  app=await buildApp(db);
  for(const user of accounts){
    const r=await call('POST','/auth/login',null,{
      tenantSlug:orgs[user.org].slug,email:user.email,password:pass});
    expect(r,200);staff[user.key]=loginCookie(r);
  }
});
after(async()=>{if(app)await app.close();await db.end();await admin.end();});

test('R11 tenant dashboard, immutable task timeline, assignment controls and proof export',async()=>{
  const p=expect(await call('POST','/guest/pilots',staff.owner,{
    title:'R11 first-pilot operations scenario',plan,protocol
  }),201).item;
  const id=p.id;
  const first=expect(await call('GET','/guest/operations',staff.owner),200);
  assert.equal(first.schema,'osmanx.guest.operations.v1');
  assert.ok(first.items.some(item=>item.id===id));
  assert.equal((await call('GET','/guest/operations',staff.viewer)).statusCode,403);
  assert.equal(expect(await call('GET','/guest/operations',staff.outsider),200).items.length,0);

  const actionPath='/guest/pilots/'+id+'/actions';
  const created=expect(await call('POST',actionPath,staff.owner,{
    expectedPilotVersion:p.version,code:'COLLECT_OBSERVATIONS',
    assigneeId:accounts[2].id,dueDate:due(12)
  }),201).item;
  assert.equal(created.version,1);
  const histPath=actionPath+'/'+created.id+'/history';
  let entries=expect(await call('GET',histPath,staff.viewer),200).items;
  assert.equal(entries.length,1);
  assert.equal(entries[0].event_type,'created');
  assert.equal(entries[0].to_status,'open');
  assert.equal(entries[0].action_version,1);
  assert.equal((await call('GET',histPath,staff.outsider)).statusCode,404);

  const assignmentPath=actionPath+'/'+created.id+'/assignment';
  const change={expectedVersion:1,assigneeId:accounts[1].id,dueDate:due(10)};
  assert.equal((await call('PATCH',assignmentPath,staff.operator,change)).statusCode,403);
  assert.equal((await call('PATCH',assignmentPath,staff.viewer,change)).statusCode,403);
  assert.equal((await call('PATCH',assignmentPath,staff.owner,
    {...change,assigneeId:accounts[4].id})).statusCode,400);
  assert.equal((await call('PATCH',assignmentPath,staff.owner,
    {...change,assigneeId:accounts[3].id})).statusCode,400);
  const reassigned=expect(await call('PATCH',assignmentPath,staff.manager,change),200).item;
  assert.equal(reassigned.assigned_to,accounts[1].id);
  assert.equal(reassigned.version,2);
  assert.equal((await call('PATCH',assignmentPath,staff.owner,change)).statusCode,409);
  assert.equal((await call('PATCH',actionPath+'/'+created.id,staff.operator,
    {expectedVersion:2,status:'in_progress'})).statusCode,403);
  const changed=expect(await call('PATCH',actionPath+'/'+created.id,staff.manager,
    {expectedVersion:2,status:'in_progress'}),200).item;
  assert.equal(changed.version,3);
  const race=await Promise.all([
    call('PATCH',assignmentPath,staff.owner,{expectedVersion:3,assigneeId:accounts[2].id,dueDate:due(11)}),
    call('PATCH',assignmentPath,staff.manager,{expectedVersion:3,assigneeId:accounts[1].id,dueDate:due(9)})
  ]);
  assert.deepEqual(race.map(r=>r.statusCode).sort(),[200,409]);
  const latest=expect(await call('GET',actionPath,staff.owner),200).items.find(x=>x.id===created.id);
  assert.equal(latest.version,4);
  entries=expect(await call('GET',histPath,staff.viewer),200).items;
  assert.deepEqual(entries.map(x=>x.action_version),[1,2,3,4]);
  assert.deepEqual(entries.map(x=>x.event_type),
    ['created','assignment','status','assignment']);
  assert.equal(entries.at(-1).action_version,latest.version);
  assert.equal((await call('PATCH',assignmentPath,staff.owner,
    {expectedVersion:4,assigneeId:latest.assigned_to,dueDate:latest.dueDate})).statusCode,409);

  let pilot=expect(await call('PATCH','/guest/pilots/'+id+'/readiness',staff.owner,
    {expectedVersion:p.version,readiness}),200).item;
  pilot=expect(await call('POST','/guest/pilots/'+id+'/start',staff.owner,
    {expectedVersion:pilot.version}),200).item;
  const preview=expect(await call('POST','/guest/pilots/'+id+'/observations/import/preview',staff.operator,
    {expectedVersion:pilot.version,csv}),200);
  const committed=expect(await call('POST','/guest/pilots/'+id+'/observations/import',staff.operator,
    {expectedVersion:pilot.version,csv,sha256:preview.sha256},
    {'Idempotency-Key':'r11-batch-'+tag}),201);
  assert.equal(committed.rowsImported,1);
  const exportPath='/guest/pilots/'+id+'/operations/export.json';
  assert.equal((await call('GET',exportPath,staff.viewer)).statusCode,403);
  assert.equal((await call('GET',exportPath,staff.outsider)).statusCode,404);
  const result=expect(await call('GET',exportPath,staff.owner),200);
  assert.equal(result.format,'osmanx.guest.operations.export.v1');
  assert.equal(result.sha256,sha(result.snapshot));
  assert.equal(result.snapshot.evidenceSha256,sha(result.snapshot.evidence));
  assert.equal(result.snapshot.actionHistory.length,4);
  assert.equal(result.snapshot.importLedger.length,1);
  assert.ok(result.snapshot.actions.every(x=>x.id===created.id));
  assert.doesNotMatch(JSON.stringify(result),/password_hash|display_name|phone|example\.test/i);
  const before=sha(result.snapshot.evidence);
  const historyUpdate=await admin.query(
    'UPDATE industry.guest_action_history SET to_status=$1 WHERE id=$2',
    ['done',entries[1].id]).then(()=>null,e=>e);
  assert.ok(historyUpdate&&historyUpdate.code==='23514');
  const again=expect(await call('GET',exportPath,staff.owner),200);
  assert.equal(before,again.snapshot.evidenceSha256);
  assert.equal(result.sha256,again.sha256);
  const foreignScope=await withTenant(db,orgs[1].id,async client=>
    client.query('SELECT id FROM industry.guest_action_history WHERE tenant_id=$1',[orgs[0].id]));
  assert.equal(foreignScope.rowCount,0);
});
test('R11 new immutable history is least-privilege RLS and never grants DELETE',async()=>{
  const tables=await admin.query(
    "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='industry.guest_action_history'::regclass"
  );
  assert.equal(tables.rowCount,1);
  assert.equal(tables.rows[0].relrowsecurity,true);
  assert.equal(tables.rows[0].relforcerowsecurity,true);
  const p=await admin.query(
    "SELECT has_table_privilege('industry_app','industry.guest_action_history','SELECT') AS read,"+
    "has_table_privilege('industry_app','industry.guest_action_history','INSERT') AS insert,"+
    "has_table_privilege('industry_app','industry.guest_action_history','UPDATE') AS update,"+
    "has_table_privilege('industry_app','industry.guest_action_history','DELETE') AS del");
  assert.deepEqual(Object.values(p.rows[0]),[true,true,false,false]);
});
