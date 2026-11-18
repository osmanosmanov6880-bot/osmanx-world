// R12 real PostgreSQL acceptance: separately authenticated owner/manager, replay,
 // stale snapshots, irreversible enrollment and tenant-isolated append-only ledger.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {hashPassword} from '../src/password.mjs';
import {makePool,withTenant} from '../src/database.mjs';
import {buildApp} from '../src/app.mjs';

const tag=randomUUID().slice(0,8),P='/api/industry/v1',pass='R12-Synthetic-Unique-Password-2026!';
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL}),db=makePool();
const orgs=[{slug:'r12-a-'+tag},{slug:'r12-b-'+tag}];
const people=[
 {key:'owner',role:'owner',org:0},{key:'manager',role:'manager',org:0},
 {key:'operator',role:'operator',org:0},{key:'viewer',role:'viewer',org:0},
 {key:'foreign',role:'owner',org:1}
];
const future=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
const protocol=()=>({startDate:future(2),endDate:future(11),outcomeWindowDays:1,
  allocation:'random',source:'pos',primaryMetric:'repeat_visit'});
const plan={baselinePct:20,liftPp:10,margin:250,discount:5,fixed:100,fee:25000};
const readiness=Object.fromEntries(['repeatDefinition','sameWindow','independentGroups',
  'marginVerified','contactConsent','ownerAgreed'].map(x=>[x,true]));
const sha=o=>createHash('sha256').update(JSON.stringify(o)).digest('hex');
let app,staff={};
const send=(method,path,who,payload,headers={})=>app.inject({
  method,url:P+path,headers:{...(who?{cookie:who.cookie,'x-csrf-token':who.csrf}:{}),...headers},
  ...(payload===undefined?{}:{payload})
});
const ok=(r,status)=>{assert.equal(r.statusCode,status,r.body);return r.json()};
function session(r){
  const c=[].concat(r.headers['set-cookie']||[]).map(x=>x.split(';')[0]);
  const token=c.find(x=>x.startsWith('osmanx_industry_csrf='));
  assert.ok(token);
  return {cookie:c.join('; '),csrf:token.slice(token.indexOf('=')+1)};
}
async function pilot(title){
  let item=ok(await send('POST','/guest/pilots',staff.owner,
    {title,plan,protocol:protocol()}),201).item;
  item=ok(await send('PATCH','/guest/pilots/'+item.id+'/readiness',staff.owner,
    {expectedVersion:item.version,readiness}),200).item;
  return item;
}
async function enroll(item){
  return ok(await send('POST','/guest/pilots/'+item.id+'/launch/enroll',staff.owner,
    {expectedVersion:item.version,confirm:true}),200);
}
async function attest(item,who,key){
  return send('POST','/guest/pilots/'+item.id+'/launch/attest',staff[who],
    {expectedVersion:item.version,acknowledge:true},
    {'idempotency-key':'r12-'+key+'-'+tag});
}
before(async()=>{
  for(const o of orgs)
    o.id=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
      [o.slug,o.slug])).rows[0].id;
  for(const p of people){
    p.email='r12-'+p.key+'-'+tag+'@example.test';
    p.id=(await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [p.email,await hashPassword(pass)])).rows[0].id;
    await admin.query('INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',
      [orgs[p.org].id,p.id,p.role]);
  }
  app=await buildApp(db);
  for(const p of people){
    const r=await send('POST','/auth/login',null,
      {tenantSlug:orgs[p.org].slug,email:p.email,password:pass});
    ok(r,200);staff[p.key]=session(r);
  }
});
after(async()=>{if(app)await app.close();await db.end();await admin.end();});

test('R12 real HTTP: deliberate enrollment, objective checks, independent 14-day approvals, start enforcement and evidence',async()=>{
  let item=await pilot('R12 two human launch');
  const id=item.id,path='/guest/pilots/'+id+'/launch';
  const initial=ok(await send('GET',path+'/gate',staff.viewer),200);
  assert.equal(initial.enrolled,false);
  assert.equal(initial.canStartIsolatedPilot,false);
  assert.ok(initial.blockers.some(x=>x.code==='enrolled'));
  assert.equal((await send('GET',path+'/gate',staff.foreign)).statusCode,404);
  assert.equal((await send('POST',path+'/enroll',staff.viewer,
    {expectedVersion:item.version,confirm:true})).statusCode,403);
  assert.equal((await send('POST',path+'/enroll',staff.manager,
    {expectedVersion:item.version,confirm:true})).statusCode,403);
  assert.equal((await send('POST',path+'/enroll',staff.owner,
    {expectedVersion:item.version,confirm:false})).statusCode,400);
  const enrolled=await enroll(item);
  item=enrolled.item;
  assert.equal(item.version,3);
  assert.ok(item.launchGateEnrolledAt);
  assert.equal(enrolled.gate.checks.ownerSigned,false);
  assert.equal((await send('POST',path+'/enroll',staff.owner,
    {expectedVersion:item.version,confirm:true})).statusCode,409);
  assert.equal((await send('POST','/guest/pilots/'+id+'/start',staff.owner,
    {expectedVersion:item.version})).statusCode,409,'No bypass via legacy start');
  assert.equal((await attest(item,'operator','role')).statusCode,403);
  assert.equal((await attest(item,'viewer','role-viewer')).statusCode,403);
  assert.equal((await attest(item,'foreign','foreign')).statusCode,404);
  const sign1=ok(await attest(item,'owner','first'),201);
  assert.equal(sign1.gate.canStartIsolatedPilot,false);
  assert.equal(sign1.gate.attestations.owner.current,true);
  const replay=ok(await attest(item,'owner','first'),200);
  assert.equal(replay.duplicate,true);
  assert.equal(replay.attestationId,sign1.attestationId);
  assert.equal((await attest(item,'owner','new-duplicate')).statusCode,409);
  assert.equal((await send('POST','/guest/pilots/'+id+'/start',staff.owner,
    {expectedVersion:item.version})).statusCode,409,'Cannot start with one signoff');
  const sign2=ok(await attest(item,'manager','second'),201);
  assert.equal(sign2.gate.canStartIsolatedPilot,true);
  assert.equal(sign2.gate.customerProductionAuthorized,false);
  assert.notEqual(sign2.gate.attestations.owner.actorId,sign2.gate.attestations.manager.actorId);
  const packet=ok(await send('GET',path+'/evidence.json',staff.manager),200);
  assert.equal(packet.format,'osmanx.guest.launch.export.v1');
  assert.equal(packet.sha256,sha(packet.snapshot));
  assert.match(packet.snapshot.originalEvidenceSha256,/^[a-f0-9]{64}$/);
  assert.equal(packet.snapshot.attestations.length,2);
  assert.equal((await send('GET',path+'/evidence.json',staff.viewer)).statusCode,403);
  assert.equal((await send('GET',path+'/evidence.json',staff.foreign)).statusCode,404);
  const started=ok(await send('POST','/guest/pilots/'+id+'/start',staff.owner,
    {expectedVersion:item.version}),200).item;
  assert.equal(started.phase,'running');
  assert.equal((await attest(item,'manager','after-start')).statusCode,409);
  const audit=ok(await send('GET','/audit',staff.owner),200);
  assert.ok(audit.items.some(x=>x.action==='guest.launch.enrolled'));
  assert.ok(audit.items.some(x=>x.action==='guest.launch.attested'));
});

test('R12 snapshot version flips invalidate old attestations even when readiness returns to all true',async()=>{
  let item=await pilot('R12 readiness mutation invalidation');
  item=(await enroll(item)).item;
  const path='/guest/pilots/'+item.id+'/launch';
  ok(await attest(item,'owner','before-change-owner'),201);
  ok(await attest(item,'manager','before-change-manager'),201);
  assert.equal(ok(await send('GET',path+'/gate',staff.owner),200).canStartIsolatedPilot,true);
  item=ok(await send('PATCH','/guest/pilots/'+item.id+'/readiness',staff.owner,
    {expectedVersion:item.version,readiness:{...readiness,marginVerified:false}}),200).item;
  item=ok(await send('PATCH','/guest/pilots/'+item.id+'/readiness',staff.owner,
    {expectedVersion:item.version,readiness}),200).item;
  const stale=ok(await send('GET',path+'/gate',staff.manager),200);
  assert.equal(stale.canStartIsolatedPilot,false);
  assert.equal(stale.checks.sixReadiness,true);
  assert.equal(stale.checks.ownerSigned,false);
  assert.equal((await send('POST','/guest/pilots/'+item.id+'/start',staff.owner,
    {expectedVersion:item.version})).statusCode,409);
  ok(await attest(item,'owner','updated-owner'),201);
  ok(await attest(item,'manager','updated-manager'),201);
  assert.equal(ok(await send('GET',path+'/gate',staff.manager),200).canStartIsolatedPilot,true);
  assert.equal((await send('GET',path+'/evidence.json',staff.owner)).json().snapshot.attestations.length,4);
});

test('R12 revoking manager role invalidates approval without deleting audit trail',async()=>{
  let item=await pilot('R12 member revoke gate');
  item=(await enroll(item)).item;
  ok(await attest(item,'owner','revocation-owner'),201);
  ok(await attest(item,'manager','revocation-manager'),201);
  await admin.query(
    'DELETE FROM industry.memberships WHERE tenant_id=$1 AND account_id=$2',
    [orgs[0].id,people[1].id]);
  const gate=ok(await send('GET','/guest/pilots/'+item.id+'/launch/gate',staff.owner),200);
  assert.equal(gate.checks.managerPresent,false);
  assert.equal(gate.checks.managerSigned,false);
  assert.equal(gate.canStartIsolatedPilot,false);
  assert.equal((await send('POST','/guest/pilots/'+item.id+'/start',staff.owner,
    {expectedVersion:item.version})).statusCode,409);
  const history=ok(await send('GET','/guest/pilots/'+item.id+'/launch/evidence.json',staff.owner),200);
  assert.equal(history.snapshot.attestations.length,2);
  assert.equal((await send('GET','/guest/pilots/'+item.id+'/launch/gate',staff.manager)).statusCode,403);
});

test('R12 SQL immutability, RLS and runtime least privilege hold across two tenants',async()=>{
  const row=(await admin.query(
    "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='industry.guest_launch_attestations'::regclass"
  )).rows[0];
  assert.equal(row.relrowsecurity,true);
  assert.equal(row.relforcerowsecurity,true);
  const perms=(await admin.query(
    "SELECT has_table_privilege('industry_app','industry.guest_launch_attestations','SELECT') AS can_read,"+
    "has_table_privilege('industry_app','industry.guest_launch_attestations','INSERT') AS can_write,"+
    "has_table_privilege('industry_app','industry.guest_launch_attestations','UPDATE') AS can_update,"+
    "has_table_privilege('industry_app','industry.guest_launch_attestations','DELETE') AS can_delete"
  )).rows[0];
  assert.deepEqual(Object.values(perms),[true,true,false,false]);
  const history=(await admin.query(
    'SELECT id,tenant_id,pilot_id FROM industry.guest_launch_attestations WHERE tenant_id=$1 LIMIT 1',
    [orgs[0].id])).rows[0];
  assert.ok(history);
  const violation=await admin.query(
    'UPDATE industry.guest_launch_attestations SET role=$1 WHERE id=$2',
    ['operator',history.id]).then(()=>null,e=>e);
  assert.equal(violation?.code,'23514');
  const foreign=await withTenant(db,orgs[1].id,async client=>
    client.query('SELECT id FROM industry.guest_launch_attestations WHERE tenant_id=$1',
      [orgs[0].id]));
  assert.equal(foreign.rowCount,0);
});
