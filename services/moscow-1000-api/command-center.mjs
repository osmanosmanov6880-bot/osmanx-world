/** Private expedition command center. Public access is only to an explicitly approved aggregate snapshot. */
import {EXPORT_ROW_LIMIT,EXPORT_BYTE_LIMIT,commandExportBytes} from './command-export.mjs';
const ROOT='/moscow-1000/api/command';
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const reply=(value,status=200)=>Response.json(value,{status,headers});
const uuid=()=>crypto.randomUUID();
const stamp=()=>new Date().toISOString();
const fields=['day','name','category','person','channel','outcome','problem','nextStep'];
const outcomes=new Set(['visited','dialogue','interest','refusal','meeting','pilot','contract']);
const metricKeys=['researched','visits','dialogues','contacts','decisionMeetings','meetings','proposals','pilots','contracts','expensesRub','questsCompleted','xp'];
const questXP=[150,200,100,100,150];
const zeroMetrics=()=>Object.fromEntries(metricKeys.map(k=>[k,0]));
const unpublished=()=>({ok:true,status:'unpublished',version:0,reviewedAt:null,metrics:null,days:[],quests:[]});
const plain=x=>Boolean(x&&typeof x==='object'&&!Array.isArray(x));
const only=(obj,keys)=>plain(obj)&&Object.keys(obj).every(k=>keys.includes(k));
const dayValid=x=>Number.isInteger(x)&&x>=1&&x<=10;
const clean=(x,max,required=false,multiline=false)=>typeof x==='string'&&x.trim().length<=max&&(!required||x.trim().length>0)&&!(multiline?/[<>\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/:/[<>\u0000-\u001f\u007f]/).test(x);
const denied=()=>reply({ok:false,error:'Недостаточно полномочий.'},403);
const invalid=()=>reply({ok:false,error:'Проверьте поля формы.'},400);
const conflict=()=>reply({ok:false,error:'Запись изменилась. Обновите данные и повторите действие.'},409);
const contactDto=row=>({id:row.id,revision:row.revision,day:row.day,name:row.name,category:row.category,person:row.person,channel:row.channel,outcome:row.outcome,problem:row.problem,nextStep:row.next_step,createdAt:row.created_at,updatedAt:row.updated_at});
const expenseDto=row=>({id:row.id,revision:row.revision,day:row.day,amountRub:row.amount_kopecks/100,amountKopecks:row.amount_kopecks,category:row.category,note:row.note,createdAt:row.created_at,updatedAt:row.updated_at||row.created_at});
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
const idempotencyConflict=()=>reply({ok:false,code:'idempotency_conflict',error:'Этот ключ уже использован для другой записи. Обновите состояние черновика перед новой отправкой.'},409);
function russianFoldSql(expression) {
  // SQLite lower() folds ASCII only. Explicit Cyrillic folding keeps Russian
  // search correct for existing rows, without a data-changing backfill on read.
  for (const upper of 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ') expression=`replace(${expression},'${upper}','${upper.toLowerCase()}')`;
  return 'lower('+expression+')';
}
const contactSearchSql=russianFoldSql("name||' '||category||' '||person||' '||channel||' '||problem||' '||next_step");
function contactFilters(url) {
  const page=pagination(url);if (!page) return null;
  const q=(url.searchParams.get('q')||'').trim();
  const outcome=url.searchParams.get('outcome')||'all';
  const followup=url.searchParams.get('followup')||'all';
  if (!clean(q,120)||!(outcome==='all'||outcomes.has(outcome))||!['all','pending','none'].includes(followup)) return null;
  const clauses=[],args=[];
  if (page.day!==null) {clauses.push('day=?');args.push(page.day);}
  if (outcome!=='all') {clauses.push('outcome=?');args.push(outcome);}
  if (followup!=='all') {
    const pending="(TRIM(next_step)<>'' AND outcome NOT IN ('refusal','contract'))";
    clauses.push(followup==='pending'?pending:'NOT '+pending);
  }
  if (q) {clauses.push(`instr(${contactSearchSql},?)>0`);args.push(q.toLowerCase());}
  return {...page,where:clauses.length?' WHERE '+clauses.join(' AND '):'',args};
}

async function createCommandRecord(req,db,actor,{operation,value,table,dto,insert,event}) {
  const key=req.headers.get('Idempotency-Key');
  if (key!==null&&!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) return reply({ok:false,code:'invalid_idempotency_key',error:'Некорректный ключ отправки.'},400);
  const id=uuid(),at=stamp();
  if (key===null) {
    await db.batch([insert(id,at),stateChange(db,actor,at),audit(db,event,actor,id,at)]);
    return reply({ok:true,[operation]:dto(await db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first())},201);
  }
  const actorId=await hash(JSON.stringify([actor.provider||'access',actor.subject||actor.email.toLowerCase()]));
  const keyHash=await hash(key),payloadHash=await hash(JSON.stringify(value));
  const identity=[actorId,operation,keyHash];
  const readReceipt=()=>db.prepare('SELECT payload_hash,record_id FROM command_requests WHERE actor_id=? AND operation=? AND key_hash=?').bind(...identity).first();
  const respond=async (receipt,replayed)=>{
    if (receipt.payload_hash!==payloadHash) return idempotencyConflict();
    const row=await db.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(receipt.record_id).first();
    // Deleting a record must never allow an old queued request to recreate it.
    if (!row) return reply({ok:false,code:'idempotency_target_removed',error:'Эта запись уже была сохранена, затем удалена. Повторная отправка её не восстановит.'},410);
    return reply({ok:true,[operation]:dto(row),idempotency_replayed:replayed},replayed?200:201);
  };
  let prior;
  try {prior=await readReceipt();} catch {return reply({ok:false,code:'migration_required',error:'Сначала примените миграцию R7. Черновик можно отправить после обновления сервиса.'},503);}
  if (prior) return respond(prior,true);
  // INSERT OR IGNORE reserves a scoped key in the same transaction as the
  // record, revision and audit. Every later write is guarded by our unique ID,
  // so concurrent identical or conflicting requests can commit only once.
  const guard='EXISTS(SELECT 1 FROM command_requests WHERE actor_id=? AND operation=? AND key_hash=? AND record_id=?)';
  const args=[...identity,id];
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO command_requests(actor_id,operation,key_hash,payload_hash,record_id,created_at) VALUES(?,?,?,?,?,?)').bind(...identity,payloadHash,id,at),
    insert(id,at,' WHERE '+guard,args),
    stateChange(db,actor,at,' AND '+guard,args),
    audit(db,event,actor,id,at,' WHERE '+guard,args)
  ]);
  const receipt=await readReceipt();
  if (!receipt) throw Error('Missing committed request receipt');
  return respond(receipt,receipt.record_id!==id);
}
async function body(req) {
  if (!req.headers.get('Content-Type')?.startsWith('application/json') || Number(req.headers.get('Content-Length') || 0)>8192) return null;
  const reader=req.body?.getReader();
  if (!reader) return null;
  let total=0,text='';
  const decoder=new TextDecoder();
  try {
    while (true) {
      const {value,done}=await reader.read();
      if (done) break;
      total+=value.byteLength;
      if (total>8192) { await reader.cancel(); return null; }
      text+=decoder.decode(value,{stream:true});
    }
    text+=decoder.decode();
    const result=JSON.parse(text);
    return plain(result)?result:null;
  } catch { return null; }
}
function contactInput(value,patch=false) {
  if (!only(value,patch?[...fields,'expectedRevision']:fields) || !dayValid(value.day) || !clean(value.name,120,true) || !outcomes.has(value.outcome)) return null;
  for (const [key,max] of [['category',80],['person',100],['channel',200],['problem',1000],['nextStep',500]]) {
    if (value[key]!==undefined && !clean(value[key],max,false,key==='problem')) return null;
  }
  if (patch && (!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1)) return null;
  return Object.fromEntries(fields.map(k=>[k,typeof value[k]==='string'?value[k].trim():value[k]??'']));
}
function pagination(url) {
  const offset=Number(url.searchParams.get('offset')||0);
  const day=url.searchParams.has('day')?Number(url.searchParams.get('day')):null;
  return Number.isSafeInteger(offset)&&offset>=0&&offset<=10000&&(day===null||dayValid(day))?{offset,day}:null;
}
function stateChange(db,actor,at,condition='',args=[]) {
  return db.prepare('UPDATE command_state SET revision=revision+1,updated_by=?,updated_at=? WHERE slot=1'+condition).bind(actor.email,at,...args);
}
function audit(db,event,actor,id,at,condition='',args=[]) {
  return db.prepare('INSERT INTO operator_audit(id,event,actor,subject_id,at) SELECT ?,?,?,?,?'+condition).bind(uuid(),event,actor.email,id,at,...args);
}
async function contacts(req,db,actor,rest,url) {
  if (rest==='/contacts'&&req.method==='GET') {
    const page=contactFilters(url);if (!page) return invalid();
    const result=await db.batch([
      db.prepare('SELECT * FROM command_contacts'+page.where+' ORDER BY created_at DESC,id DESC LIMIT 26 OFFSET ?').bind(...page.args,page.offset),
      db.prepare('SELECT COUNT(*) AS total FROM command_contacts'+page.where).bind(...page.args)
    ]);
    const rows=result[0].results||[];
    return reply({ok:true,contacts:rows.slice(0,25).map(contactDto),nextOffset:rows.length>25?page.offset+25:null,total:result[1].results?.[0]?.total||0});
  }
  if (rest==='/contacts'&&req.method==='POST') {
    if (!actor.editor) return denied();
    const value=contactInput(await body(req));if (!value) return invalid();
    return createCommandRecord(req,db,actor,{operation:'contact',value,table:'command_contacts',dto:contactDto,event:'command_contact_created',
      insert:(id,at,condition='',args=[])=>db.prepare('INSERT INTO command_contacts(id,day,name,category,person,channel,outcome,problem,next_step,created_at,updated_at,updated_by) SELECT ?,?,?,?,?,?,?,?,?,?,?,?'+condition).bind(id,value.day,value.name,value.category,value.person,value.channel,value.outcome,value.problem,value.nextStep,at,at,actor.email,...args)
    });
  }
  const match=/^\/contacts\/([0-9a-f-]{36})$/.exec(rest);if (!match) return null;
  if (!actor.editor) return denied();
  const id=match[1],input=await body(req);
  if (req.method==='PATCH') {
    const value=contactInput(input,true);if (!value) return invalid();
    const at=stamp(),args=[id,input.expectedRevision];
    const exists=' AND EXISTS(SELECT 1 FROM command_contacts WHERE id=? AND revision=?)';
    const result=await db.batch([
      audit(db,'command_contact_updated',actor,id,at,' WHERE EXISTS(SELECT 1 FROM command_contacts WHERE id=? AND revision=?)',args),
      stateChange(db,actor,at,exists,args),
      db.prepare('UPDATE command_contacts SET revision=revision+1,day=?,name=?,category=?,person=?,channel=?,outcome=?,problem=?,next_step=?,updated_at=?,updated_by=? WHERE id=? AND revision=?').bind(value.day,value.name,value.category,value.person,value.channel,value.outcome,value.problem,value.nextStep,at,actor.email,id,input.expectedRevision)
    ]);
    if (!result[2]?.meta?.changes) return conflict();
    return reply({ok:true,contact:contactDto(await db.prepare('SELECT * FROM command_contacts WHERE id=?').bind(id).first())});
  }
  if (req.method==='DELETE') {
    if (!only(input,['expectedRevision'])||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1) return invalid();
    const at=stamp(),args=[id,input.expectedRevision];
    const result=await db.batch([
      audit(db,'command_contact_erased',actor,null,at,' WHERE EXISTS(SELECT 1 FROM command_contacts WHERE id=? AND revision=?)',args),
      stateChange(db,actor,at,' AND EXISTS(SELECT 1 FROM command_contacts WHERE id=? AND revision=?)',args),
      db.prepare('DELETE FROM command_contacts WHERE id=? AND revision=?').bind(...args)
    ]);
    return result[2]?.meta?.changes?reply({ok:true,erased:true}):conflict();
  }
  return null;
}
function expenseInput(value,patch=false) {
  const amount=Math.round((value?.amountRub||0)*100);
  if (!only(value,patch?['day','amountRub','category','note','expectedRevision']:['day','amountRub','category','note'])||!dayValid(value.day)||typeof value.amountRub!=='number'||!Number.isSafeInteger(amount)||amount<1||amount>100000000||Math.abs(value.amountRub*100-amount)>1e-6||!clean(value.category,80,true)||(value.note!==undefined&&!clean(value.note,300))) return null;
  if (patch&&(!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1)) return null;
  return {day:value.day,amountKopecks:amount,category:value.category.trim(),note:(value.note||'').trim()};
}
const missingLedger=()=>reply({ok:false,code:'migration_required',error:'Сначала примените миграцию R8 для учёта расходов.'},503);
async function ledgerReady(db) {
  try {await db.prepare('SELECT revision,updated_at,updated_by FROM command_expenses LIMIT 1').first();return true;} catch {return false;}
}
function expenseFilters(url) {
  const page=pagination(url);if (!page) return null;
  const category=(url.searchParams.get('category')||'').trim();
  if (!clean(category,80)) return null;
  const clauses=[],args=[];
  if (page.day!==null) {clauses.push('day=?');args.push(page.day);}
  if (category) {clauses.push('category=?');args.push(category);}
  return {...page,where:clauses.length?' WHERE '+clauses.join(' AND '):'',args};
}
async function expenses(req,db,actor,rest,url) {
  if (!await ledgerReady(db)) return missingLedger();
  if (rest==='/expenses'&&req.method==='GET') {
    const page=expenseFilters(url);if (!page) return invalid();
    // The visible page and totals use the same database snapshot. Totals never
    // change merely because another page was loaded on a small phone screen.
    const result=await db.batch([
      db.prepare('SELECT * FROM command_expenses'+page.where+' ORDER BY created_at DESC,id DESC LIMIT 26 OFFSET ?').bind(...page.args,page.offset),
      db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(amount_kopecks),0) AS total_kopecks FROM command_expenses'+page.where).bind(...page.args),
      db.prepare('SELECT revision FROM command_state WHERE slot=1')
    ]);
    const rows=result[0].results||[],aggregate=result[1].results?.[0],revision=result[2].results?.[0]?.revision??0;
    return reply({ok:true,expenses:rows.slice(0,25).map(expenseDto),nextOffset:rows.length>25?page.offset+25:null,total:aggregate.total,totalKopecks:aggregate.total_kopecks,totalRub:aggregate.total_kopecks/100,revision});
  }
  if (rest==='/expenses'&&req.method==='POST') {
    if (!actor.editor) return denied();
    const canonical=expenseInput(await body(req));if (!canonical) return invalid();
    return createCommandRecord(req,db,actor,{operation:'expense',value:canonical,table:'command_expenses',dto:expenseDto,event:'command_expense_created',
      insert:(id,at,condition='',args=[])=>db.prepare('INSERT INTO command_expenses(id,day,amount_kopecks,category,note,created_at,created_by,updated_at,updated_by) SELECT ?,?,?,?,?,?,?,?,?'+condition).bind(id,canonical.day,canonical.amountKopecks,canonical.category,canonical.note,at,actor.email,at,actor.email,...args)
    });
  }
  const match=/^\/expenses\/([0-9a-f-]{36})$/.exec(rest);if (!match) return null;
  const id=match[1];
  if (req.method==='GET') {
    const row=await db.prepare('SELECT * FROM command_expenses WHERE id=?').bind(id).first();
    return row?reply({ok:true,expense:expenseDto(row)}):reply({ok:false,error:'Запись не найдена.'},404);
  }
  if (!actor.editor) return denied();
  if (req.method==='PATCH') {
    const input=await body(req),value=expenseInput(input,true);if (!value) return invalid();
    const at=stamp(),args=[id,input.expectedRevision];
    const exists='EXISTS(SELECT 1 FROM command_expenses WHERE id=? AND revision=?)';
    const result=await db.batch([
      audit(db,'command_expense_updated',actor,id,at,' WHERE '+exists,args),
      stateChange(db,actor,at,' AND '+exists,args),
      db.prepare('UPDATE command_expenses SET revision=revision+1,day=?,amount_kopecks=?,category=?,note=?,updated_at=?,updated_by=? WHERE id=? AND revision=?').bind(value.day,value.amountKopecks,value.category,value.note,at,actor.email,...args),
      db.prepare('SELECT * FROM command_expenses WHERE id=?').bind(id)
    ]);
    if (!result[2]?.meta?.changes) return conflict();
    return reply({ok:true,expense:expenseDto(result[3].results[0])});
  }
  if (req.method==='DELETE') {
    const value=await body(req);
    if (!only(value,['expectedRevision'])||(value.expectedRevision!==undefined&&(!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1))) return invalid();
    // R6/R7 clients send {}. New clients always provide expectedRevision. The
    // compatibility path deliberately retains the former explicit-delete API.
    const at=stamp(),condition='id=?'+(value.expectedRevision===undefined?'':' AND revision=?'),args=[id,...(value.expectedRevision===undefined?[]:[value.expectedRevision])];
    const exists='EXISTS(SELECT 1 FROM command_expenses WHERE '+condition+')';
    const result=await db.batch([
      audit(db,'command_expense_erased',actor,null,at,' WHERE '+exists,args),
      stateChange(db,actor,at,' AND '+exists,args),
      db.prepare('DELETE FROM command_expenses WHERE '+condition).bind(...args)
    ]);
    return result[2]?.meta?.changes?reply({ok:true,erased:true}):value.expectedRevision===undefined?reply({ok:false,error:'Запись не найдена.'},404):conflict();
  }
  return null;
}
async function budget(db) {
  const result=await db.batch([
    db.prepare('SELECT revision FROM command_state WHERE slot=1'),
    db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(amount_kopecks),0) AS total_kopecks FROM command_expenses'),
    db.prepare('SELECT day,COUNT(*) AS count,SUM(amount_kopecks) AS total_kopecks FROM command_expenses GROUP BY day ORDER BY day'),
    db.prepare('SELECT category,COUNT(*) AS count,SUM(amount_kopecks) AS total_kopecks FROM command_expenses GROUP BY category ORDER BY total_kopecks DESC,category')
  ]);
  const total=result[1].results?.[0],byDay=new Map((result[2].results||[]).map(row=>[row.day,row]));
  const amount=row=>({count:row?.count||0,totalKopecks:row?.total_kopecks||0,totalRub:(row?.total_kopecks||0)/100});
  const limitKopecks=10000000,remainingKopecks=limitKopecks-total.total_kopecks;
  return reply({ok:true,revision:result[0].results?.[0]?.revision??0,limitKopecks,limitRub:limitKopecks/100,totalKopecks:total.total_kopecks,totalRub:total.total_kopecks/100,totalCount:total.count,remainingKopecks,remainingRub:remainingKopecks/100,
    days:Array.from({length:10},(_,i)=>({day:i+1,...amount(byDay.get(i+1))})),categories:(result[3].results||[]).map(row=>({category:row.category,...amount(row)}))});
}
async function quests(req,db,actor,rest) {
  if (rest!=='/quests') return null;
  if (req.method==='GET') {
    const rows=(await db.prepare('SELECT day,quest_id,completed FROM command_quests ORDER BY day,quest_id').all()).results||[];
    return reply({ok:true,quests:rows.map(row=>({day:row.day,questId:row.quest_id,completed:row.completed===1}))});
  }
  if (req.method==='PUT') {
    if (!actor.editor) return denied();
    const value=await body(req);
    if (!only(value,['day','questId','completed'])||!dayValid(value.day)||!new RegExp('^d'+value.day+'-q[1-5]$').test(value.questId)||typeof value.completed!=='boolean') return invalid();
    const at=stamp();
    await db.batch([
      db.prepare('INSERT INTO command_quests(day,quest_id,completed,updated_at,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(day,quest_id) DO UPDATE SET completed=excluded.completed,updated_at=excluded.updated_at,updated_by=excluded.updated_by').bind(value.day,value.questId,value.completed?1:0,at,actor.email),
      stateChange(db,actor,at),audit(db,'command_quest_changed',actor,value.questId,at)
    ]);
    return reply({ok:true,quest:{day:value.day,questId:value.questId,completed:value.completed}});
  }
  return null;
}
const aggregateSql=`SELECT day,COUNT(*) AS researched,COUNT(*) AS visits,
  SUM(CASE WHEN outcome IN ('dialogue','interest','meeting','pilot','contract') THEN 1 ELSE 0 END) AS dialogues,
  SUM(CASE WHEN person<>'' THEN 1 ELSE 0 END) AS contacts,
  SUM(CASE WHEN outcome IN ('meeting','pilot','contract') THEN 1 ELSE 0 END) AS meetings,
  SUM(CASE WHEN outcome IN ('interest','meeting','pilot','contract') THEN 1 ELSE 0 END) AS proposals,
  SUM(CASE WHEN outcome IN ('pilot','contract') THEN 1 ELSE 0 END) AS pilots,
  SUM(CASE WHEN outcome='contract' THEN 1 ELSE 0 END) AS contracts
  FROM command_contacts GROUP BY day`;
async function publish(req,env,actor) {
  if (!actor.approver) return denied();
  const value=await body(req);
  if (!only(value,['confirm'])||value.confirm!==true) return invalid();
  // A single D1 read batch gives one consistent private-data snapshot.
  const result=await env.DB.batch([
    env.DB.prepare('SELECT revision,updated_by FROM command_state WHERE slot=1'),
    env.DB.prepare(aggregateSql),
    env.DB.prepare('SELECT day,SUM(amount_kopecks) AS amount_kopecks FROM command_expenses GROUP BY day'),
    env.DB.prepare('SELECT day,quest_id FROM command_quests WHERE completed=1 ORDER BY day,quest_id'),
    env.DB.prepare('SELECT version FROM command_public WHERE slot=1')
  ]);
  const state=result[0].results?.[0];
  if (!state) return reply({ok:false,error:'Схема базы не готова.'},503);
  if (env.REQUIRE_TWO_PERSON_REVIEW==='true'&&state.updated_by===actor.email) return reply({ok:false,error:'Публикацию должен подтвердить другой утверждающий.'},403);
  const previous=result[4].results?.[0]?.version||0;
  const byDay=new Map(Array.from({length:10},(_,i)=>[i+1,zeroMetrics()]));
  for (const row of result[1].results||[]) {
    const metrics=byDay.get(row.day);if (!metrics) continue;
    for (const key of ['researched','visits','dialogues','contacts','meetings','proposals','pilots','contracts']) metrics[key]=Number(row[key]||0);
    metrics.decisionMeetings=metrics.meetings;
  }
  for (const row of result[2].results||[]) if (byDay.has(row.day)) byDay.get(row.day).expensesRub=Number(row.amount_kopecks)/100;
  const questRows=(result[3].results||[]).filter(row=>dayValid(row.day)&&new RegExp('^d'+row.day+'-q[1-5]$').test(row.quest_id));
  for (const row of questRows) { const metrics=byDay.get(row.day);metrics.questsCompleted++;metrics.xp+=questXP[Number(row.quest_id.slice(-1))-1]; }
  const total=zeroMetrics();
  for (const metrics of byDay.values()) for (const key of metricKeys) total[key]+=metrics[key];
  total.expensesRub=Math.round(total.expensesRub*100)/100;
  const at=stamp();
  const document={ok:true,status:'published',version:previous+1,reviewedAt:at,metrics:total,days:[...byDay].map(([day,metrics])=>({day,metrics})),quests:questRows.map(row=>({day:row.day,questId:row.quest_id,completed:true}))};
  // Audit and publication share a transaction and the same source/version guard.
  // A withdrawal always advances the generation, including a first-ever tombstone.
  const versionGuard='((?=0 AND NOT EXISTS(SELECT 1 FROM command_public WHERE slot=1)) OR EXISTS(SELECT 1 FROM command_public WHERE slot=1 AND version=?))';
  const saved=await env.DB.batch([
    audit(env.DB,'command_aggregates_published',actor,null,at,
      ' WHERE EXISTS(SELECT 1 FROM command_state WHERE slot=1 AND revision=?) AND '+versionGuard,
      [state.revision,previous,previous]),
    env.DB.prepare(`INSERT INTO command_public(slot,version,source_revision,document_json,reviewed_by,reviewed_at)
      SELECT 1,?,?,?,?,? FROM command_state WHERE slot=1 AND revision=? AND ${versionGuard}
      ON CONFLICT(slot) DO UPDATE SET version=excluded.version,source_revision=excluded.source_revision,document_json=excluded.document_json,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at
      WHERE command_public.version=?`).bind(previous+1,state.revision,JSON.stringify(document),actor.email,at,state.revision,previous,previous,previous)
  ]);
  if (!saved[1]?.meta?.changes) return conflict();
  return reply({ok:true,publication:document});
}
function publicMetrics(value) {
  if (!plain(value)) throw Error('Bad public metrics');
  const result={};
  for (const key of metricKeys) {
    const x=value[key];
    if (!Number.isFinite(x)||x<0||(key!=='expensesRub'&&!Number.isSafeInteger(x))) throw Error('Bad public metric');
    result[key]=x;
  }
  return result;
}
function publicDocument(text) {
  const value=JSON.parse(text);
  if (value.status==='unpublished') return unpublished();
  if (value.status!=='published'||!Number.isSafeInteger(value.version)||value.version<1||!Number.isFinite(Date.parse(value.reviewedAt))||!Array.isArray(value.days)||value.days.length>10||!Array.isArray(value.quests)||value.quests.length>50) throw Error('Bad snapshot');
  const days=value.days.map(row=>{if (!dayValid(row.day)) throw Error('Bad day');return {day:row.day,metrics:publicMetrics(row.metrics)};});
  const quests=value.quests.map(row=>{if (!dayValid(row.day)||!new RegExp('^d'+row.day+'-q[1-5]$').test(row.questId)||row.completed!==true) throw Error('Bad quest');return {day:row.day,questId:row.questId,completed:true};});
  return {ok:true,status:'published',version:value.version,reviewedAt:value.reviewedAt,metrics:publicMetrics(value.metrics),days,quests};
}
async function exportCommand(req,db,actor,url) {
  if (!actor.editor) return denied();
  if (req.headers.get('Sec-Fetch-Site')==='cross-site'||(req.headers.has('Origin')&&req.headers.get('Origin')!==url.origin)) return denied();
  const format=url.searchParams.get('format')||'json';
  if (!['json','contacts.csv','expenses.csv'].includes(format)) return invalid();
  if (!await ledgerReady(db)) return missingLedger();
  // Each table is read in one transaction, with count guards evaluated inside
  // that same snapshot. An oversized export fails before data is serialized;
  // it must never look like a complete but silently truncated owner download.
  const result=await db.batch([
    db.prepare('SELECT revision FROM command_state WHERE slot=1'),
    db.prepare('SELECT (SELECT COUNT(*) FROM command_contacts) AS contacts,(SELECT COUNT(*) FROM command_expenses) AS expenses,(SELECT COUNT(*) FROM command_quests) AS quests'),
    db.prepare('SELECT * FROM command_contacts WHERE ?=1 AND (SELECT COUNT(*) FROM command_contacts)<=? ORDER BY created_at,id LIMIT ?').bind(format!=='expenses.csv'?1:0,EXPORT_ROW_LIMIT,EXPORT_ROW_LIMIT),
    db.prepare('SELECT * FROM command_expenses WHERE ?=1 AND (SELECT COUNT(*) FROM command_expenses)<=? ORDER BY created_at,id LIMIT ?').bind(format!=='contacts.csv'?1:0,EXPORT_ROW_LIMIT,EXPORT_ROW_LIMIT),
    db.prepare('SELECT day,quest_id,completed,updated_at FROM command_quests WHERE ?=1 ORDER BY day,quest_id LIMIT 51').bind(format==='json'?1:0),
    db.prepare('SELECT version,source_revision,document_json,reviewed_at FROM command_public WHERE slot=1 AND ?=1').bind(format==='json'?1:0)
  ]);
  // Schema-only deployments create command_state on the first authenticated
  // mutation. Before that, a complete empty snapshot has business revision 0.
  const counts=result[1].results?.[0],revision=result[0].results?.[0]?.revision??0;
  const tooLarge=()=>reply({ok:false,code:'export_too_large',error:'Полная выгрузка превышает безопасный размер. Файл не создан и данные не обрезаны. Используйте прямой резервный экспорт базы владельцем.',limits:{rowsPerTable:EXPORT_ROW_LIMIT,bytes:EXPORT_BYTE_LIMIT}},413);
  if ((format!=='expenses.csv'&&counts.contacts>EXPORT_ROW_LIMIT)||(format!=='contacts.csv'&&counts.expenses>EXPORT_ROW_LIMIT)||(format==='json'&&counts.quests>50)) return tooLarge();
  const publicationRow=result[5].results?.[0];
  let publication=null;
  if (publicationRow) {
    try {publication={version:publicationRow.version,sourceRevision:publicationRow.source_revision,reviewedAt:publicationRow.reviewed_at,snapshot:publicDocument(publicationRow.document_json)};}
    catch {return reply({ok:false,code:'invalid_publication',error:'Не удалось прочитать опубликованную сводку. Полная выгрузка не создана.'},503);}
  }
  const exportedAt=stamp();
  const snapshot={schemaVersion:1,project:'OSMANX MOSCOW 1000',exportedAt,revision,counts:{contacts:counts.contacts,expenses:counts.expenses,quests:counts.quests},
    contacts:(result[2].results||[]).map(contactDto),expenses:(result[3].results||[]).map(expenseDto),
    quests:(result[4].results||[]).map(row=>({day:row.day,questId:row.quest_id,completed:row.completed===1,updatedAt:row.updated_at})),publication};
  const encoded=await commandExportBytes(snapshot,format);if (!encoded) return tooLarge();
  // A successful download is recorded without advancing the business revision.
  // If audit storage fails, return an error, never an unaudited attachment.
  try {await db.batch([audit(db,'command_data_exported',actor,'revision:'+revision+':'+format,exportedAt)]);}
  catch {return reply({ok:false,code:'export_audit_unavailable',error:'Не удалось записать выгрузку в журнал. Повторите скачивание позже.'},503);}
  const count=format==='contacts.csv'?counts.contacts:format==='expenses.csv'?counts.expenses:counts.contacts+counts.expenses+counts.quests;
  const suffix=format==='json'?'backup.json':format;
  return new Response(encoded.bytes,{status:200,headers:{...headers,
    'Content-Type':format==='json'?'application/json; charset=utf-8':'text/csv; charset=utf-8',
    'Content-Disposition':'attachment; filename="OSMANX_R8_'+exportedAt.slice(0,10)+'_r'+revision+'_'+suffix+'"',
    'Content-Digest':encoded.contentDigest,'X-Content-SHA256':encoded.sha256,
    'X-Export-Revision':String(revision),'X-Export-Count':String(count),'X-Export-Contacts':String(counts.contacts),'X-Export-Expenses':String(counts.expenses),'X-Export-Quests':String(counts.quests)
  }});
}
const commandAuditEvents={
  contact:['command_contact_created','command_contact_updated','command_contact_erased'],
  expense:['command_expense_created','command_expense_updated','command_expense_erased'],
  quest:['command_quest_changed'],publication:['command_aggregates_published','command_aggregates_unpublished'],export:['command_data_exported']
};
function encodeAuditCursor(value) {return btoa(JSON.stringify(value)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function decodeAuditCursor(text,category) {
  if (!/^[A-Za-z0-9_-]{1,600}$/.test(text)) return null;
  try {
    const value=JSON.parse(atob(text.replaceAll('-','+').replaceAll('_','/')));
    return Array.isArray(value)&&value.length===5&&value[0]===1&&value[1]===category&&Number.isSafeInteger(value[2])&&value[2]>=0&&typeof value[3]==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value[3])&&Number.isFinite(Date.parse(value[3]))&&typeof value[4]==='string'&&/^[0-9a-f-]{36}$/.test(value[4])?value:null;
  } catch {return null;}
}
async function commandAudit(db,url) {
  const category=url.searchParams.get('category')||'all';
  if (category!=='all'&&!Object.hasOwn(commandAuditEvents,category)) return invalid();
  const raw=url.searchParams.get('cursor'),cursor=raw===null?null:decodeAuditCursor(raw,category);
  if (raw!==null&&!cursor) return invalid();
  const events=category==='all'?Object.values(commandAuditEvents).flat():commandAuditEvents[category];
  const allowed='event IN ('+events.map(()=>'?').join(',')+')';
  const ceiling=cursor?' AND rowid<=?':'',ceilingArgs=cursor?[cursor[2]]:[];
  const after=cursor?' AND (at<? OR (at=? AND id<?))':'',afterArgs=cursor?[cursor[3],cursor[3],cursor[4]]:[];
  const result=await db.batch([
    db.prepare('SELECT id,event,actor,subject_id,at FROM operator_audit WHERE '+allowed+ceiling+after+' ORDER BY at DESC,id DESC LIMIT 26').bind(...events,...ceilingArgs,...afterArgs),
    db.prepare('SELECT COUNT(*) AS total,COALESCE(MAX(rowid),0) AS ceiling FROM operator_audit WHERE '+allowed+ceiling).bind(...events,...ceilingArgs)
  ]);
  const rows=result[0].results||[],summary=result[1].results?.[0],page=rows.slice(0,25),last=page.at(-1);
  const safeSubject=value=>typeof value==='string'&&(/^[0-9a-f-]{36}$/.test(value)||/^d(?:10|[1-9])-q[1-5]$/.test(value)||/^revision:\d+:(?:json|contacts\.csv|expenses\.csv)$/.test(value))?value:null;
  return reply({ok:true,events:page.map(row=>({id:row.id,event:row.event,actor:row.actor,subjectId:safeSubject(row.subject_id),at:row.at})),total:summary.total,
    nextCursor:rows.length>25?encodeAuditCursor([1,category,cursor?cursor[2]:summary.ceiling,last.at,last.id]):null});
}
export async function publicCommandSnapshot(env) {
  if (!env.DB) return reply({ok:false,status:'unavailable',error:'Публичные данные пока не подключены.'},503);
  try {
    const row=await env.DB.prepare('SELECT document_json FROM command_public WHERE slot=1').first();
    if (!row) return reply(unpublished());
    // Construct a new whitelist-only object even if storage accidentally contains private keys.
    return reply(publicDocument(row.document_json));
  } catch { return reply({ok:false,status:'unavailable',error:'Не удалось получить проверенные данные.'},503); }
}
export async function commandRoute(req,env,actor=null) {
  const url=new URL(req.url),rest=url.pathname.slice(ROOT.length);
  if (rest==='/public'&&req.method==='GET') return publicCommandSnapshot(env);
  if (!actor) return reply({ok:false,error:'Войдите в админку.'},401);
  if (!actor.editor&&!actor.approver&&!actor.moderator) return denied();
  if (!env.DB) return reply({ok:false,error:'База данных не подключена.'},503);
  if (!['GET','HEAD'].includes(req.method)&&(req.headers.get('Origin')!==url.origin||!req.headers.get('Content-Type')?.startsWith('application/json'))) return reply({ok:false,error:'Неверный Origin или Content-Type.'},403);
  try {
    await env.DB.prepare('SELECT revision FROM command_state WHERE slot=1').first();
  } catch { return reply({ok:false,error:'Сначала примените миграцию R6.'},503); }
  if (rest.startsWith('/contacts')) return await contacts(req,env.DB,actor,rest,url)||reply({ok:false,error:'Route not found'},404);
  if (rest.startsWith('/expenses')) return await expenses(req,env.DB,actor,rest,url)||reply({ok:false,error:'Route not found'},404);
  if (rest==='/budget'&&req.method==='GET') return budget(env.DB);
  if (rest==='/export'&&req.method==='GET') return exportCommand(req,env.DB,actor,url);
  if (rest==='/audit'&&req.method==='GET') return commandAudit(env.DB,url);
  if (rest==='/quests') return await quests(req,env.DB,actor,rest)||reply({ok:false,error:'Route not found'},404);
  if (rest==='/publish'&&req.method==='POST') return publish(req,env,actor);
  if (rest==='/unpublish'&&req.method==='POST') {
    if (!actor.approver) return denied();
    if (!only(await body(req),[])) return invalid();
    const at=stamp();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO command_public(slot,version,source_revision,document_json,reviewed_by,reviewed_at)
        VALUES(1,1,(SELECT revision FROM command_state WHERE slot=1),?,?,?)
        ON CONFLICT(slot) DO UPDATE SET version=command_public.version+1,source_revision=excluded.source_revision,document_json=excluded.document_json,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at`).bind(JSON.stringify(unpublished()),actor.email,at),
      audit(env.DB,'command_aggregates_unpublished',actor,null,at)
    ]);
    return reply({ok:true,status:'unpublished'});
  }
  return reply({ok:false,error:'Route not found'},404);
}
