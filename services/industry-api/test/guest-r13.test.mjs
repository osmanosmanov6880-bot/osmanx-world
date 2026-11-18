// Real PostgreSQL + Fastify: emergency hold enforcement, independent restart,
// immutable event chain, cross-tenant isolation, data-quality and proof export.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {makePool,withTenant} from '../src/database.mjs';
import {hashPassword} from '../src/password.mjs';
import {buildApp} from '../src/app.mjs';

const P='/api/industry/v1',tag=randomUUID().slice(0,8),password='R13-Synthetic-Strong-Password-2026!';
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL}),db=makePool();
const organizations=[{slug:'r13-a-'+tag},{slug:'r13-b-'+tag}];
const users=[
 {key:'owner',role:'owner',tenant:0},{key:'manager',role:'manager',tenant:0},
 {key:'operator',role:'operator',tenant:0},{key:'viewer',role:'viewer',tenant:0},
 {key:'foreign',role:'owner',tenant:1}
];
const date=new Date().toISOString().slice(0,10);
const plan={baselinePct:20,liftPp:10,margin:250,discount:5,fixed:100,fee:25000};
const protocol={startDate:date,endDate:date,outcomeWindowDays:1,
  allocation:'random',source:'pos',primaryMetric:'repeat_visit'};
const readiness=Object.fromEntries(['repeatDefinition','sameWindow','independentGroups',
  'marginVerified','contactConsent','ownerAgreed'].map(k=>[k,true]));
let app,staff={};
const send=(method,path,who,payload,headers={})=>app.inject({
 method,url:P+path,headers:{...(who?{cookie:who.cookie,'x-csrf-token':who.csrf}:{}),...headers},
 ...(payload===undefined?{}:{payload})
});
function expect(r,status){assert.equal(r.statusCode,status,r.body);return r.json()}
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function cookie(r){
 const pairs=[].concat(r.headers['set-cookie']||[]).map(s=>s.split(';')[0]);
 const csrf=pairs.find(x=>x.startsWith('osmanx_industry_csrf='));
 assert.ok(csrf);
 return {cookie:pairs.join('; '),csrf:csrf.slice(csrf.indexOf('=')+1)};
}
async function fresh(title){
 const p=expect(await send('POST','/guest/pilots',staff.owner,{title,plan,protocol}),201).item;
 const ready=expect(await send('PATCH','/guest/pilots/'+p.id+'/readiness',staff.owner,{
   expectedVersion:p.version,readiness
 }),200).item;
 return expect(await send('POST','/guest/pilots/'+p.id+'/start',staff.owner,{
   expectedVersion:ready.version
 }),200).item;
}
before(async()=>{
 for(const org of organizations){
  org.id=(await admin.query(
    "INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
    [org.slug,org.slug])).rows[0].id;
 }
 for(const p of users){
  p.email='r13-'+p.key+'-'+tag+'@example.test';
  p.id=(await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
    [p.email,await hashPassword(password)])).rows[0].id;
  await admin.query('INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',
    [organizations[p.tenant].id,p.id,p.role]);
 }
 app=await buildApp(db);
 for(const p of users){
  const r=await send('POST','/auth/login',null,{
   tenantSlug:organizations[p.tenant].slug,email:p.email,password
  });
  expect(r,200);staff[p.key]=cookie(r);
 }
});
after(async()=>{if(app)await app.close();await db.end();await admin.end();});

test('R13 emergency stop blocks all five aggregate mutation paths until independently released',async()=>{
 let pilot=await fresh('R13 isolated pause and resume');
 const id=pilot.id,base='/guest/pilots/'+id,check=base+'/safety';
 const initial=expect(await send('GET',check,staff.viewer),200);
 assert.equal(initial.guestCollectionPaused,false);
 assert.equal(initial.quality.schema,'osmanx.guest.quality.v1');
 assert.equal(initial.quality.flags[0].code,'NO_OBSERVATIONS');
 assert.equal((await send('GET',check,staff.foreign)).statusCode,404);
 assert.equal((await send('POST',check+'/hold',staff.viewer,
  {expectedVersion:pilot.version,reasonCode:'data_quality'})).statusCode,403);
 assert.equal((await send('POST',check+'/hold',staff.owner,
  {expectedVersion:pilot.version,reasonCode:'free text with guest name'})).statusCode,400);
 const held=expect(await send('POST',check+'/hold',staff.operator,
  {expectedVersion:pilot.version,reasonCode:'source_integrity'}),200);
 assert.equal(held.hold.active,true);
 assert.equal(held.hold.version,1);
 assert.equal(held.item.version,pilot.version+1);
 pilot=held.item;
 assert.equal((await send('POST',check+'/hold',staff.manager,{
  expectedVersion:pilot.version,reasonCode:'consent_review'})).statusCode,409);
 const paused=expect(await send('GET',check,staff.owner),200);
 assert.equal(paused.guestCollectionPaused,true);
 assert.equal(paused.hold.held_by,users[2].id);
 const observation={date,control:20,controlReturn:4,offer:20,offerReturn:6};
 const csv='date,control,controlReturn,offer,offerReturn\n'+date+',20,4,20,6\n';
 const attempts=[
  send('POST',base+'/observations',staff.operator,
    {expectedVersion:pilot.version,observation},{'Idempotency-Key':'r13-row-'+tag}),
  send('POST',base+'/observations/import/preview',staff.operator,
    {expectedVersion:pilot.version,csv}),
  send('POST',base+'/observations/import',staff.operator,
    {expectedVersion:pilot.version,csv,sha256:'b'.repeat(64)},{'Idempotency-Key':'r13-batch-'+tag}),
  send('POST',base+'/observations/'+randomUUID()+'/void',staff.manager,
    {expectedVersion:pilot.version}),
  send('POST',base+'/submit',staff.owner,{expectedVersion:pilot.version})
 ];
 const denied=await Promise.all(attempts);
 assert.deepEqual(denied.map(r=>r.statusCode),[409,409,409,409,409]);
 assert.equal((await send('POST',check+'/resume',staff.operator,
  {expectedVersion:pilot.version,acknowledge:true})).statusCode,403);
 assert.equal((await send('POST',check+'/resume',staff.manager,
  {expectedVersion:pilot.version,acknowledge:false})).statusCode,400);
 const resumed=expect(await send('POST',check+'/resume',staff.manager,
  {expectedVersion:pilot.version,acknowledge:true}),200);
 assert.equal(resumed.hold.active,false);
 assert.equal(resumed.hold.version,2);
 assert.equal(resumed.item.version,pilot.version+1);
 pilot=resumed.item;
 assert.equal((await send('POST',check+'/resume',staff.owner,
  {expectedVersion:pilot.version,acknowledge:true})).statusCode,409);
 const added=expect(await send('POST',base+'/observations',staff.operator,{
  expectedVersion:pilot.version,observation
 },{'Idempotency-Key':'r13-row-ok-'+tag}),201);
 assert.equal(added.version,pilot.version+1);
 const quality=expect(await send('GET',check,staff.viewer),200);
 assert.equal(quality.guestCollectionPaused,false);
 assert.equal(quality.quality.totals.control,20);
 assert.ok(quality.quality.flags.some(f=>f.code==='INSUFFICIENT_SAMPLE'));
 const exported=expect(await send('GET',check+'/export.json',staff.owner),200);
 assert.equal(exported.format,'osmanx.guest.safety.export.v1');
 assert.equal(exported.sha256,sha(exported.snapshot));
 assert.match(exported.snapshot.originalEvidenceSha256,/^[a-f0-9]{64}$/);
 assert.equal(exported.snapshot.holdEvents.length,2);
 assert.deepEqual(exported.snapshot.holdEvents.map(e=>e.event_type),['held','resumed']);
 assert.equal((await send('GET',check+'/export.json',staff.viewer)).statusCode,403);
 assert.equal((await send('GET',check+'/export.json',staff.foreign)).statusCode,404);
 const audit=expect(await send('GET','/audit',staff.owner),200);
 assert.ok(audit.items.some(x=>x.action==='guest.safety.held'));
 assert.ok(audit.items.some(x=>x.action==='guest.safety.resumed'));
 const foreign=await withTenant(db,organizations[1].id,async sql=>
  sql.query('SELECT pilot_id FROM industry.guest_pilot_hold_events WHERE tenant_id=$1',[organizations[0].id]));
 assert.equal(foreign.rowCount,0);
});
test('R13 same person cannot resume own stop and concurrent versions fail closed',async()=>{
 let p=await fresh('R13 independent release');
 const base='/guest/pilots/'+p.id+'/safety';
 p=expect(await send('POST',base+'/hold',staff.owner,{
  expectedVersion:p.version,reasonCode:'consent_review'
 }),200).item;
 assert.equal((await send('POST',base+'/resume',staff.owner,{
  expectedVersion:p.version,acknowledge:true
 })).statusCode,403);
 const completed=expect(await send('POST',base+'/resume',staff.manager,{
  expectedVersion:p.version,acknowledge:true
 }),200);
 assert.equal(completed.hold.resolved_by,users[1].id);
 assert.equal((await send('POST',base+'/hold',staff.owner,{
  expectedVersion:p.version,reasonCode:'data_quality'
 })).statusCode,409);
 const again=expect(await send('POST',base+'/hold',staff.owner,{
  expectedVersion:completed.item.version,reasonCode:'data_quality'
 }),200);
 assert.equal(again.hold.version,3);
 assert.equal((await send('POST',base+'/resume',staff.manager,{
  expectedVersion:completed.item.version,acknowledge:true
 })).statusCode,409);
});
test('R13 hold table and immutable events are protected by SQL roles and trigger',async()=>{
 const rows=await admin.query(
  "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=ANY(ARRAY['industry.guest_pilot_holds'::regclass,'industry.guest_pilot_hold_events'::regclass])"
 );
 assert.equal(rows.rowCount,2);
 assert.ok(rows.rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity));
 const priv=await admin.query(
  "SELECT has_table_privilege('industry_app','industry.guest_pilot_hold_events','SELECT') AS read,"+
  "has_table_privilege('industry_app','industry.guest_pilot_hold_events','INSERT') AS add,"+
  "has_table_privilege('industry_app','industry.guest_pilot_hold_events','UPDATE') AS change,"+
  "has_table_privilege('industry_app','industry.guest_pilot_hold_events','DELETE') AS del"
 );
 assert.deepEqual(Object.values(priv.rows[0]),[true,true,false,false]);
 const one=(await admin.query('SELECT id FROM industry.guest_pilot_hold_events WHERE tenant_id=$1 LIMIT 1',
  [organizations[0].id])).rows[0];
 assert.ok(one);
 const attempted=await admin.query(
  'UPDATE industry.guest_pilot_hold_events SET reason_code=$1 WHERE id=$2',
  ['data_quality',one.id]).then(()=>null,e=>e);
 assert.equal(attempted?.code,'23514');
});
