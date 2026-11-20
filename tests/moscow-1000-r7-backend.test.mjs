import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {commandRoute} from '../services/moscow-1000-api/command-center.mjs';
import {googleAuthRoute} from '../services/moscow-1000-api/auth-google.mjs';

const ORIGIN='https://osmanx.world';
const editor={email:'operator@example.org',editor:true,approver:false,moderator:false};
const viewer={email:'viewer@example.org',editor:false,approver:false,moderator:true};
const approver={email:'approver@example.org',editor:false,approver:true,moderator:false};
const contact={day:1,name:'КОФЕЙНЯ «ЁЛКА»',category:'Кофейня',person:'Иван',channel:'private@example.org',outcome:'interest',problem:'Нужен предзаказ',nextStep:'Отправить предложение'};
const expense={day:1,amountRub:182.45,category:'Транспорт',note:'Частная поездка'};

function database() {
  const raw=new DatabaseSync(':memory:');raw.exec('PRAGMA foreign_keys=ON');
  const dir=new URL('../services/moscow-1000-api/migrations/',import.meta.url);
  for (const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort()) raw.exec(readFileSync(new URL(name,dir),'utf8'));
  let tail=Promise.resolve();
  const make=(sql,args)=>({
    sql,
    async first(){return raw.prepare(sql).get(...args)||null;},
    async all(){return {results:raw.prepare(sql).all(...args)};},
    async run(){
      if (/^\s*SELECT\b/i.test(sql)) return {results:raw.prepare(sql).all(...args),meta:{changes:0}};
      const x=raw.prepare(sql).run(...args);return {results:[],meta:{changes:Number(x.changes)}};
    }
  });
  const db={raw,prepare(sql){return {...make(sql,[]),bind(...args){return make(sql,args);}};},async batch(statements){
    if (db.beforeBatch) await db.beforeBatch(statements);
    const result=tail.then(async()=>{
      raw.exec('BEGIN');try{const out=[];for(const statement of statements) out.push(await statement.run());raw.exec('COMMIT');return out;}catch(error){raw.exec('ROLLBACK');throw error;}
    });
    tail=result.catch(()=>{});return result;
  }};
  return db;
}
function request(path,{method='GET',body,key,origin=ORIGIN}={}) {
  return new Request(ORIGIN+'/moscow-1000/api'+path,{method,headers:{...(key!==undefined?{'Idempotency-Key':key}:{}),...(method==='GET'?{}:{Origin:origin,'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
const command=(db,path,{actor=editor,...options}={})=>commandRoute(request('/command'+path,options),{DB:db},actor);
const count=(db,table)=>db.raw.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
const revision=db=>db.raw.prepare('SELECT revision FROM command_state').get().revision;
const key='r7-test-request-0000000000000001';

test('R7 a lost create response can be retried without another contact, revision or audit event',async()=>{
  const db=database();
  const first=await command(db,'/contacts',{method:'POST',body:contact,key});assert.equal(first.status,201);
  const initial=await first.json();assert.equal(initial.idempotency_replayed,false);
  const before={revision:revision(db),audit:count(db,'operator_audit')};
  const repeated=await command(db,'/contacts',{method:'POST',body:contact,key});assert.equal(repeated.status,200);
  const replay=await repeated.json();assert.equal(replay.idempotency_replayed,true);assert.equal(replay.contact.id,initial.contact.id);
  assert.equal(count(db,'command_contacts'),1);assert.equal(count(db,'command_requests'),1);
  assert.deepEqual({revision:revision(db),audit:count(db,'operator_audit')},before);
  const receipt=JSON.stringify(db.raw.prepare('SELECT * FROM command_requests').all());
  assert.doesNotMatch(receipt,/private@example|КОФЕЙНЯ|Иван|Отправить|operator@example|r7-test-request/);
  db.raw.close();
});
test('R7 idempotent payload hashing ignores object order and insignificant trimmed optional values',async()=>{
  const db=database();
  const minimal={day:1,name:'Кофейня',outcome:'dialogue'};
  const initial=await (await command(db,'/contacts',{method:'POST',body:minimal,key})).json();
  const repeated=await command(db,'/contacts',{method:'POST',body:{outcome:'dialogue',name:'  Кофейня  ',day:1,category:'',channel:'',person:'',nextStep:'',problem:''},key});
  assert.equal(repeated.status,200);assert.equal((await repeated.json()).contact.id,initial.contact.id);assert.equal(revision(db),1);db.raw.close();
});
test('R7 a reused key with different payload returns a typed conflict and preserves the first record',async()=>{
  const db=database();await command(db,'/contacts',{method:'POST',body:contact,key});
  const repeated=await command(db,'/contacts',{method:'POST',body:{...contact,name:'Another business'},key});
  assert.equal(repeated.status,409);assert.equal((await repeated.json()).code,'idempotency_conflict');
  assert.equal(count(db,'command_contacts'),1);assert.equal(revision(db),1);assert.equal(db.raw.prepare('SELECT name FROM command_contacts').get().name,contact.name);db.raw.close();
});
test('R7 concurrent requests that both miss the receipt still commit exactly once',async()=>{
  for (const conflicting of [false,true]) {
    const db=database();let reached=0,release;
    const barrier=new Promise(resolve=>{release=resolve;});
    db.beforeBatch=async statements=>{
      if (!statements[0]?.sql.startsWith('INSERT OR IGNORE INTO command_requests')) return;
      if (++reached===2) release();
      await barrier;
    };
    const results=await Promise.all([
      command(db,'/contacts',{method:'POST',body:contact,key}),
      command(db,'/contacts',{method:'POST',body:{...contact,...(conflicting?{name:'Conflicting name'}:{})},key})
    ]);
    assert.equal(reached,2);assert.deepEqual(results.map(r=>r.status).sort(),conflicting?[201,409]:[200,201]);
    assert.equal(count(db,'command_contacts'),1);assert.equal(count(db,'command_requests'),1);assert.equal(count(db,'operator_audit'),1);assert.equal(revision(db),1);
    db.raw.close();
  }
});
test('R7 a failed audit rolls back record, receipt and revision, allowing the same key to succeed later',async()=>{
  const db=database();
  db.raw.exec("CREATE TRIGGER fail_r7_audit BEFORE INSERT ON operator_audit WHEN NEW.event='command_contact_created' BEGIN SELECT RAISE(ABORT,'simulated audit outage'); END");
  await assert.rejects(command(db,'/contacts',{method:'POST',body:contact,key}),/simulated audit outage/);
  assert.equal(count(db,'command_contacts'),0);assert.equal(count(db,'command_requests'),0);assert.equal(revision(db),0);
  db.raw.exec('DROP TRIGGER fail_r7_audit');assert.equal((await command(db,'/contacts',{method:'POST',body:contact,key})).status,201);db.raw.close();
});
test('R7 receipt scope separates actors and operation types without exposing another actor record',async()=>{
  const db=database();
  const one=await (await command(db,'/contacts',{method:'POST',body:contact,key})).json();
  const two=await (await command(db,'/contacts',{actor:{...editor,email:'other@example.org'},method:'POST',body:contact,key})).json();
  assert.notEqual(one.contact.id,two.contact.id);
  assert.equal((await command(db,'/expenses',{method:'POST',body:expense,key})).status,201);
  assert.equal(count(db,'command_requests'),3);assert.equal(revision(db),3);db.raw.close();
});
test('R7 removed contact is not resurrected by an old queued request; edits retain optimistic revisions',async()=>{
  const db=database(),initial=await (await command(db,'/contacts',{method:'POST',body:contact,key})).json();
  const id=initial.contact.id;
  assert.equal((await command(db,'/contacts/'+id,{method:'PATCH',body:{...contact,name:'Edited',expectedRevision:1}})).status,200);
  const replay=await (await command(db,'/contacts',{method:'POST',body:contact,key})).json();assert.equal(replay.contact.revision,2);assert.equal(replay.contact.name,'Edited');
  assert.equal((await command(db,'/contacts/'+id,{method:'PATCH',body:{...contact,expectedRevision:1}})).status,409);
  assert.equal((await command(db,'/contacts/'+id,{method:'DELETE',body:{expectedRevision:2}})).status,200);
  const before=revision(db),deleted=await command(db,'/contacts',{method:'POST',body:contact,key});assert.equal(deleted.status,410);assert.equal((await deleted.json()).code,'idempotency_target_removed');
  assert.equal(count(db,'command_contacts'),0);assert.equal(count(db,'command_requests'),1);assert.equal(revision(db),before);db.raw.close();
});
test('R7 expense retries preserve exact kopecks and deleted expenses stay deleted',async()=>{
  const db=database();
  const original=await (await command(db,'/expenses',{method:'POST',body:expense,key})).json();assert.equal(original.expense.amountRub,182.45);
  const replay=await command(db,'/expenses',{method:'POST',body:{note:expense.note,category:'  Транспорт ',day:1,amountRub:182.45},key});assert.equal(replay.status,200);assert.equal((await replay.json()).expense.id,original.expense.id);assert.equal(revision(db),1);
  assert.equal((await command(db,'/expenses',{method:'POST',body:{...expense,amountRub:182.46},key})).status,409);
  assert.equal((await command(db,'/expenses/'+original.expense.id,{method:'DELETE',body:{}})).status,200);
  assert.equal((await command(db,'/expenses',{method:'POST',body:expense,key})).status,410);assert.equal(count(db,'command_expenses'),0);db.raw.close();
});
test('R7 invalid keys, unauthorized actors and cross-origin requests never reserve or create data',async()=>{
  const db=database();
  for (const invalid of ['', 'short', 'x'.repeat(129), 'illegal key with spaces']) assert.equal((await command(db,'/contacts',{method:'POST',body:contact,key:invalid})).status,400);
  assert.equal((await command(db,'/contacts',{actor:null,method:'POST',body:contact,key})).status,401);
  assert.equal((await command(db,'/contacts',{actor:viewer,method:'POST',body:contact,key})).status,403);
  assert.equal((await command(db,'/contacts',{origin:'https://evil.example',method:'POST',body:contact,key})).status,403);
  assert.equal(count(db,'command_requests'),0);assert.equal(count(db,'command_contacts'),0);db.raw.close();
});
test('R7 missing receipt migration fails safely instead of dropping idempotency protection',async()=>{
  const db=database();db.raw.exec('DROP TABLE command_requests');
  const response=await command(db,'/contacts',{method:'POST',body:contact,key});assert.equal(response.status,503);assert.equal((await response.json()).code,'migration_required');
  assert.equal(count(db,'command_contacts'),0);assert.equal(revision(db),0);db.raw.close();
});
test('R7 contact search handles Russian case, literal SQL wildcard characters and every private searchable field',async()=>{
  const db=database();await command(db,'/contacts',{method:'POST',body:contact});
  await command(db,'/contacts',{method:'POST',body:{...contact,name:'100%_Original',category:'Retail',person:'Alice',channel:'different@example.org',problem:'Sizes',nextStep:'Discuss'}});
  for (const q of ['кофейня','ёлка','ИВАН','PRIVATE@EXAMPLE.ORG','ПРЕДЗАКАЗ','ОТПРАВИТЬ']) {
    const data=await (await command(db,'/contacts?q='+encodeURIComponent(q))).json();assert.equal(data.total,1,q);assert.equal(data.contacts[0].name,contact.name);
  }
  for (const q of ['%', '_', 'alice', 'RETAIL']) {const data=await (await command(db,'/contacts?q='+encodeURIComponent(q))).json();assert.equal(data.total,1,q);assert.equal(data.contacts[0].name,'100%_Original');}
  assert.equal((await (await command(db,"/contacts?q="+encodeURIComponent("' OR 1=1 --"))).json()).total,0);db.raw.close();
});
test('R7 combined day/outcome/follow-up filters and matching-result pagination return an accurate total',async()=>{
  const db=database();
  for (let i=0;i<28;i++) await command(db,'/contacts',{method:'POST',body:{...contact,name:'Совпадение '+i}});
  for (const change of [{day:2},{outcome:'refusal'},{outcome:'contract'},{nextStep:''}]) await command(db,'/contacts',{method:'POST',body:{...contact,...change}});
  const filter='/contacts?day=1&outcome=interest&followup=pending';
  const first=await (await command(db,filter)).json();assert.equal(first.total,28);assert.equal(first.contacts.length,25);assert.equal(first.nextOffset,25);
  const second=await (await command(db,filter+'&offset=25')).json();assert.equal(second.total,28);assert.equal(second.contacts.length,3);assert.equal(second.nextOffset,null);
  assert.equal(new Set([...first.contacts,...second.contacts].map(c=>c.id)).size,28);
  assert.equal((await (await command(db,'/contacts?day=1&followup=none')).json()).total,3);
  assert.equal((await (await command(db,'/contacts?followup=pending')).json()).total,29);
  for (const query of ['outcome=unknown','followup=overdue','q='+'x'.repeat(121),'day=0','offset=-1']) assert.equal((await command(db,'/contacts?'+query)).status,400);
  db.raw.close();
});
test('R7 public snapshots remain aggregate-only after searches and idempotent writes',async()=>{
  const db=database();
  await command(db,'/contacts',{method:'POST',body:contact,key});await command(db,'/contacts',{method:'POST',body:contact,key});
  assert.equal((await command(db,'/contacts?q=Иван',{actor:null})).status,401);
  await command(db,'/publish',{actor:approver,method:'POST',body:{confirm:true}});
  const response=await command(db,'/public',{actor:null}),text=await response.text(),data=JSON.parse(text);
  assert.equal(data.metrics.researched,1);assert.doesNotMatch(text,/private@example|Иван|КОФЕЙНЯ|command_requests|payload_hash|record_id|idempotency/);db.raw.close();
});
test('R7 Google setup diagnostics expose only booleans and the exact callback, without credentials or allowlist',async()=>{
  const db=database();
  const env={DB:db,SITE_ORIGIN:ORIGIN,GOOGLE_CLIENT_ID:'test-client.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'private-google-secret',AUTH_SESSION_SECRET:'private-session-secret-with-enough-characters',ADMIN_GOOGLE_EMAILS:'owner-secret@example.org'};
  const read=e=>googleAuthRoute(request('/auth/config'),e);
  const good=await read(env),text=await good.text(),data=JSON.parse(text);assert.equal(good.headers.get('Cache-Control'),'no-store');
  assert.equal(data.configured,true);assert.equal(data.setup.status,'ready');assert.equal(data.setup.callbackUrl,ORIGIN+'/moscow-1000/api/auth/google/callback');assert.deepEqual(data.setup.missing,[]);
  assert.doesNotMatch(text,/test-client|private-google-secret|private-session-secret|owner-secret/);
  const partial=await (await read({...env,GOOGLE_CLIENT_SECRET:''})).json();assert.equal(partial.googleEnabled,false);assert.equal(partial.setup.status,'needs_configuration');assert.deepEqual(partial.setup.missing,['googleClient']);
  db.raw.exec('DROP TABLE google_auth_flows');const unmigrated=await (await read(env)).json();assert.equal(unmigrated.configured,false);assert.equal(unmigrated.setup.status,'needs_migration');assert.deepEqual(unmigrated.setup.missing,['database']);
  assert.equal((await googleAuthRoute(request('/auth/google/start'),env)).status,503);assert.deepEqual(await (await googleAuthRoute(request('/auth/session'),env)).json(),{ok:true,authenticated:false});db.raw.close();
});
