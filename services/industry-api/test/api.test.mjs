import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID, createHmac } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { hashPassword, sha256 } from '../src/password.mjs';
import { buildApp } from '../src/app.mjs';
import { makePool, withTenant } from '../src/database.mjs';

const P='/api/industry/v1';
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
const db=makePool(process.env.DATABASE_URL);
const password='IntegrationTest-Passw0rd!2026';
const stamp=randomUUID().slice(0,8);
const tenants=[{slug:'test-a-'+stamp,vertical:'auto',email:'testa'+stamp+'@example.test'}, {slug:'test-b-'+stamp,vertical:'dental',email:'testb'+stamp+'@example.test'}];
let app,viewerEmail='viewer'+stamp+'@example.test', operatorEmail='operator'+stamp+'@example.test';
let loginA,loginB,loginViewer,loginOperator;
const json=r=>r.json();
function cookieSet(response){
  const lines=[].concat(response.headers['set-cookie']||[]);
  const cookie=lines.map(s=>s.split(';')[0]).join('; ');
  const csrfLine=lines.map(s=>s.split(';')[0]).find(s=>s.includes('osmanx_industry_csrf='))||'';
  return {cookie,csrf:csrfLine.slice(csrfLine.indexOf('=')+1)};
}
function req(method,url,session,payload,headers={}){
  return app.inject({method,url:P+url,headers:{
    ...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),
    ...headers
  },...(payload?{payload}: {})});
}
async function newAccount(email){
  const r=await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',[email,await hashPassword(password)]);
  return r.rows[0].id;
}
before(async()=>{
  for(let i=0;i<2;i++){
    const ten=tenants[i];
    ten.id=(await admin.query('INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,$3) RETURNING id',[ten.slug,'Acceptance '+ten.slug,ten.vertical])).rows[0].id;
    ten.ownerId=await newAccount(ten.email);
    await admin.query("INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner')",[ten.id,ten.ownerId]);
    ten.resourceId=(await admin.query("INSERT INTO industry.resources(tenant_id,name) VALUES($1,'Календарь 1') RETURNING id",[ten.id])).rows[0].id;
  }
  const viewerId=await newAccount(viewerEmail),operatorId=await newAccount(operatorEmail);
  await admin.query("INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'viewer')",[tenants[0].id,viewerId]);
  await admin.query("INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'operator')",[tenants[0].id,operatorId]);
  app=await buildApp(db);
});
after(async()=>{if(app)await app.close();await db.end();await admin.end()});
async function login(tenant,email){
  const response=await req('POST','/auth/login',null,{tenantSlug:tenant.slug,email,password});
  assert.equal(response.statusCode,200,response.body);
  return cookieSet(response);
}
test('Block 1+2: authentication, CSRF, RLS tenant separation and role enforcement',async()=>{
  const noAuth=await req('GET','/customers');
  assert.equal(noAuth.statusCode,401);
  const bad=await req('POST','/auth/login',null,{tenantSlug:tenants[0].slug,email:tenants[0].email,password:'wrong-password'});
  assert.equal(bad.statusCode,401);
  loginA=await login(tenants[0],tenants[0].email);
  loginB=await login(tenants[1],tenants[1].email);
  loginViewer=await login(tenants[0],viewerEmail);
  loginOperator=await login(tenants[0],operatorEmail);
  const me=await req('GET','/auth/me',loginA);
  assert.equal(me.statusCode,200,me.body);
  assert.equal(json(me).tenant.id,tenants[0].id);
  const cross=await req('POST','/auth/login',null,{tenantSlug:tenants[1].slug,email:tenants[0].email,password});
  assert.equal(cross.statusCode,401);
  const csrf=await app.inject({method:'POST',url:P+'/customers',headers:{cookie:loginA.cookie},payload:{displayName:'No CSRF'}});
  assert.equal(csrf.statusCode,403);
  const denied=await req('POST','/customers',loginViewer,{displayName:'Not permitted'});
  assert.equal(denied.statusCode,403);
  const deniedManage=await req('POST','/services',loginOperator,{name:'Denied',durationMinutes:30,priceMinor:1000});
  assert.equal(deniedManage.statusCode,403);
  const fromOtherTenant=await withTenant(db,tenants[0].id,async(client)=>{
    const rows=await client.query('SELECT id FROM industry.tenants WHERE id=$1',[tenants[1].id]);
    return rows.rows;
  });
  assert.equal(fromOtherTenant.length,0,'RLS must deny cross-tenant rows');
  const withoutTenant=await db.query('SELECT id FROM industry.tenants');
  assert.equal(withoutTenant.rows.length,0,'Queries without transaction tenant context must see no tenants');
});
test('Block 3: transactional booking, idempotency, no overlap, audit and outbox',async()=>{
  const customer=await req('POST','/customers',loginA,{displayName:'Тестовый клиент'});
  assert.equal(customer.statusCode,201,customer.body);
  const customerId=json(customer).item.id;
  const createdByOperator=await req('POST','/customers',loginOperator,{displayName:'Операторский клиент'});
  assert.equal(createdByOperator.statusCode,201,createdByOperator.body);
  const service=await req('POST','/services',loginA,{name:'Диагностика',durationMinutes:60,priceMinor:290000});
  assert.equal(service.statusCode,201,service.body);
  const serviceId=json(service).item.id;
  const bTenant=await req('GET','/customers',loginB);
  assert.equal(bTenant.statusCode,200);
  assert.equal(json(bTenant).items.length,0,'Company B must not read Company A customers');
  const start=new Date(Date.now()+4*24*3600*1000).toISOString();
  const payload={customerId,serviceId,resourceId:tenants[0].resourceId,startsAt:start};
  const headers={'idempotency-key':'acceptance-booking-001'};
  const created=await req('POST','/appointments',loginA,payload,headers);
  assert.equal(created.statusCode,201,created.body);
  const apptId=json(created).item.id;
  const duplicate=await req('POST','/appointments',loginA,payload,headers);
  assert.equal(duplicate.statusCode,200,duplicate.body);
  assert.equal(json(duplicate).duplicate,true);
  assert.equal(json(duplicate).item.id,apptId);
  const changedPayload=await req('POST','/appointments',loginA,{...payload,startsAt:new Date(new Date(start).getTime()+3600000).toISOString()},headers);
  assert.equal(changedPayload.statusCode,409,'One idempotency key cannot represent different bookings');
  const overlap=await req('POST','/appointments',loginA,payload,{'idempotency-key':'acceptance-booking-002'});
  assert.equal(overlap.statusCode,409,overlap.body);
  const other=await req('POST','/appointments',loginB,payload,{'idempotency-key':'acceptance-booking-other'});
  assert.equal(other.statusCode,404,'A service from another tenant must be invisible');
  const confirm=await req('PATCH','/appointments/'+apptId+'/status',loginA,{status:'confirmed'});
  assert.equal(confirm.statusCode,200,confirm.body);
  const done=await req('PATCH','/appointments/'+apptId+'/status',loginA,{status:'done'});
  assert.equal(done.statusCode,200,done.body);
  const revert=await req('PATCH','/appointments/'+apptId+'/status',loginA,{status:'new'});
  assert.equal(revert.statusCode,409);
  const stats=await req('GET','/dashboard',loginA);
  assert.equal(stats.statusCode,200);
  assert.equal(json(stats).stats.completed_appointments,1);
  const audit=await req('GET','/audit',loginA);
  assert.equal(audit.statusCode,200);
  assert.ok(json(audit).items.some(x=>x.action==='appointment.created'));
  const viewAudit=await req('GET','/audit',loginViewer);
  assert.equal(viewAudit.statusCode,403);
  const rows=await withTenant(db,tenants[0].id,async client=>(await client.query('SELECT kind FROM industry.outbox WHERE tenant_id=$1',[tenants[0].id])).rows);
  assert.ok(rows.some(x=>x.kind==='appointment.created'));
  const rls=await withTenant(db,tenants[1].id,async client=>(await client.query('SELECT * FROM industry.customers WHERE tenant_id=$1',[tenants[0].id])).rows);
  assert.equal(rls.length,0);
});
test('Block 4: authenticated signed outbox delivery to configured receiver',async()=>{
  const messages=[];
  const secret='test-webhook-signature-secret-2026-strong';
  const receiver=http.createServer((request,response)=>{
    let body='';
    request.on('data',chunk=>body+=chunk);
    request.on('end',()=>{
      const stamp=request.headers['x-osmanx-timestamp'];
      const expected='sha256='+createHmac('sha256',secret).update(stamp+'.'+body).digest('hex');
      assert.equal(request.headers['x-osmanx-signature'],expected);
      messages.push(JSON.parse(body));
      response.writeHead(204);response.end();
    });
  });
  await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+receiver.address().port+'/events';
  try{
    const result=await new Promise((resolve,reject)=>{
      const cp=spawn(process.execPath,['src/worker.mjs','--once'],{
        cwd:new URL('../',import.meta.url),env:{...process.env,NODE_ENV:'test',WEBHOOK_URL:url,WEBHOOK_HMAC_KEY:secret}
      });
      let stderr='';
      cp.stderr.on('data',d=>stderr+=d.toString());
      cp.on('error',reject);
      cp.on('close',code=>resolve({code,stderr}));
    });
    assert.equal(result.code,0,result.stderr);
    assert.ok(messages.length>=1);
    assert.ok(messages.some(x=>x.kind==='appointment.created'));
    assert.ok(messages.every(x=>x.tenantId&&x.id));
    const delivered=await admin.query("SELECT count(*)::int AS n FROM industry.outbox WHERE tenant_id=$1 AND delivered_at IS NOT NULL",[tenants[0].id]);
    assert.ok(delivered.rows[0].n>0);
  }finally{await new Promise(resolve=>receiver.close(resolve))}
});
test('Session logout invalidates cookie',async()=>{
  const r=await req('POST','/auth/logout',loginB);
  assert.equal(r.statusCode,200,r.body);
  assert.equal((await req('GET','/auth/me',loginB)).statusCode,401);
});
