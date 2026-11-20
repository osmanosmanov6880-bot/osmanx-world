import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {generateKeyPairSync,createSign} from 'node:crypto';
import worker from '../services/moscow-1000-api/index.mjs';
import {googleAuthRoute,verifyGoogleIdToken,verifiedGoogleActor,resetGoogleKeyCacheForTests} from '../services/moscow-1000-api/auth-google.mjs';
import {commandRoute} from '../services/moscow-1000-api/command-center.mjs';

const ORIGIN='https://osmanx.world';
const ROOT=ORIGIN+'/moscow-1000/api';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'google-r6-test',alg:'RS256',use:'sig'};
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const editor={email:'editor@example.org',editor:true,approver:false,moderator:false};
const approver={email:'approver@example.org',editor:false,approver:true,moderator:false};
function database() {
  const raw=new DatabaseSync(':memory:');raw.exec('PRAGMA foreign_keys=ON');
  const dir=new URL('../services/moscow-1000-api/migrations/',import.meta.url);
  for (const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort()) raw.exec(readFileSync(new URL(name,dir),'utf8'));
  const make=(sql,args)=>({
    async first(){return raw.prepare(sql).get(...args)||null;},
    async all(){return {results:raw.prepare(sql).all(...args)};},
    async run(){if (/^\s*SELECT\b/i.test(sql)) return {results:raw.prepare(sql).all(...args),meta:{changes:0}};const x=raw.prepare(sql).run(...args);return {results:[],meta:{changes:Number(x.changes)}};}
  });
  return {raw,prepare(sql){return {...make(sql,[]),bind(...args){return make(sql,args);}};},async batch(statements){raw.exec('BEGIN');try{const out=[];for(const statement of statements) out.push(await statement.run());raw.exec('COMMIT');return out;}catch(error){raw.exec('ROLLBACK');throw error;}}};
}
function env(db) { return {DB:db,SITE_ORIGIN:ORIGIN,GOOGLE_CLIENT_ID:'unit-test.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'unit-test-client-secret',AUTH_SESSION_SECRET:'unit-test-signing-secret-with-64-characters-0123456789',ADMIN_GOOGLE_EMAILS:'owner@example.org',REQUIRE_TWO_PERSON_REVIEW:'true'}; }
function token(nonce,overrides={}) {
  const instant=Math.floor(Date.now()/1000);
  const head=encode({alg:'RS256',kid:jwk.kid});
  const body=encode({iss:'https://accounts.google.com',aud:'unit-test.apps.googleusercontent.com',sub:'google-user-123',email:'owner@example.org',email_verified:true,hd:'example.org',iat:instant,exp:instant+3600,nonce,...overrides});
  return head+'.'+body+'.'+createSign('RSA-SHA256').update(head+'.'+body).sign(privateKey).toString('base64url');
}
const request=(path,{method='GET',body,cookie,origin=ORIGIN}={})=>new Request(ROOT+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method==='GET'?{}:{Origin:origin,'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
const cookieValue=(response,name)=>response.headers.getSetCookie().find(c=>c.startsWith(name+'='))?.split(';')[0];
async function login(e,tokenOverrides={}) {
  resetGoogleKeyCacheForTests();
  const start=await googleAuthRoute(request('/auth/google/start'),e);
  assert.equal(start.status,303);
  const target=new URL(start.headers.get('Location'));
  const cookie=cookieValue(start,'__Host-osmanx-oauth');
  const callback='/auth/google/callback?state='+encodeURIComponent(target.searchParams.get('state'))+'&code=valid-code';
  let exchanges=0;
  const fetcher=async(url,options)=>{
    if (String(url)==='https://www.googleapis.com/oauth2/v3/certs') return Response.json({keys:[jwk]});
    assert.equal(String(url),'https://oauth2.googleapis.com/token');
    exchanges++;
    const body=new URLSearchParams(options.body);
    const flow=e.DB.raw.prepare('SELECT verifier,nonce FROM google_auth_flows').get();
    assert.equal(body.get('code_verifier'),flow.verifier);
    assert.equal(body.get('redirect_uri'),ROOT+'/auth/google/callback');
    return Response.json({id_token:token(flow.nonce,tokenOverrides),access_token:'never-expose-to-browser'});
  };
  const response=await googleAuthRoute(request(callback,{cookie}),e,fetcher);
  return {response,session:cookieValue(response,'__Host-osmanx-admin'),flowCookie:cookie,callback,fetcher,exchanges:()=>exchanges,target,start};
}

test('R6 Google login stays unavailable without credentials or migration and never fabricates a session',async()=>{
  const e={SITE_ORIGIN:ORIGIN};
  const conf=await googleAuthRoute(request('/auth/config'),e);assert.equal((await conf.json()).googleEnabled,false);
  assert.equal((await googleAuthRoute(request('/auth/google/start'),e)).status,503);
  assert.deepEqual(await (await googleAuthRoute(request('/auth/session'),e)).json(),{ok:true,authenticated:false});
});
test('R6 real OIDC protocol creates PKCE challenge, consumes state once and returns an HttpOnly server session',async()=>{
  const db=database(),e=env(db);const x=await login(e);
  assert.equal(x.target.origin,'https://accounts.google.com');assert.equal(x.target.searchParams.get('code_challenge_method'),'S256');assert.equal(x.target.searchParams.get('scope'),'openid email');
  assert.equal(x.response.headers.get('Location'),'/moscow-1000/admin/');
  assert.match(x.start.headers.get('Set-Cookie'),/Secure; HttpOnly; SameSite=Lax/);
  assert.match(x.response.headers.getSetCookie().find(c=>c.startsWith('__Host-osmanx-admin=')),/Max-Age=7200/);
  assert.ok(x.session);assert.ok(!x.session.includes('owner@example.org'));assert.ok(!x.session.includes('never-expose'));
  const actor=await verifiedGoogleActor(request('/auth/session',{cookie:x.session}),e);assert.equal(actor.email,'owner@example.org');assert.equal(actor.provider,'google');
  const replay=await googleAuthRoute(request(x.callback,{cookie:x.flowCookie}),e,x.fetcher);assert.match(replay.headers.get('Location'),/auth_error=expired/);assert.equal(x.exchanges(),1);
  db.raw.close();
});
test('R6 foreign browser/wrong state cannot redeem a valid Google callback',async()=>{
  const db=database(),e=env(db),start=await googleAuthRoute(request('/auth/google/start'),e),target=new URL(start.headers.get('Location'));
  const noNetwork=async()=>{throw Error('Must not contact provider');};
  const missing=await googleAuthRoute(request('/auth/google/callback?state='+target.searchParams.get('state')+'&code=valid'),e,noNetwork);
  assert.match(missing.headers.get('Location'),/auth_error=expired/);
  const wrong=await googleAuthRoute(request('/auth/google/callback?state='+'A'.repeat(43)+'&code=valid',{cookie:cookieValue(start,'__Host-osmanx-oauth')}),e,noNetwork);
  assert.match(wrong.headers.get('Location'),/auth_error=expired/);assert.equal(db.raw.prepare('SELECT consumed_at FROM google_auth_flows').get().consumed_at,null);db.raw.close();
});
test('R6 identity validation rejects forged signature, audience, expiry, nonce, unverified email and non-admin account',async()=>{
  resetGoogleKeyCacheForTests();const db=database(),e=env(db),nonce='N'.repeat(43),fetcher=async()=>Response.json({keys:[jwk]});
  assert.equal((await verifyGoogleIdToken(token(nonce),e,nonce,fetcher)).email,'owner@example.org');
  for (const overrides of [{aud:'other-client'},{iss:'https://evil.example'},{exp:1},{nonce:'wrong'},{email_verified:false},{email:'stranger@example.org'},{azp:'other-client'},{hd:undefined},{hd:''}]) await assert.rejects(verifyGoogleIdToken(token(nonce,overrides),e,nonce,fetcher));
  assert.equal((await verifyGoogleIdToken(token(nonce,{email:'owner@gmail.com',hd:undefined}),{...e,ADMIN_GOOGLE_EMAILS:'owner@gmail.com'},nonce,fetcher)).email,'owner@gmail.com');
  const forged=token(nonce).split('.');forged[1]=encode({...JSON.parse(Buffer.from(forged[1],'base64url')),sub:'attacker'});await assert.rejects(verifyGoogleIdToken(forged.join('.'),e,nonce,fetcher));db.raw.close();
});
test('R6 logout revokes server session; altered cookies and removed allowlist entries cannot authenticate',async()=>{
  const db=database(),e=env(db),x=await login(e);
  assert.equal(await verifiedGoogleActor(request('/auth/session',{cookie:x.session+'x'}),e),null);
  assert.equal(await verifiedGoogleActor(request('/auth/session',{cookie:x.session}),{...e,ADMIN_GOOGLE_EMAILS:'someone-else@example.org'}),null);
  const blocked=await googleAuthRoute(request('/auth/logout',{method:'POST',body:{},cookie:x.session,origin:'https://evil.example'}),e);assert.equal(blocked.status,403);
  assert.ok(await verifiedGoogleActor(request('/auth/session',{cookie:x.session}),e));
  const out=await googleAuthRoute(request('/auth/logout',{method:'POST',body:{},cookie:x.session}),e);assert.equal(out.status,200);assert.equal(await verifiedGoogleActor(request('/auth/session',{cookie:x.session}),e),null);db.raw.close();
});
test('R6 worker integrates Google sessions into existing admin routes and denies anonymous CRM access',async()=>{
  const db=database(),e=env(db),x=await login(e);
  assert.equal((await worker.fetch(request('/command/contacts'),e)).status,401);
  const allowed=await worker.fetch(request('/admin/session',{cookie:x.session}),e);assert.equal(allowed.status,200);assert.equal((await allowed.json()).actor.email,'owner@example.org');db.raw.close();
});
const contact={day:1,name:'Test company',category:'HoReCa',person:'Private Person',channel:'private@example.org',outcome:'meeting',problem:'Private conversation details',nextStep:'Call after approval'};
const command=(e,path,{actor=editor,method='GET',body,origin=ORIGIN}={})=>commandRoute(request('/command'+path,{method,body,origin}),e,actor);
test('R6 private CRM CRUD persists data, prevents stale edits and validates mutation origin',async()=>{
  const db=database(),e=env(db);
  assert.equal((await command(e,'/contacts',{method:'POST',body:contact,origin:'https://evil.example'})).status,403);
  const created=await command(e,'/contacts',{method:'POST',body:contact});assert.equal(created.status,201);const saved=(await created.json()).contact;assert.equal(saved.revision,1);
  const edited=await command(e,'/contacts/'+saved.id,{method:'PATCH',body:{...contact,name:'Updated company',expectedRevision:1}});assert.equal(edited.status,200);assert.equal((await edited.json()).contact.revision,2);
  assert.equal((await command(e,'/contacts/'+saved.id,{method:'PATCH',body:{...contact,name:'Stale edit',expectedRevision:1}})).status,409);
  assert.equal((await command(e,'/contacts/'+saved.id,{method:'DELETE',body:{expectedRevision:1}})).status,409);
  assert.equal((await (await command(e,'/contacts?day=1')).json()).contacts[0].name,'Updated company');
  assert.equal((await command(e,'/contacts/'+saved.id,{method:'DELETE',body:{expectedRevision:2}})).status,200);
  assert.equal((await (await command(e,'/contacts')).json()).contacts.length,0);db.raw.close();
});
test('R6 CRM refuses unknown fields, invalid outcomes and excessive bodies without writing',async()=>{
  const db=database(),e=env(db);
  for (const input of [{...contact,day:11},{...contact,outcome:'admin'},{...contact,html:'<script>'},{...contact,name:''},{...contact,problem:'x'.repeat(9000)}]) assert.equal((await command(e,'/contacts',{method:'POST',body:input})).status,400);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM command_contacts').get().n,0);db.raw.close();
});
test('R6 money and quest writes validate cents and official quest IDs',async()=>{
  const db=database(),e=env(db);
  for (const amountRub of [-1,0,1.001,1000001]) assert.equal((await command(e,'/expenses',{method:'POST',body:{day:1,amountRub,category:'Transport',note:''}})).status,400);
  const added=await command(e,'/expenses',{method:'POST',body:{day:1,amountRub:182.45,category:'Transport',note:'Private taxi receipt'}});assert.equal(added.status,201);assert.equal((await added.json()).expense.amountRub,182.45);
  assert.equal((await command(e,'/quests',{method:'PUT',body:{day:1,questId:'d1-q6',completed:true}})).status,400);
  assert.equal((await command(e,'/quests',{method:'PUT',body:{day:1,questId:'d2-q1',completed:true}})).status,400);
  assert.equal((await command(e,'/quests',{method:'PUT',body:{day:1,questId:'d1-q1',completed:true}})).status,200);db.raw.close();
});
test('R6 public snapshot is explicit, aggregate-only, immutable until republished and supports safe withdrawal',async()=>{
  const db=database(),e=env(db);
  const initial=await (await command(e,'/public',{actor:null})).json();assert.equal(initial.metrics,null);assert.equal(initial.status,'unpublished');
  await command(e,'/contacts',{method:'POST',body:contact});
  await command(e,'/expenses',{method:'POST',body:{day:1,amountRub:182.45,category:'Transport',note:'Private taxi receipt'}});
  await command(e,'/quests',{method:'PUT',body:{day:1,questId:'d1-q2',completed:true}});
  assert.equal((await command(e,'/publish',{method:'POST',body:{confirm:true}})).status,403);
  assert.equal((await command(e,'/publish',{actor:{...editor,approver:true},method:'POST',body:{confirm:true}})).status,403);
  const published=await command(e,'/publish',{actor:approver,method:'POST',body:{confirm:true}});assert.equal(published.status,200,await published.clone().text());
  const data=await (await command(e,'/public',{actor:null})).json();
  assert.equal(data.status,'published');assert.equal(data.metrics.researched,1);assert.equal(data.metrics.dialogues,1);assert.equal(data.metrics.meetings,1);assert.equal(data.metrics.expensesRub,182.45);assert.equal(data.metrics.xp,200);
  assert.doesNotMatch(JSON.stringify(data),/private@example|Private Person|Private conversation|Private taxi|Test company|updated_by|reviewed_by/);
  await command(e,'/contacts',{method:'POST',body:{...contact,day:2}});assert.equal((await (await command(e,'/public')).json()).metrics.researched,1);
  assert.equal((await command(e,'/unpublish',{actor:approver,method:'POST',body:{}})).status,200);assert.equal((await (await command(e,'/public')).json()).status,'unpublished');
  await command(e,'/publish',{actor:approver,method:'POST',body:{confirm:true}});assert.equal((await (await command(e,'/public')).json()).version,3);db.raw.close();
});
test('R6 public reads reconstruct whitelist fields and fail closed on corrupted metrics',async()=>{
  const db=database(),e=env(db);await command(e,'/publish',{actor:approver,method:'POST',body:{confirm:true}});
  const row=db.raw.prepare('SELECT document_json FROM command_public').get(),payload=JSON.parse(row.document_json);payload.email='private@example.org';payload.metrics.privateContact='secret';
  db.raw.prepare('UPDATE command_public SET document_json=?').run(JSON.stringify(payload));assert.doesNotMatch(await (await command(e,'/public')).text(),/private@example|privateContact|secret/);
  payload.metrics.researched='secret';db.raw.prepare('UPDATE command_public SET document_json=?').run(JSON.stringify(payload));assert.equal((await command(e,'/public')).status,503);db.raw.close();
});
test('R6 withdrawal fences an in-flight publish even when no previous publication exists',async()=>{
  for (const existing of [false,true]) {
    const db=database(),e=env(db);
    await command(e,'/contacts',{method:'POST',body:contact});
    if (existing) await command(e,'/publish',{actor:approver,method:'POST',body:{confirm:true}});
    const auditBefore=db.raw.prepare("SELECT COUNT(*) AS n FROM operator_audit WHERE event='command_aggregates_published'").get().n;
    const originalBatch=db.batch.bind(db);
    let withdrawBeforeCommit=true;
    db.batch=async statements=>{
      const result=await originalBatch(statements);
      if (withdrawBeforeCommit&&statements.length===5&&result[0].results?.[0]?.revision!==undefined) {
        withdrawBeforeCommit=false;
        assert.equal((await command(e,'/unpublish',{actor:approver,method:'POST',body:{}})).status,200);
      }
      return result;
    };
    const stale=await command(e,'/publish',{actor:approver,method:'POST',body:{confirm:true}});
    assert.equal(stale.status,409);assert.equal(withdrawBeforeCommit,false);
    assert.equal((await (await command(e,'/public')).json()).status,'unpublished');
    assert.equal(db.raw.prepare('SELECT version FROM command_public').get().version,existing?2:1);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM operator_audit WHERE event='command_aggregates_published'").get().n,auditBefore);
    db.raw.close();
  }
});
test('R6 failed publication audit rolls back the entire snapshot transaction',async()=>{
  for (const existing of [false,true]) {
    const db=database(),e=env(db);
    if (existing) await command(e,'/publish',{actor:approver,method:'POST',body:{confirm:true}});
    const before=db.raw.prepare('SELECT * FROM command_public').get()||null;
    await command(e,'/contacts',{method:'POST',body:contact});
    db.raw.exec("CREATE TRIGGER fail_publication_audit BEFORE INSERT ON operator_audit WHEN NEW.event='command_aggregates_published' BEGIN SELECT RAISE(ABORT,'forced audit outage'); END");
    await assert.rejects(command(e,'/publish',{actor:approver,method:'POST',body:{confirm:true}}),/forced audit outage/);
    assert.deepEqual(db.raw.prepare('SELECT * FROM command_public').get()||null,before);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM operator_audit WHERE event='command_aggregates_published'").get().n,existing?1:0);
    db.raw.close();
  }
});
test('R6 contact problem accepts normal multiline notes but still rejects other controls',async()=>{
  const db=database(),e=env(db),problem='Первая строка\nВторая строка\r\nТретья строка';
  const created=await command(e,'/contacts',{method:'POST',body:{...contact,problem}});assert.equal(created.status,201);assert.equal((await created.json()).contact.problem,problem);
  assert.equal((await command(e,'/contacts',{method:'POST',body:{...contact,problem:'bad\u0000note'}})).status,400);db.raw.close();
});
