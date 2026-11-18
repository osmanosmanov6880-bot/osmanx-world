// Guest R9 full PostgreSQL acceptance: tenant privacy, actions and atomic CSV imports.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {hashPassword} from '../src/password.mjs';
import {makePool,withTenant} from '../src/database.mjs';
import {buildApp} from '../src/app.mjs';

const db=makePool(process.env.DATABASE_URL);
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
const P='/api/industry/v1',tag=randomUUID().slice(0,8);
const pass='OSMANX-R9-Synthetic-Password-2026!';
const people=[
  {slug:'r9-team-a-'+tag,email:'r9-owner-'+tag+'@example.test',role:'owner'},
  {slug:'r9-team-a-'+tag,email:'r9-manager-'+tag+'@example.test',role:'manager'},
  {slug:'r9-team-a-'+tag,email:'r9-operator-'+tag+'@example.test',role:'operator'},
  {slug:'r9-team-a-'+tag,email:'r9-other-operator-'+tag+'@example.test',role:'operator'},
  {slug:'r9-team-a-'+tag,email:'r9-viewer-'+tag+'@example.test',role:'viewer'},
  {slug:'r9-team-b-'+tag,email:'r9-foreign-'+tag+'@example.test',role:'owner'}
];
const protocol={
  startDate:'2026-11-01',endDate:'2026-11-16',outcomeWindowDays:1,
  allocation:'matched',source:'manual',primaryMetric:'repeat_visit'
};
const plan={baselinePct:20,liftPp:10,margin:250,discount:5,fixed:100,fee:25000};
const CSV='date,control,controlReturn,offer,offerReturn\n'+
  '2026-11-09,900,180,700,210\n2026-11-10,900,180,700,210\n';
const otherCSV='date,control,controlReturn,offer,offerReturn\n'+
  '2026-11-11,500,100,200,20\n';
const secondCSV='date,control,controlReturn,offer,offerReturn\n'+
  '2026-11-12,400,80,300,90\n';
const due=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
let app,tenantA,tenantB,staff;
const send=(method,url,who,payload,headers={})=>app.inject({
  method,url:P+url,
  headers:{...(who?{cookie:who.cookie,'x-csrf-token':who.csrf}:{}),...headers},
  ...(payload===undefined?{}:{payload})
});
function check(res,status){assert.equal(res.statusCode,status,res.body);return res.json();}
function sess(res){
  const values=[].concat(res.headers['set-cookie']||[]).map(x=>x.split(';')[0]);
  const csrf=values.find(s=>s.startsWith('osmanx_industry_csrf='))||'';
  return {cookie:values.join('; '),csrf:csrf.slice(csrf.indexOf('=')+1)};
}
before(async()=>{
  for(const [slug,name] of [[people[0].slug,'R9 Team A'],[people.at(-1).slug,'R9 Team B']]){
    const id=(await admin.query(
      "INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
      [slug,name])).rows[0].id;
    if(slug===people[0].slug)tenantA=id;else tenantB=id;
  }
  for(const p of people){
    p.account=(await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [p.email,await hashPassword(pass)])).rows[0].id;
    await admin.query('INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',
      [p.slug===people[0].slug?tenantA:tenantB,p.account,p.role]);
  }
  app=await buildApp(db);
  staff={};
  for(const p of people){
    const response=await send('POST','/auth/login',null,{tenantSlug:p.slug,email:p.email,password:pass});
    check(response,200);staff[p.role==='owner'&&p.slug===people[0].slug?'owner':
      p.role==='owner'?'foreign':p.role==='operator'&&p.email.includes('other-')?'operator2':p.role]=sess(response);
  }
});
after(async()=>{if(app)await app.close();await db.end();await admin.end();});

test('R9 real API: explainable diagnostic, recommended action, secure assignment, atomic batch, RLS and audit',async()=>{
  let pilot=check(await send('POST','/guest/pilots',staff.owner,{
    title:'R9 diagnostics and batch test',plan,protocol
  }),201).item;
  const id=pilot.id;
  const empty=check(await send('GET','/guest/pilots/'+id+'/diagnostics',staff.viewer),200);
  assert.equal(empty.diagnostic.disposition,'NO_DATA');
  assert.equal(empty.diagnostic.recommendations[0].code,'COLLECT_OBSERVATIONS');
  assert.equal((await send('GET','/guest/pilots/'+id+'/diagnostics',staff.foreign)).statusCode,404);
  const dueLater=new Date(Date.now()+200*86400000).toISOString().slice(0,10);
  const actionBase={expectedPilotVersion:pilot.version,code:'COLLECT_OBSERVATIONS',
    assigneeId:people[2].account,dueDate:due};
  assert.equal((await send('POST','/guest/pilots/'+id+'/actions',staff.viewer,actionBase)).statusCode,403);
  assert.equal((await send('POST','/guest/pilots/'+id+'/actions',staff.owner,
    {...actionBase,code:'HACKED_CODE'})).statusCode,400);
  assert.equal((await send('POST','/guest/pilots/'+id+'/actions',staff.owner,
    {...actionBase,assigneeId:people[5].account})).statusCode,400);
  assert.equal((await send('POST','/guest/pilots/'+id+'/actions',staff.owner,
    {...actionBase,assigneeId:people[4].account})).statusCode,400);
  assert.equal((await send('POST','/guest/pilots/'+id+'/actions',staff.owner,
    {...actionBase,dueDate:dueLater})).statusCode,400);
  let action=check(await send('POST','/guest/pilots/'+id+'/actions',staff.owner,actionBase),201).item;
  assert.equal(action.status,'open');assert.equal(action.version,1);
  assert.equal((await send('POST','/guest/pilots/'+id+'/actions',staff.owner,actionBase)).statusCode,409);
  assert.equal((await send('GET','/guest/pilots/'+id+'/actions',staff.foreign)).statusCode,404);
  assert.equal((await send('PATCH','/guest/pilots/'+id+'/actions/'+action.id,staff.operator2,
    {expectedVersion:1,status:'in_progress'})).statusCode,403);
  assert.equal((await send('PATCH','/guest/pilots/'+id+'/actions/'+action.id,staff.viewer,
    {expectedVersion:1,status:'in_progress'})).statusCode,403);
  action=check(await send('PATCH','/guest/pilots/'+id+'/actions/'+action.id,staff.operator,
    {expectedVersion:1,status:'in_progress'}),200).item;
  assert.equal(action.version,2);
  assert.equal((await send('PATCH','/guest/pilots/'+id+'/actions/'+action.id,staff.operator,
    {expectedVersion:1,status:'done'})).statusCode,409);
  action=check(await send('PATCH','/guest/pilots/'+id+'/actions/'+action.id,staff.operator,
    {expectedVersion:2,status:'done'}),200).item;
  assert.equal(action.status,'done');
  assert.equal((await send('PATCH','/guest/pilots/'+id+'/actions/'+action.id,staff.manager,
    {expectedVersion:3,status:'in_progress'})).statusCode,409);

  const readiness=Object.fromEntries(['repeatDefinition','sameWindow','independentGroups',
    'marginVerified','contactConsent','ownerAgreed'].map(x=>[x,true]));
  pilot=check(await send('PATCH','/guest/pilots/'+id+'/readiness',staff.owner,{
    expectedVersion:pilot.version,readiness
  }),200).item;
  pilot=check(await send('POST','/guest/pilots/'+id+'/start',staff.owner,{
    expectedVersion:pilot.version
  }),200).item;
  const url='/guest/pilots/'+id+'/observations/import';
  const malformed='date,control,controlReturn,offer,offerReturn\n2026-11-09,3,5,2,1\n';
  assert.equal((await send('POST',url+'/preview',staff.owner,{
    expectedVersion:pilot.version,csv:malformed
  })).statusCode,400);
  const preview=check(await send('POST',url+'/preview',staff.operator,{
    expectedVersion:pilot.version,csv:CSV
  }),200);
  assert.equal(preview.summary.rowCount,2);
  assert.equal(preview.summary.totals.control,1800);
  assert.equal(preview.expectedVersion,pilot.version);
  assert.match(preview.sha256,/^[a-f0-9]{64}$/);
  assert.equal((await send('POST',url+'/preview',staff.foreign,{
    expectedVersion:pilot.version,csv:CSV
  })).statusCode,404);
  assert.equal((await send('POST',url,staff.owner,{
    expectedVersion:pilot.version,csv:CSV,sha256:'0'.repeat(64)
  },{'idempotency-key':'r9-bad-digest-'+tag})).statusCode,409);
  const idempotency={'idempotency-key':'r9-import-01-'+tag};
  const committed=check(await send('POST',url,staff.operator,{
    expectedVersion:pilot.version,csv:CSV,sha256:preview.sha256
  },idempotency),201);
  assert.equal(committed.rowsImported,2);
  assert.equal(committed.version,pilot.version+1);
  assert.equal(committed.sha256,preview.sha256);
  const replay=check(await send('POST',url,staff.operator,{
    expectedVersion:pilot.version,csv:CSV,sha256:preview.sha256
  },idempotency),200);
  assert.equal(replay.duplicate,true);assert.equal(replay.importId,committed.importId);
  assert.equal((await send('POST',url,staff.operator,{
    expectedVersion:pilot.version,csv:otherCSV,sha256:preview.sha256
  },idempotency)).statusCode,409);
  assert.equal(check(await send('GET','/guest/pilots/'+id+'/observations/imports',staff.viewer),200).items.length,1);
  assert.equal((await send('POST',url+'/preview',staff.owner,{
    expectedVersion:committed.version,csv:CSV
  })).statusCode,409,'Already active dates are rejected');
  const detail=check(await send('GET','/guest/pilots/'+id,staff.owner),200);
  assert.equal(detail.observations.length,2);
  const diagnostic=check(await send('GET','/guest/pilots/'+id+'/diagnostics',staff.owner),200);
  assert.equal(diagnostic.diagnostic.sample.control,1800);
  assert.ok(diagnostic.diagnostic.recommendations.some(r=>r.code==='VERIFY_GROUP_ASSIGNMENT'));
  assert.ok(diagnostic.diagnostic.recommendations.some(r=>r.code==='CHECK_GROUP_BALANCE'));
  assert.ok(diagnostic.diagnostic.recommendations.some(r=>r.code==='VALIDATE_SOURCE'));
  assert.ok(diagnostic.diagnostic.recommendations.some(r=>r.code==='REGISTER_FUTURE_PROTOCOL'));
  assert.equal((await send('POST','/guest/pilots/'+id+'/actions',staff.owner,
    {...actionBase,code:'MISSING_UNRECOMMENDED_CODE',expectedPilotVersion:committed.version})).statusCode,400);
  const balance=check(await send('POST','/guest/pilots/'+id+'/actions',staff.manager,
    {...actionBase,code:'CHECK_GROUP_BALANCE',expectedPilotVersion:committed.version}),201);
  assert.ok(balance.item.id);
  const beforeHash=check(await send('GET','/guest/pilots/'+id+'/report',staff.owner),200).evidenceDigest;
  assert.ok((await send('GET','/guest/pilots/'+id+'/actions',staff.owner)).json().items.length>=2);
  assert.equal(check(await send('GET','/guest/pilots/'+id+'/report',staff.owner),200).evidenceDigest,beforeHash,
    'Task workflow cannot change submitted evidence');
  const audit=check(await send('GET','/audit',staff.owner),200);
  assert.ok(audit.items.some(x=>x.action==='guest.observations.batch_imported'));
  assert.ok(audit.items.some(x=>x.action==='guest.action.done'));

  const first=(await send('POST',url+'/preview',staff.owner,{
    expectedVersion:committed.version,csv:otherCSV
  })).json();
  const second=(await send('POST',url+'/preview',staff.owner,{
    expectedVersion:committed.version,csv:secondCSV
  })).json();
  assert.match(first.sha256,/^[a-f0-9]{64}$/);
  assert.match(second.sha256,/^[a-f0-9]{64}$/);
  const attempts=await Promise.all([
    send('POST',url,staff.owner,{expectedVersion:committed.version,csv:otherCSV,sha256:first.sha256},
      {'idempotency-key':'r9-race-1-'+tag}),
    send('POST',url,staff.owner,{expectedVersion:committed.version,csv:secondCSV,sha256:second.sha256},
      {'idempotency-key':'r9-race-2-'+tag})
  ]);
  assert.deepEqual(attempts.map(r=>r.statusCode).sort((a,b)=>a-b),[201,409]);
  assert.equal(check(await send('GET','/guest/pilots/'+id,staff.owner),200).observations.length,3);
});

test('R9 PostgreSQL permissions and RLS: no global access to action or import ledgers',async()=>{
  const tables=await admin.query(
    "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('industry.guest_actions'::regclass,'industry.guest_bulk_imports'::regclass)");
  assert.equal(tables.rowCount,2);
  assert.ok(tables.rows.every(x=>x.relrowsecurity&&x.relforcerowsecurity));
  const grants=await admin.query(
    "SELECT has_table_privilege('industry_app','industry.guest_actions','DELETE') AS can_delete_actions,"+
    "has_table_privilege('industry_app','industry.guest_bulk_imports','UPDATE') AS can_rewrite_imports");
  assert.equal(grants.rows[0].can_delete_actions,false);
  assert.equal(grants.rows[0].can_rewrite_imports,false);
  const foreign=await withTenant(db,tenantB,async client=>
    client.query('SELECT id FROM industry.guest_actions WHERE tenant_id=$1',[tenantA]));
  assert.equal(foreign.rowCount,0);
});
