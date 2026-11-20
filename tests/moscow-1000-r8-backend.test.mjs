import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import worker from '../services/moscow-1000-api/index.mjs';
import {commandRoute} from '../services/moscow-1000-api/command-center.mjs';
import {csvCell,EXPORT_ROW_LIMIT,EXPORT_BYTE_LIMIT} from '../services/moscow-1000-api/command-export.mjs';

const ORIGIN='https://osmanx.world';
const editor={email:'operator@example.org',editor:true,approver:false,moderator:false};
const moderator={email:'moderator@example.org',editor:false,approver:false,moderator:true};
const approver={email:'approver@example.org',editor:false,approver:true,moderator:false};
const expense={day:1,amountRub:12.45,category:'transport',note:'Тестовый расход'};
const contact={day:1,name:'Тестовый контакт',category:'Кофейня',person:'Частное имя',channel:'private@example.org',outcome:'interest',problem:'Строка 1\nСтрока 2',nextStep:'Проверить предложение'};
function database({r8=true}={}) {
  const raw=new DatabaseSync(':memory:');raw.exec('PRAGMA foreign_keys=ON');
  const dir=new URL('../services/moscow-1000-api/migrations/',import.meta.url);
  for (const name of readdirSync(dir).filter(n=>n.endsWith('.sql')&&(r8||!n.startsWith('0007_'))).sort()) raw.exec(readFileSync(new URL(name,dir),'utf8'));
  let tail=Promise.resolve();
  const make=(sql,args)=>({sql,args,
    async first(){return raw.prepare(sql).get(...args)||null;},
    async all(){return {results:raw.prepare(sql).all(...args)};},
    async run(){if (/^\s*SELECT\b/i.test(sql)) return {results:raw.prepare(sql).all(...args),meta:{changes:0}};const result=raw.prepare(sql).run(...args);return {results:[],meta:{changes:Number(result.changes)}};}
  });
  const db={raw,prepare(sql){return {...make(sql,[]),bind(...args){return make(sql,args);}};},async batch(statements){
    if (db.beforeBatch) await db.beforeBatch(statements);
    const pending=tail.then(async()=>{raw.exec('BEGIN');try{const results=[];for (const statement of statements) results.push(await statement.run());raw.exec('COMMIT');return results;}catch(error){raw.exec('ROLLBACK');throw error;}});
    tail=pending.catch(()=>{});const result=await pending;
    if (db.afterBatch) await db.afterBatch(statements,result);
    return result;
  }};return db;
}
function request(path,{method='GET',body,headers={},origin=ORIGIN}={}) {
  return new Request(ORIGIN+'/moscow-1000/api/command'+path,{method,headers:{...(method==='GET'?{}:{Origin:origin,'Content-Type':'application/json'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
const command=(db,path,{actor=editor,...options}={})=>commandRoute(request(path,options),{DB:db},actor);
const createExpense=async(db,value=expense)=>(await (await command(db,'/expenses',{method:'POST',body:value})).json()).expense;
const revision=db=>db.raw.prepare('SELECT revision FROM command_state WHERE slot=1').get().revision;
const auditCount=db=>db.raw.prepare('SELECT COUNT(*) AS n FROM operator_audit').get().n;
function insertExpenses(db,count,{day=1,category='transport',amountKopecks=101}={}) {
  const insert=db.raw.prepare('INSERT INTO command_expenses(id,day,amount_kopecks,category,note,created_at,created_by) VALUES(?,?,?,?,?,?,?)');
  db.raw.exec('BEGIN');for (let i=0;i<count;i++) insert.run(crypto.randomUUID(),day,amountKopecks,category,'Строка '+i,'2026-01-01T00:00:00.000Z',editor.email);db.raw.exec('COMMIT');
}
function insertAudit(db,count,event='command_contact_created',at='2026-01-01T00:00:00.000Z') {
  const ids=[];for(let i=0;i<count;i++){const id=crypto.randomUUID();ids.push(id);db.raw.prepare('INSERT INTO operator_audit(id,event,actor,subject_id,at) VALUES(?,?,?,?,?)').run(id,event,editor.email,crypto.randomUUID(),at);}return ids;
}

test('R8 schema-only first use returns complete revision-zero ledger, budget and export without seeding data',async()=>{
  const db=database();db.raw.exec('DELETE FROM command_state');
  const expenses=await (await command(db,'/expenses')).json();assert.equal(expenses.revision,0);assert.deepEqual(expenses.expenses,[]);assert.equal(expenses.total,0);assert.equal(expenses.totalKopecks,0);assert.equal(expenses.nextOffset,null);
  const budget=await (await command(db,'/budget')).json();assert.equal(budget.revision,0);assert.equal(budget.totalKopecks,0);assert.equal(budget.totalCount,0);assert.equal(budget.remainingKopecks,10000000);assert.equal(budget.days.length,10);assert.ok(budget.days.every(day=>day.count===0&&day.totalKopecks===0));assert.deepEqual(budget.categories,[]);
  const response=await command(db,'/export?format=json');assert.equal(response.status,200);assert.equal(response.headers.get('X-Export-Revision'),'0');assert.equal(response.headers.get('X-Export-Count'),'0');
  const snapshot=await response.json();assert.equal(snapshot.revision,0);assert.deepEqual(snapshot.counts,{contacts:0,expenses:0,quests:0});assert.deepEqual(snapshot.contacts,[]);assert.deepEqual(snapshot.expenses,[]);assert.deepEqual(snapshot.quests,[]);assert.equal(snapshot.publication,null);
  const csv=await command(db,'/export?format=expenses.csv');assert.equal(csv.status,200);assert.equal(csv.headers.get('X-Export-Revision'),'0');assert.equal(csv.headers.get('X-Export-Count'),'0');assert.equal((await csv.text()).split('\r\n').filter(Boolean).length,1);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM command_state').get().n,0);assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM command_expenses').get().n,0);assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM command_contacts').get().n,0);assert.equal(auditCount(db),2);db.raw.close();
});

test('R8 expense totals cover all matching records, stay exact in kopecks and do not depend on page size',async()=>{
  const db=database();insertExpenses(db,28);insertExpenses(db,3,{category:'food',amountKopecks:239});insertExpenses(db,2,{day:2,amountKopecks:125});
  const first=await (await command(db,'/expenses?day=1&category=transport')).json();
  const second=await (await command(db,'/expenses?day=1&category=transport&offset=25')).json();
  assert.equal(first.total,28);assert.equal(first.totalKopecks,2828);assert.equal(first.totalRub,28.28);assert.equal(first.expenses.length,25);assert.equal(first.nextOffset,25);
  assert.equal(second.total,28);assert.equal(second.totalKopecks,2828);assert.equal(second.expenses.length,3);assert.equal(second.nextOffset,null);
  assert.equal(new Set([...first.expenses,...second.expenses].map(row=>row.id)).size,28);
  assert.equal((await (await command(db,'/expenses?day=1')).json()).totalKopecks,3545);
  assert.equal((await (await command(db,'/expenses')).json()).totalKopecks,3795);
  for(const value of first.expenses){assert.equal(value.revision,1);assert.equal(value.amountKopecks,101);assert.equal(value.updatedAt,value.createdAt);}
  for(const query of ['day=11','offset=-1','category='+encodeURIComponent('<script>'),'category='+'x'.repeat(81)]) assert.equal((await command(db,'/expenses?'+query)).status,400);
  assert.equal((await (await command(db,'/expenses?category='+encodeURIComponent("' OR 1=1 --"))).json()).total,0);db.raw.close();
});
test('R8 budget returns full expedition, all ten days and complete category totals',async()=>{
  const db=database();insertExpenses(db,2,{amountKopecks:100001});insertExpenses(db,1,{day:3,category:'food',amountKopecks:20002});
  const data=await (await command(db,'/budget')).json();
  assert.equal(data.limitKopecks,10000000);assert.equal(data.totalKopecks,220004);assert.equal(data.totalRub,2200.04);assert.equal(data.totalCount,3);assert.equal(data.remainingKopecks,9779996);assert.equal(data.days.length,10);
  assert.deepEqual(data.days[1],{day:2,count:0,totalKopecks:0,totalRub:0});assert.equal(data.days[2].totalKopecks,20002);
  assert.deepEqual(data.categories.map(row=>[row.category,row.count,row.totalKopecks]),[['transport',2,200002],['food',1,20002]]);
  insertExpenses(db,1,{amountKopecks:100000000});const over=await (await command(db,'/budget')).json();assert.ok(over.remainingKopecks<0);assert.equal(over.totalKopecks+over.remainingKopecks,over.limitKopecks);db.raw.close();
});
test('R8 edit/get/delete expenses use optimistic revisions with no stale side effects',async()=>{
  const db=database(),first=await createExpense(db);assert.equal(first.revision,1);
  const edited=await command(db,'/expenses/'+first.id,{method:'PATCH',body:{...expense,day:2,amountRub:500.01,category:'food',note:'Исправлено',expectedRevision:1}});assert.equal(edited.status,200);
  const item=(await edited.json()).expense;assert.equal(item.revision,2);assert.equal(item.amountKopecks,50001);assert.equal(item.day,2);assert.equal(revision(db),2);assert.equal(auditCount(db),2);
  const loaded=await (await command(db,'/expenses/'+first.id,{actor:moderator})).json();assert.deepEqual(loaded.expense,item);
  assert.equal((await command(db,'/expenses/'+first.id,{method:'PATCH',body:{...expense,expectedRevision:1}})).status,409);
  assert.equal((await command(db,'/expenses/'+first.id,{method:'DELETE',body:{expectedRevision:1}})).status,409);assert.equal(revision(db),2);assert.equal(auditCount(db),2);
  assert.equal((await command(db,'/expenses/'+first.id,{method:'DELETE',body:{expectedRevision:2}})).status,200);
  assert.equal((await command(db,'/expenses/'+first.id)).status,404);assert.equal(revision(db),3);assert.equal(auditCount(db),3);
  assert.equal((await command(db,'/expenses/'+first.id,{method:'PATCH',body:{...expense,expectedRevision:2}})).status,409);assert.equal(auditCount(db),3);db.raw.close();
});
test('R8 concurrent expense edits commit once and return a conflict to the stale writer',async()=>{
  const db=database(),item=await createExpense(db);let reached=0,release;const barrier=new Promise(resolve=>{release=resolve;});
  db.beforeBatch=async statements=>{if(!statements.some(s=>s.sql.startsWith('UPDATE command_expenses')))return;if(++reached===2)release();await barrier;};
  const responses=await Promise.all([1,2].map(i=>command(db,'/expenses/'+item.id,{method:'PATCH',body:{...expense,amountRub:100+i,expectedRevision:1}})));
  assert.equal(reached,2);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(revision(db),2);assert.equal(auditCount(db),2);assert.equal(db.raw.prepare('SELECT revision FROM command_expenses').get().revision,2);db.raw.close();
});
test('R8 expense response belongs to its committed edit even if a later editor writes before response serialization',async()=>{
  const db=database(),item=await createExpense(db);let later=false;
  db.afterBatch=async statements=>{if(later||!statements.some(s=>s.sql.startsWith('UPDATE command_expenses')))return;later=true;await command(db,'/expenses/'+item.id,{method:'PATCH',body:{...expense,amountRub:300,expectedRevision:2}});};
  const response=await command(db,'/expenses/'+item.id,{method:'PATCH',body:{...expense,amountRub:200,expectedRevision:1}}),data=await response.json();
  assert.equal(data.expense.revision,2);assert.equal(data.expense.amountRub,200);assert.equal(db.raw.prepare('SELECT revision FROM command_expenses').get().revision,3);db.raw.close();
});
test('R8 expense audit failure rolls back money, row revision and command revision together',async()=>{
  const db=database(),item=await createExpense(db);
  db.raw.exec("CREATE TRIGGER fail_r8_audit BEFORE INSERT ON operator_audit WHEN NEW.event='command_expense_updated' BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END");
  await assert.rejects(command(db,'/expenses/'+item.id,{method:'PATCH',body:{...expense,amountRub:999.99,expectedRevision:1}}),/simulated audit failure/);
  const row=db.raw.prepare('SELECT revision,amount_kopecks FROM command_expenses').get();assert.equal(row.revision,1);assert.equal(row.amount_kopecks,1245);assert.equal(revision(db),1);assert.equal(auditCount(db),1);db.raw.close();
});
test('R8 financial writes reject fractional kopecks, unknown fields, unsafe revisions and unprivileged callers',async()=>{
  const db=database(),item=await createExpense(db);
  for(const change of [{amountRub:1.001},{amountRub:0},{expectedRevision:0},{expectedRevision:1.5},{unknown:true},{day:0}])assert.equal((await command(db,'/expenses/'+item.id,{method:'PATCH',body:{...expense,expectedRevision:1,...change}})).status,400);
  assert.equal((await command(db,'/expenses/'+item.id,{actor:moderator,method:'PATCH',body:{...expense,expectedRevision:1}})).status,403);
  assert.equal((await command(db,'/expenses/'+item.id,{method:'DELETE',body:{expectedRevision:'1'}})).status,400);
  assert.equal((await command(db,'/expenses/'+item.id,{method:'PATCH',origin:'https://evil.example',body:{...expense,expectedRevision:1}})).status,403);assert.equal(revision(db),1);db.raw.close();
});
test('R8 migration preserves existing amounts, dates and records without a backfill or sample inserts',async()=>{
  const db=database({r8:false});insertExpenses(db,1);const before=db.raw.prepare('SELECT * FROM command_expenses').get();
  assert.equal((await command(db,'/expenses')).status,503);assert.equal((await command(db,'/export')).status,503);
  db.raw.exec(readFileSync(new URL('../services/moscow-1000-api/migrations/0007_r8_command_ledger.sql',import.meta.url),'utf8'));
  const after=db.raw.prepare('SELECT * FROM command_expenses').get();for(const key of Object.keys(before))assert.equal(after[key],before[key]);assert.equal(after.revision,1);assert.equal(after.updated_at,null);
  const loaded=(await (await command(db,'/expenses')).json()).expenses[0];assert.equal(loaded.updatedAt,before.created_at);assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM command_contacts').get().n,0);db.raw.close();
});
test('R8 full JSON export includes every private record and a sanitized publication at one source revision',async()=>{
  const db=database();
  for(let i=0;i<27;i++) await command(db,'/contacts',{method:'POST',body:{...contact,name:contact.name+' '+i}});
  await createExpense(db);await command(db,'/quests',{method:'PUT',body:{day:1,questId:'d1-q1',completed:true}});await command(db,'/quests',{method:'PUT',body:{day:2,questId:'d2-q1',completed:false}});
  await command(db,'/publish',{actor:approver,method:'POST',body:{confirm:true}});
  const row=db.raw.prepare('SELECT document_json FROM command_public').get(),document=JSON.parse(row.document_json);document.secret='must-not-export';db.raw.prepare('UPDATE command_public SET document_json=?').run(JSON.stringify(document));
  const before=revision(db),response=await command(db,'/export?format=json');assert.equal(response.status,200);assert.match(response.headers.get('Content-Disposition'),/^attachment; filename="OSMANX_R8_/);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const bytes=Buffer.from(await response.arrayBuffer()),data=JSON.parse(bytes.toString('utf8'));
  assert.equal(data.schemaVersion,1);assert.equal(data.revision,before);assert.equal(data.contacts.length,27);assert.equal(data.expenses.length,1);assert.equal(data.quests.length,2);assert.equal(data.quests[1].completed,false);
  assert.deepEqual(data.counts,{contacts:27,expenses:1,quests:2});assert.equal(data.publication.sourceRevision,before);assert.equal(data.publication.snapshot.metrics.researched,27);
  assert.doesNotMatch(bytes.toString('utf8'),/must-not-export|google_admin_sessions|google_auth_flows|payload_hash|key_hash|session_secret/);
  assert.equal(response.headers.get('X-Export-Count'),'30');assert.equal(response.headers.get('X-Export-Revision'),String(before));assert.equal(response.headers.get('X-Content-SHA256'),createHash('sha256').update(bytes).digest('hex'));
  assert.equal(response.headers.get('Content-Digest'),'sha-256=:'+createHash('sha256').update(bytes).digest('base64')+':');assert.equal(revision(db),before);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM operator_audit WHERE event='command_data_exported'").get().n,1);db.raw.close();
});
test('R8 exported snapshot remains internally consistent when a new expense is committed after capture',async()=>{
  const db=database();await createExpense(db);let inserted=false;
  db.afterBatch=async statements=>{if(inserted||!statements.some(s=>s.sql.includes('AS contacts,(SELECT COUNT(*)')))return;inserted=true;await createExpense(db,{...expense,amountRub:999.99});};
  const response=await command(db,'/export?format=json'),data=await response.json();
  assert.equal(data.revision,1);assert.equal(data.counts.expenses,1);assert.equal(data.expenses.length,1);assert.equal(data.expenses[0].amountRub,12.45);assert.equal(revision(db),2);assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM command_expenses').get().n,2);db.raw.close();
});
test('R8 CSV exports quote multiline text, preserve UTF-8 and prevent spreadsheet formulas',async()=>{
  const db=database();await command(db,'/contacts',{method:'POST',body:{...contact,name:'=SUM(1,2)',person:'@имя',channel:'+79990000000',problem:'Текст, с "кавычками"\nновая строка'}});
  const response=await command(db,'/export?format=contacts.csv'),bytes=Buffer.from(await response.arrayBuffer()),csv=bytes.toString('utf8');
  assert.deepEqual([...bytes.subarray(0,3)],[239,187,191]);assert.equal(response.headers.get('X-Export-Count'),'1');assert.match(csv,/"'=SUM\(1,2\)"/);assert.match(csv,/"'@имя"/);assert.match(csv,/"'\+79990000000"/);assert.match(csv,/"Текст, с ""кавычками""\nновая строка"/);
  for(const input of [' =1','\t=1','\r=1','\n=1','\uFEFF+SUM(1)','  -10','  @formula'])assert.ok(csvCell(input).startsWith('"\''),JSON.stringify(input));
  assert.equal(csvCell(12.45),'"12.45"');assert.equal(csvCell('Нормальное имя'),'"Нормальное имя"');
  await createExpense(db);const expenseCsv=await (await command(db,'/export?format=expenses.csv')).text();assert.match(expenseCsv,/"12\.45","1245"/);assert.doesNotMatch(expenseCsv,/private@example|Кофейня/);db.raw.close();
});
test('R8 export is explicit, authenticated and editor-only, with no successful artifact when audit fails',async()=>{
  const db=database();await createExpense(db);
  for(const path of ['/budget','/expenses','/audit','/export'])assert.equal((await command(db,path,{actor:null})).status,401);
  assert.equal((await command(db,'/export',{actor:moderator})).status,403);assert.equal((await command(db,'/export',{actor:approver})).status,403);
  assert.equal((await command(db,'/export',{headers:{Origin:'https://evil.example'}})).status,403);assert.equal((await command(db,'/export',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await command(db,'/export?format=sql')).status,400);assert.equal(auditCount(db),1);
  db.raw.exec("CREATE TRIGGER fail_export_audit BEFORE INSERT ON operator_audit WHEN NEW.event='command_data_exported' BEGIN SELECT RAISE(ABORT,'simulated audit outage'); END");
  const result=await command(db,'/export');assert.equal(result.status,503);assert.equal(result.headers.get('Content-Disposition'),null);assert.equal((await result.json()).code,'export_audit_unavailable');assert.equal(revision(db),1);assert.equal(auditCount(db),1);db.raw.close();
});
test('R8 large exports fail clearly instead of truncating, while an unrelated CSV can still be downloaded',async()=>{
  const db=database();insertExpenses(db,EXPORT_ROW_LIMIT+1);
  const result=await command(db,'/export');assert.equal(result.status,413);assert.equal(result.headers.get('Content-Disposition'),null);const data=await result.json();assert.equal(data.code,'export_too_large');assert.equal(data.limits.rowsPerTable,EXPORT_ROW_LIMIT);assert.equal(data.limits.bytes,EXPORT_BYTE_LIMIT);assert.equal(auditCount(db),0);
  assert.equal((await command(db,'/export?format=expenses.csv')).status,413);
  const contacts=await command(db,'/export?format=contacts.csv');assert.equal(contacts.status,200);assert.equal(contacts.headers.get('X-Export-Count'),'0');assert.equal(auditCount(db),1);db.raw.close();
});
test('R8 byte cap rejects large text even below the row limit and leaves no success audit or attachment',async()=>{
  const db=database(),insert=db.raw.prepare('INSERT INTO command_contacts(id,day,name,category,person,channel,outcome,problem,next_step,created_at,updated_at,updated_by) VALUES(?,1,?,?,?,?,?,?,?,?,?,?)');
  const at='2026-01-01T00:00:00.000Z';db.raw.exec('BEGIN');
  for(let i=0;i<2500;i++)insert.run(crypto.randomUUID(),'Я'.repeat(120),'Я'.repeat(80),'Я'.repeat(100),'Я'.repeat(200),'dialogue','Я'.repeat(1000),'Я'.repeat(500),at,at,editor.email);
  db.raw.exec('COMMIT');
  const response=await command(db,'/export');assert.equal(response.status,413);assert.equal((await response.json()).code,'export_too_large');assert.equal(response.headers.get('Content-Disposition'),null);assert.equal(auditCount(db),0);db.raw.close();
});
test('R8 a corrupt publication blocks full JSON export without leaking its raw document; CSV remains available',async()=>{
  const db=database();await command(db,'/publish',{actor:approver,method:'POST',body:{confirm:true}});
  db.raw.prepare('UPDATE command_public SET document_json=?').run('{"status":"published","secret":"private-secret"}');
  const response=await command(db,'/export');assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private-secret/);assert.equal((await command(db,'/export?format=contacts.csv')).status,200);db.raw.close();
});
test('R8 audit pages retain equal timestamps, exclude other subsystems and do not include later insertions',async()=>{
  const db=database(),ids=insertAudit(db,60);insertAudit(db,3,'editorial_published');
  const first=await (await command(db,'/audit?category=contact')).json();assert.equal(first.total,60);assert.equal(first.events.length,25);assert.ok(first.nextCursor);
  const late=insertAudit(db,1,'command_contact_created','2025-01-01T00:00:00.000Z')[0];
  const second=await (await command(db,'/audit?category=contact&cursor='+first.nextCursor)).json();const third=await (await command(db,'/audit?category=contact&cursor='+second.nextCursor)).json();
  assert.equal(second.total,60);assert.equal(third.total,60);assert.equal(third.events.length,10);assert.equal(third.nextCursor,null);
  const collected=[...first.events,...second.events,...third.events];assert.equal(new Set(collected.map(row=>row.id)).size,60);assert.deepEqual(collected.map(row=>row.id).sort(),ids.sort());assert.ok(!collected.some(row=>row.id===late));assert.ok(collected.every(row=>row.event==='command_contact_created'));
  assert.equal((await (await command(db,'/audit')).json()).total,61);db.raw.close();
});
test('R8 audit categories, cursor validation and subject allowlist expose only command metadata',async()=>{
  const db=database();insertAudit(db,27,'command_expense_updated');insertAudit(db,2,'command_quest_changed');insertAudit(db,1,'command_data_exported');
  db.raw.prepare('UPDATE operator_audit SET subject_id=?').run('private@example.org; raw private note');
  const data=await (await command(db,'/audit?category=expense',{actor:moderator})).json();assert.equal(data.total,27);assert.ok(data.events.every(row=>row.subjectId===null));assert.equal((await (await command(db,'/audit?category=export')).json()).total,1);
  for(const query of ['category=unknown','cursor=', 'cursor=not-json', 'cursor='+'A'.repeat(601),'category=quest&cursor='+data.nextCursor])assert.equal((await command(db,'/audit?'+query)).status,400);
  const text=await (await command(db,'/audit')).text();assert.doesNotMatch(text,/raw private note|private@example.org/);db.raw.close();
});
test('R8 public and worker entrypoints never grant anonymous ledger/export/audit access',async()=>{
  const db=database();await createExpense(db);await command(db,'/contacts',{method:'POST',body:contact});
  for(const path of ['/expenses','/budget','/audit','/export'])assert.equal((await worker.fetch(request(path),{DB:db,SITE_ORIGIN:ORIGIN})).status,401);
  const publicResponse=await command(db,'/public',{actor:null});assert.equal(publicResponse.status,200);assert.doesNotMatch(await publicResponse.text(),/private@example|Тестовый|amountKopecks|command_data_exported/);db.raw.close();
});
