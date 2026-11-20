/** Private expedition command center. Public access is only to an explicitly approved aggregate snapshot. */
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
const expenseDto=row=>({id:row.id,day:row.day,amountRub:row.amount_kopecks/100,category:row.category,note:row.note,createdAt:row.created_at});
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
    const page=pagination(url);if (!page) return invalid();
    const where=page.day===null?'':' WHERE day=?';
    const rows=(await db.prepare('SELECT * FROM command_contacts'+where+' ORDER BY created_at DESC,id DESC LIMIT 26 OFFSET ?').bind(...(page.day===null?[]:[page.day]),page.offset).all()).results||[];
    return reply({ok:true,contacts:rows.slice(0,25).map(contactDto),nextOffset:rows.length>25?page.offset+25:null});
  }
  if (rest==='/contacts'&&req.method==='POST') {
    if (!actor.editor) return denied();
    const value=contactInput(await body(req));if (!value) return invalid();
    const id=uuid(),at=stamp();
    await db.batch([
      db.prepare('INSERT INTO command_contacts(id,day,name,category,person,channel,outcome,problem,next_step,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,value.day,value.name,value.category,value.person,value.channel,value.outcome,value.problem,value.nextStep,at,at,actor.email),
      stateChange(db,actor,at),audit(db,'command_contact_created',actor,id,at)
    ]);
    const row=await db.prepare('SELECT * FROM command_contacts WHERE id=?').bind(id).first();
    return reply({ok:true,contact:contactDto(row)},201);
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
async function expenses(req,db,actor,rest,url) {
  if (rest==='/expenses'&&req.method==='GET') {
    const page=pagination(url);if (!page) return invalid();
    const where=page.day===null?'':' WHERE day=?';
    const rows=(await db.prepare('SELECT * FROM command_expenses'+where+' ORDER BY created_at DESC,id DESC LIMIT 26 OFFSET ?').bind(...(page.day===null?[]:[page.day]),page.offset).all()).results||[];
    return reply({ok:true,expenses:rows.slice(0,25).map(expenseDto),nextOffset:rows.length>25?page.offset+25:null});
  }
  if (rest==='/expenses'&&req.method==='POST') {
    if (!actor.editor) return denied();
    const value=await body(req),amount=Math.round((value?.amountRub||0)*100);
    if (!only(value,['day','amountRub','category','note'])||!dayValid(value.day)||typeof value.amountRub!=='number'||!Number.isSafeInteger(amount)||amount<1||amount>100000000||Math.abs(value.amountRub*100-amount)>1e-6||!clean(value.category,80,true)||(value.note!==undefined&&!clean(value.note,300))) return invalid();
    const id=uuid(),at=stamp();
    await db.batch([
      db.prepare('INSERT INTO command_expenses(id,day,amount_kopecks,category,note,created_at,created_by) VALUES(?,?,?,?,?,?,?)').bind(id,value.day,amount,value.category.trim(),(value.note||'').trim(),at,actor.email),
      stateChange(db,actor,at),audit(db,'command_expense_created',actor,id,at)
    ]);
    return reply({ok:true,expense:expenseDto(await db.prepare('SELECT * FROM command_expenses WHERE id=?').bind(id).first())},201);
  }
  const match=/^\/expenses\/([0-9a-f-]{36})$/.exec(rest);
  if (match&&req.method==='DELETE') {
    if (!actor.editor) return denied();
    if (!only(await body(req),[])) return invalid();
    const id=match[1],at=stamp();
    const result=await db.batch([
      audit(db,'command_expense_erased',actor,null,at,' WHERE EXISTS(SELECT 1 FROM command_expenses WHERE id=?)',[id]),
      stateChange(db,actor,at,' AND EXISTS(SELECT 1 FROM command_expenses WHERE id=?)',[id]),
      db.prepare('DELETE FROM command_expenses WHERE id=?').bind(id)
    ]);
    return result[2]?.meta?.changes?reply({ok:true,erased:true}):reply({ok:false,error:'Запись не найдена.'},404);
  }
  return null;
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
export async function publicCommandSnapshot(env) {
  if (!env.DB) return reply({ok:false,status:'unavailable',error:'Публичные данные пока не подключены.'},503);
  try {
    const row=await env.DB.prepare('SELECT document_json FROM command_public WHERE slot=1').first();
    if (!row) return reply(unpublished());
    const value=JSON.parse(row.document_json);
    if (value.status==='unpublished') return reply(unpublished());
    if (value.status!=='published'||!Number.isSafeInteger(value.version)||value.version<1||!Number.isFinite(Date.parse(value.reviewedAt))||!Array.isArray(value.days)||value.days.length>10||!Array.isArray(value.quests)||value.quests.length>50) throw Error('Bad snapshot');
    const days=value.days.map(row=>{if (!dayValid(row.day)) throw Error('Bad day');return {day:row.day,metrics:publicMetrics(row.metrics)};});
    const quests=value.quests.map(row=>{if (!dayValid(row.day)||!new RegExp('^d'+row.day+'-q[1-5]$').test(row.questId)||row.completed!==true) throw Error('Bad quest');return {day:row.day,questId:row.questId,completed:true};});
    // Construct a new whitelist-only object even if storage accidentally contains private keys.
    return reply({ok:true,status:'published',version:value.version,reviewedAt:value.reviewedAt,metrics:publicMetrics(value.metrics),days,quests});
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
