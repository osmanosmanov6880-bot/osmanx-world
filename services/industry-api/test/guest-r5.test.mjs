import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {hashPassword} from '../src/password.mjs';
import {buildApp} from '../src/app.mjs';
import {makePool,withTenant} from '../src/database.mjs';

const P='/api/industry/v1',G='/guest';
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
const db=makePool(process.env.DATABASE_URL);
const tag=randomUUID().slice(0,8);
const password='R5-Acceptance-Strong-Pass-2026';
const invitedPassword='Invited-R5-Manager-Pass-2026';
const tenant={slug:'r5-guest-'+tag,email:'r5-owner-'+tag+'@example.test'};
const stranger={slug:'r5-other-'+tag,email:'r5-other-'+tag+'@example.test'};
const invitedEmail='r5-manager-'+tag+'@example.test';
const plan={baselinePct:20,liftPp:10,margin:350,discount:12,fixed:1000,fee:25000};
const readiness={repeatDefinition:true,sameWindow:true,independentGroups:true,marginVerified:true,
  contactConsent:true,ownerAgreed:true};
const period={date:'2026-11-09',control:900,controlReturn:180,offer:900,offerReturn:270};
let app,owner,manager,other,managerId;
const parse=r=>r.json();
const assertCode=(r,status)=>{assert.equal(r.statusCode,status,r.body);return parse(r);};
function cookies(res){
  const set=[].concat(res.headers['set-cookie']||[]);
  const pair=set.map(v=>v.split(';')[0]);
  const cs=pair.find(v=>v.startsWith('osmanx_industry_csrf='))||'';
  return {cookie:pair.join('; '),csrf:cs.slice(cs.indexOf('=')+1)};
}
const call=(method,path,session,payload,headers={})=>app.inject({
  method,url:P+path,
  headers:{...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),...headers},
  ...(payload!==undefined?{payload}:{})
});
async function login(slug,email,pass){
  const r=await call('POST','/auth/login',null,{tenantSlug:slug,email,password:pass});
  assertCode(r,200);return cookies(r);
}
before(async()=>{
  for(const t of [tenant,stranger]){
    const r=await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
      [t.slug,'Synthetic R5 '+t.slug]);
    t.id=r.rows[0].id;
    const u=await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [t.email,await hashPassword(password)]);
    t.accountId=u.rows[0].id;
    await admin.query("INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner')",[t.id,t.accountId]);
  }
  app=await buildApp(db);
  owner=await login(tenant.slug,tenant.email,password);
  other=await login(stranger.slug,stranger.email,password);
});
after(async()=>{if(app)await app.close();await db.end();await admin.end();});

test('R5 synthetic acceptance: secure second person, full pilot, proof and immutable archive',async()=>{
  const staffBefore=assertCode(await call('GET','/staff',owner),200);
  assert.equal(staffBefore.members.length,1);
  const invite=assertCode(await call('POST','/staff/invitations',owner,{
    email:invitedEmail,role:'manager'
  }),201);
  assert.match(invite.token,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(assertCode(await call('GET','/staff',owner),200)).includes(invite.token),false);
  assert.equal((await call('POST','/staff/invitations/accept',null,{
    token:invite.token.toUpperCase(),password:invitedPassword
  })).statusCode,400,'Token format is deliberately lowercase-only');
  assertCode(await call('POST','/staff/invitations/accept',null,{
    token:invite.token,password:invitedPassword
  }),200);
  assert.equal((await call('POST','/staff/invitations/accept',null,{
    token:invite.token,password:invitedPassword
  })).statusCode,404,'Invitation is single-use');
  manager=await login(tenant.slug,invitedEmail,invitedPassword);
  const ownerInfo=assertCode(await call('GET','/auth/me',owner),200);
  const managerInfo=assertCode(await call('GET','/auth/me',manager),200);
  assert.notEqual(managerInfo.account.id,ownerInfo.account.id,'Reviewer must be a distinct real session');
  managerId=managerInfo.account.id;
  assert.equal(managerInfo.role,'manager');
  assert.equal((await call('POST','/staff/invitations',manager,{
    email:'elevate-'+tag+'@example.test',role:'manager'
  })).statusCode,403,'Manager cannot create another manager');
  const noCsrf=await app.inject({method:'POST',url:P+G+'/requests',
    headers:{cookie:owner.cookie,'idempotency-key':'r5-no-csrf-'+tag},
    payload:{title:'CSRF forbidden lead',source:'site'}});
  assert.equal(noCsrf.statusCode,403);
  const lead=assertCode(await call('POST',G+'/requests',owner,{
    title:'Реалистичный пилот повторных посещений',source:'field'
  },{'idempotency-key':'r5-intake-'+tag}),201).item;
  assert.equal((await call('GET',G+'/requests',other)).statusCode,200);
  assert.equal(parse(await call('GET',G+'/requests',other)).items.length,0);
  assert.equal((await call('PATCH',G+'/requests/'+lead.id,other,{state:'qualified'})).statusCode,404);
  assertCode(await call('PATCH',G+'/requests/'+lead.id,manager,{state:'qualified'}),200);
  let pilot=assertCode(await call('POST',G+'/pilots',owner,{
    title:'R5 synthetic paid-pilot scenario — no real money',plan,requestId:lead.id
  }),201).item;
  const pilotId=pilot.id;
  assert.equal(pilot.phase,'draft');
  const ready=assertCode(await call('PATCH',G+'/pilots/'+pilotId+'/readiness',manager,{
    expectedVersion:pilot.version,readiness
  }),200);
  pilot=ready.item;
  assert.equal(ready.ready,true);
  pilot=assertCode(await call('POST',G+'/pilots/'+pilotId+'/start',owner,{
    expectedVersion:pilot.version
  }),200).item;
  assert.equal(pilot.phase,'running');
  const write=assertCode(await call('POST',G+'/pilots/'+pilotId+'/observations',owner,{
    expectedVersion:pilot.version,observation:period
  },{'idempotency-key':'r5-period-'+tag}),201);
  pilot.version=write.version;
  assert.equal((await call('GET',G+'/pilots/'+pilotId+'/evidence.json',other)).statusCode,404);
  const interim=assertCode(await call('GET',G+'/pilots/'+pilotId+'/report',owner),200);
  assert.equal(interim.analysis.enough,true);
  assert.equal(interim.analysis.associationOnly,true);
  assert.equal(interim.analysis.disposition,'ПРОМЕЖУТОЧНО');
  const submitted=assertCode(await call('POST',G+'/pilots/'+pilotId+'/submit',owner,{
    expectedVersion:pilot.version
  }),200);
  pilot=submitted.item;
  assert.equal((await call('POST',G+'/pilots/'+pilotId+'/review',owner,{
    expectedVersion:pilot.version,decision:'accept_for_discussion',evidenceDigest:submitted.evidenceDigest
  })).statusCode,403,'Self-review is forbidden');
  const accepted=assertCode(await call('POST',G+'/pilots/'+pilotId+'/review',manager,{
    expectedVersion:pilot.version,decision:'accept_for_discussion',evidenceDigest:submitted.evidenceDigest
  }),200);
  pilot=accepted.item;assert.equal(pilot.phase,'reviewed');
  const evidence=assertCode(await call('GET',G+'/pilots/'+pilotId+'/evidence.json',manager),200);
  assert.equal(evidence.format,'osmanx.guest.evidence.export.v1');
  assert.equal(evidence.phase,'reviewed');
  assert.equal(evidence.review.actor_id,managerId);
  assert.equal(evidence.review.decision,'accept_for_discussion');
  assert.equal(evidence.evidence.observations.length,1);
  const independentlyHashed=createHash('sha256').update(JSON.stringify(evidence.evidence)).digest('hex');
  assert.equal(evidence.sha256,independentlyHashed);
  assert.equal(evidence.sha256,submitted.evidenceDigest);
  assert.equal(evidence.review.evidence_digest,evidence.sha256);
  assert.equal((await call('POST',G+'/pilots/'+pilotId+'/archive',manager,{
    expectedVersion:pilot.version,reason:'Only owner is allowed'
  })).statusCode,403);
  assert.equal((await call('POST',G+'/pilots/'+pilotId+'/archive',owner,{
    expectedVersion:pilot.version,reason:'x'
  })).statusCode,400);
  const archived=assertCode(await call('POST',G+'/pilots/'+pilotId+'/archive',owner,{
    expectedVersion:pilot.version,reason:'Пилот проверен и завершён'
  }),200);
  pilot=archived.item;
  assert.equal(pilot.phase,'archived');
  assert.equal(archived.sha256,evidence.sha256);
  assert.equal(pilot.archivedBy,tenant.accountId);
  assert.ok(pilot.archivedAt);
  const sealed=assertCode(await call('GET',G+'/pilots/'+pilotId+'/evidence.json',manager),200);
  assert.equal(sealed.phase,'archived');
  assert.equal(sealed.sha256,evidence.sha256);
  assert.equal(sealed.review.evidence_digest,evidence.sha256);
  assert.equal((await call('POST',G+'/pilots/'+pilotId+'/archive',owner,{
    expectedVersion:pilot.version,reason:'Do not archive twice'
  })).statusCode,409);
  assert.equal((await call('POST',G+'/pilots/'+pilotId+'/observations',owner,{
    expectedVersion:pilot.version,observation:{...period,date:'2026-11-16'}
  },{'idempotency-key':'r5-after-archive-'+tag})).statusCode,409);
  assert.equal((await call('POST',G+'/pilots/'+pilotId+'/resume',owner,{
    expectedVersion:pilot.version
  })).statusCode,409);
  assert.equal((await call('GET',G+'/pilots/'+pilotId+'/evidence.json',other)).statusCode,404);
  const full=assertCode(await call('GET',G+'/pilots/'+pilotId,owner),200);
  assert.equal(full.reviews.length,1);
  assert.equal(full.observations.length,1);
  const audit=assertCode(await call('GET','/audit',owner),200);
  assert.ok(audit.items.some(x=>x.action==='guest.pilot.archived'));
  assert.ok(audit.items.some(x=>x.action==='guest.pilot.reviewed'));
  // Distinct session revocation must not erase archived proof.
  const removed=assertCode(await call('DELETE','/staff/'+managerId,owner),200);
  assert.equal(removed.removed,true);
  assert.equal((await call('GET','/auth/me',manager)).statusCode,401);
  assert.equal((await call('GET',G+'/pilots/'+pilotId+'/evidence.json',manager)).statusCode,401);
  assert.equal((await call('GET',G+'/pilots/'+pilotId+'/evidence.json',owner)).statusCode,200);
  const cross=await withTenant(db,stranger.id,async client=>
    client.query('SELECT id FROM industry.guest_pilots WHERE tenant_id=$1',[tenant.id]));
  assert.equal(cross.rowCount,0);
});

test('R5 schema safety: archive columns are constrained and RLS protected',async()=>{
  const q=await admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='industry.guest_pilots'::regclass");
  assert.equal(q.rows[0].relrowsecurity,true);
  assert.equal(q.rows[0].relforcerowsecurity,true);
  const p=await admin.query("SELECT conname FROM pg_constraint WHERE conrelid='industry.guest_pilots'::regclass AND conname='guest_archival_consistency'");
  assert.equal(p.rowCount,1);
  const bad=await admin.query("SELECT 1 FROM industry.guest_pilots WHERE phase='archived' AND (archived_at IS NULL OR archived_by IS NULL)");
  assert.equal(bad.rowCount,0);
});
