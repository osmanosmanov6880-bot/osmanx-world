// OSMANX Guest Intelligence R4 — real, authenticated multi-company pilot API.
// Reuses Industry API hashed sessions, CSRF, membership checks and PostgreSQL RLS.
// Deliberately does NOT issue invoices, charge cards, email prospects or assert causal lift.
import { createHash } from 'node:crypto';
import { recordChange } from './database.mjs';
import { money, count } from '../shared/experiment-model.js';
import { READINESS_KEYS, readiness, planSampleSize, weeklyLedger, evaluate, reportCsv } from '../shared/pilot-model.js';

const ROLES=['owner','manager','operator'];
const MANAGE=['owner','manager'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN=/^[A-Za-z0-9._:-]{8,80}$/;
const PLAN_KEYS=['baselinePct','liftPp','margin','discount','fixed','fee'];
const PERIOD_KEYS=['date','control','controlReturn','offer','offerReturn'];
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function problem(status,message){const e=new Error(message);e.statusCode=status;return e;}
function exact(value,allowed,what){
  if(!value||typeof value!=='object'||Array.isArray(value))throw problem(400,what+': требуется объект');
  const seen=Object.keys(value);
  if(seen.some(k=>!allowed.includes(k)))throw problem(400,what+': лишние поля запрещены');
  return value;
}
function requiredKeys(value,keys,what){
  exact(value,keys,what);
  if(keys.some(k=>!Object.hasOwn(value,k)))throw problem(400,what+': отсутствуют обязательные поля');
}
function uuid(raw){
  if(typeof raw!=='string'||!UUID.test(raw))throw problem(400,'Некорректный ID');
  return raw;
}
function label(raw){
  if(typeof raw!=='string'||raw.trim().length<3||raw.trim().length>120||/[\u0000-\u001f\u007f]/.test(raw))
    throw problem(400,'Название пилота: от 3 до 120 символов, без управляющих кодов');
  return raw.trim();
}
function keyOf(req){
  const key=req.headers['idempotency-key'];
  if(typeof key!=='string'||!TOKEN.test(key))throw problem(400,'Требуется Idempotency-Key от 8 до 80 безопасных символов');
  return key;
}
function versionOf(body){
  if(!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<1)
    throw problem(400,'Укажите целочисленный expectedVersion');
  return body.expectedVersion;
}
function guard(fn){try{return fn();}catch(error){if(error.statusCode)throw error;throw problem(400,error.message);}}
function parsePlan(raw){
  requiredKeys(raw,PLAN_KEYS,'Финансовый план');
  return guard(()=>{
    const baselinePct=Number(raw.baselinePct),liftPp=Number(raw.liftPp);
    // The shared R3 model performs strict bounds and normalizes precision.
    const sizing=planSampleSize(raw.baselinePct,raw.liftPp);
    return {plan:{
      baselinePct:Number((sizing.baseline*100).toFixed(2)),
      liftPp:Number((sizing.lift*100).toFixed(2)),
      margin:money(raw.margin,'Маржа'),discount:money(raw.discount,'Цена предложения'),
      fixed:money(raw.fixed,'Прочие расходы'),fee:money(raw.fee,'Стоимость услуги')
    },target:sizing.perGroup};
  });
}
function parseReadiness(raw){
  requiredKeys(raw,READINESS_KEYS,'Готовность');
  return guard(()=>readiness(raw));
}
function parseDate(raw){
  if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw))throw problem(400,'Дата: формат YYYY-MM-DD');
  const [year,month,day]=raw.split('-').map(Number);
  if(year<2020||year>2100)throw problem(400,'Дата вне допустимого диапазона');
  const d=new Date(Date.UTC(year,month-1,day));
  if(d.toISOString().slice(0,10)!==raw)throw problem(400,'Несуществующая дата');
  return raw;
}
function parseObservation(raw){
  requiredKeys(raw,PERIOD_KEYS,'Наблюдение');
  const date=parseDate(raw.date);
  return guard(()=>{
    const control=count(raw.control,'Контроль',{positive:true});
    const controlReturn=count(raw.controlReturn,'Возвраты контроля');
    const offer=count(raw.offer,'Предложение',{positive:true});
    const offerReturn=count(raw.offerReturn,'Возвраты предложения');
    if(controlReturn>control||offerReturn>offer)throw problem(400,'Возвраты не могут превышать число гостей');
    return {date,control,controlReturn,offer,offerReturn};
  });
}
function verifyVersion(pilot,version){
  if(pilot.version!==version)throw problem(409,'Пилот изменён другим сотрудником; обновите данные');
}
function expectPhase(pilot,allowed){
  if(!allowed.includes(pilot.phase))throw problem(409,'Переход из статуса '+pilot.phase+' запрещён');
}
const flatPilot=row=>({
  id:row.id,title:row.title,phase:row.phase,requestId:row.request_id,
  version:row.version,plan:row.plan,readiness:row.readiness,targetPerGroup:row.target_per_group,
  createdAt:row.created_at,updatedAt:row.updated_at,
  submittedDigest:row.submitted_digest,
  submittedBy:row.submitted_by,reviewedBy:row.reviewed_by,reviewedAt:row.reviewed_at
});
async function getPilot(db,tenant,id,lock=false){
  const result=await db.query(
    'SELECT * FROM industry.guest_pilots WHERE tenant_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),
    [tenant,uuid(id)]);
  if(!result.rowCount)throw problem(404,'Пилот не найден');
  return result.rows[0];
}
async function activeObservations(db,tenant,pilotId){
  const result=await db.query(
    "SELECT id,observed_on::text AS date,control_count AS control,control_return AS \"controlReturn\",offer_count AS offer,offer_return AS \"offerReturn\",created_at FROM industry.guest_observations WHERE tenant_id=$1 AND pilot_id=$2 AND voided_at IS NULL ORDER BY observed_on ASC,id ASC",
    [tenant,pilotId]);
  return result.rows;
}
function proof(pilot,observations){
  return digest({
    schema:'osmanx.guest.evidence.v1',
    plan:pilot.plan,readiness:pilot.readiness,targetPerGroup:pilot.target_per_group,
    observations:observations.map(({date,control,controlReturn,offer,offerReturn})=>({date,control,controlReturn,offer,offerReturn}))
  });
}
function calculate(pilot,observations){
  const clean=observations.map(({date,control,controlReturn,offer,offerReturn})=>({date,control,controlReturn,offer,offerReturn}));
  const basis={plan:pilot.plan,readiness:pilot.readiness,rows:clean,
    finalized:['in_review','reviewed','returned','archived'].includes(pilot.phase)};
  if(clean.length===0)return {status:'NO_OBSERVATIONS',report:null,analysis:null,evidenceDigest:proof(pilot,clean)};
  // All inputs originate in strict database constraints; R3 model is the source of math.
  const analysis=evaluate(basis);
  return {status:pilot.phase,report:analysis.report,analysis:{
    aggregate:analysis.ledger.aggregate,range:analysis.ledger.c.range,
    difference:analysis.ledger.c.difference,requiredPerGroup:analysis.sample.perGroup,
    ready:analysis.readinessResult.ready,enough:analysis.assessment.enough,
    financial:analysis.assessment.financial,risks:analysis.assessment.warnings,
    disposition:analysis.assessment.status,associationOnly:true
  },evidenceDigest:proof(pilot,clean),_evaluation:analysis};
}
async function record(db,session,action,targetId,data){
  await recordChange(db,session.tenant_id,session.account_id,'guest.'+action,targetId,data);
}
export function registerGuestRoutes(app,{prefix,forTenant,bodyOf}){
  const P=prefix+'/guest';

  // BLOCK 2: authenticated commercial intake with tenant-scoped idempotency.
  app.get(P+'/requests',req=>forTenant(req,null,async(db,s)=>{
    const rows=await db.query(
      'SELECT id,title,source,state,created_at,updated_at FROM industry.guest_requests WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
      [s.tenant_id]);
    return {items:rows.rows};
  }));
  app.post(P+'/requests',(req,reply)=>forTenant(req,ROLES,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['title','source'],'Заявка');
    const title=label(b.title),source=b.source,key=keyOf(req);
    if(!['field','referral','site','other'].includes(source))throw problem(400,'Недопустимый канал заявки');
    const hash=digest({title,source});
    const existing=await db.query('SELECT id,state,payload_digest FROM industry.guest_requests WHERE tenant_id=$1 AND idempotency_key=$2',[s.tenant_id,key]);
    if(existing.rowCount){
      if(existing.rows[0].payload_digest!==hash)throw problem(409,'Ключ заявки уже использован для других данных');
      return {duplicate:true,item:{id:existing.rows[0].id,state:existing.rows[0].state}};
    }
    const result=await db.query(
      'INSERT INTO industry.guest_requests(tenant_id,created_by,title,source,idempotency_key,payload_digest) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,title,source,state,created_at',
      [s.tenant_id,s.account_id,title,source,key,hash]);
    await record(db,s,'request.created',result.rows[0].id,{source});
    reply.code(201);return {item:result.rows[0]};
  }));
  app.patch(P+'/requests/:id',req=>forTenant(req,MANAGE,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['state'],'Изменение заявки');
    if(!['qualified','declined'].includes(b.state))throw problem(400,'Недопустимый статус');
    const id=uuid(req.params.id);
    const found=await db.query('SELECT state FROM industry.guest_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenant_id,id]);
    if(!found.rowCount)throw problem(404,'Заявка не найдена');
    if(found.rows[0].state!=='new')throw problem(409,'Заявка уже обработана');
    await db.query('UPDATE industry.guest_requests SET state=$1,updated_at=now() WHERE tenant_id=$2 AND id=$3',[b.state,s.tenant_id,id]);
    await record(db,s,'request.'+b.state,id);
    return {item:{id,state:b.state}};
  }));

  // BLOCK 3: plans, tenant-bound request conversion, readiness and optimistic lifecycle.
  app.get(P+'/pilots',req=>forTenant(req,null,async(db,s)=>{
    const r=await db.query(
      'SELECT id,title,phase,version,target_per_group,created_at,updated_at FROM industry.guest_pilots WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
      [s.tenant_id]);
    return {items:r.rows};
  }));
  app.post(P+'/pilots',(req,reply)=>forTenant(req,MANAGE,async(db,s)=>{
    const b=bodyOf(req);exact(b,['title','plan','requestId'],'Пилот');
    if(!Object.hasOwn(b,'title')||!Object.hasOwn(b,'plan'))throw problem(400,'Укажите название и план');
    const title=label(b.title),{plan,target}=parsePlan(b.plan);
    let requestId=null;
    if(b.requestId!==undefined&&b.requestId!==null){
      requestId=uuid(b.requestId);
      const request=await db.query('SELECT state FROM industry.guest_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenant_id,requestId]);
      if(!request.rowCount)throw problem(404,'Заявка не найдена');
      if(request.rows[0].state!=='qualified')throw problem(409,'Заявка ещё не квалифицирована или уже обработана');
    }
    const empty=Object.fromEntries(READINESS_KEYS.map(k=>[k,false]));
    const r=await db.query(
      'INSERT INTO industry.guest_pilots(tenant_id,request_id,created_by,title,plan,readiness,target_per_group) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) RETURNING *',
      [s.tenant_id,requestId,s.account_id,title,JSON.stringify(plan),JSON.stringify(empty),target]);
    if(requestId)await db.query(
      "UPDATE industry.guest_requests SET state='converted',updated_at=now() WHERE tenant_id=$1 AND id=$2",[s.tenant_id,requestId]);
    await record(db,s,'pilot.created',r.rows[0].id,{requestId});
    reply.code(201);return {item:flatPilot(r.rows[0])};
  }));
  app.get(P+'/pilots/:id',req=>forTenant(req,null,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const obs=await activeObservations(db,s.tenant_id,pilot.id);
    const reviews=await db.query(
      'SELECT id,actor_id,decision,evidence_digest,decided_at FROM industry.guest_reviews WHERE tenant_id=$1 AND pilot_id=$2 ORDER BY decided_at DESC LIMIT 30',
      [s.tenant_id,pilot.id]);
    return {item:flatPilot(pilot),observations:obs,reviews:reviews.rows};
  }));
  app.patch(P+'/pilots/:id/readiness',req=>forTenant(req,MANAGE,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion','readiness'],'Готовность пилота');
    const version=versionOf(b),checked=parseReadiness(b.readiness);
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    verifyVersion(pilot,version);expectPhase(pilot,['draft']);
    const result=await db.query(
      "UPDATE industry.guest_pilots SET readiness=$1::jsonb,version=version+1,updated_at=now() WHERE tenant_id=$2 AND id=$3 RETURNING *",
      [JSON.stringify(checked.checked),s.tenant_id,pilot.id]);
    await record(db,s,'pilot.readiness_updated',pilot.id);
    return {item:flatPilot(result.rows[0]),ready:checked.ready,blocking:checked.blocking};
  }));
  app.post(P+'/pilots/:id/start',req=>forTenant(req,MANAGE,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion'],'Запуск пилота');
    const version=versionOf(b);
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    verifyVersion(pilot,version);expectPhase(pilot,['draft']);
    if(!parseReadiness(pilot.readiness).ready)throw problem(409,'Не закрыты условия готовности');
    const r=await db.query(
      "UPDATE industry.guest_pilots SET phase='running',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
      [s.tenant_id,pilot.id]);
    await record(db,s,'pilot.started',pilot.id);
    return {item:flatPilot(r.rows[0])};
  }));

  // BLOCK 4: immutable raw aggregate counts + idempotency + correction by voiding.
  app.post(P+'/pilots/:id/observations',(req,reply)=>forTenant(req,ROLES,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion','observation'],'Добавление наблюдения');
    const version=versionOf(b),ob=parseObservation(b.observation),key=keyOf(req),hash=digest(ob);
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    const existing=await db.query(
      'SELECT id,payload_digest,voided_at FROM industry.guest_observations WHERE tenant_id=$1 AND pilot_id=$2 AND idempotency_key=$3',
      [s.tenant_id,pilot.id,key]);
    if(existing.rowCount){
      if(existing.rows[0].payload_digest!==hash)throw problem(409,'Idempotency-Key использован для другого наблюдения');
      return {duplicate:true,observationId:existing.rows[0].id,voided:!!existing.rows[0].voided_at,version:pilot.version};
    }
    verifyVersion(pilot,version);expectPhase(pilot,['running']);
    const previous=await db.query(
      'SELECT count(*)::int AS n FROM industry.guest_observations WHERE tenant_id=$1 AND pilot_id=$2 AND voided_at IS NULL',
      [s.tenant_id,pilot.id]);
    if(previous.rows[0].n>=12)throw problem(409,'Максимум 12 непересекающихся периодов');
    const inserted=await db.query(
      'INSERT INTO industry.guest_observations(tenant_id,pilot_id,observed_on,control_count,control_return,offer_count,offer_return,created_by,idempotency_key,payload_digest) VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      [s.tenant_id,pilot.id,ob.date,ob.control,ob.controlReturn,ob.offer,ob.offerReturn,s.account_id,key,hash]);
    const changed=await db.query(
      'UPDATE industry.guest_pilots SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING version',
      [s.tenant_id,pilot.id]);
    await record(db,s,'observation.added',inserted.rows[0].id,{pilotId:pilot.id});
    reply.code(201);
    return {observationId:inserted.rows[0].id,version:changed.rows[0].version};
  }));
  app.post(P+'/pilots/:id/observations/:observationId/void',req=>forTenant(req,MANAGE,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion'],'Отзыв наблюдения');
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    verifyVersion(pilot,versionOf(b));expectPhase(pilot,['running']);
    const id=uuid(req.params.observationId);
    const found=await db.query(
      'UPDATE industry.guest_observations SET voided_at=now(),voided_by=$1 WHERE tenant_id=$2 AND pilot_id=$3 AND id=$4 AND voided_at IS NULL RETURNING id',
      [s.account_id,s.tenant_id,pilot.id,id]);
    if(!found.rowCount)throw problem(404,'Активное наблюдение не найдено');
    const changed=await db.query(
      'UPDATE industry.guest_pilots SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING version',
      [s.tenant_id,pilot.id]);
    await record(db,s,'observation.voided',id,{pilotId:pilot.id});
    return {voided:true,version:changed.rows[0].version};
  }));

  // BLOCK 5: signed-in operator submits evidence; a different manager reviews it.
  app.post(P+'/pilots/:id/submit',req=>forTenant(req,MANAGE,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion'],'Представление результатов');
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    verifyVersion(pilot,versionOf(b));expectPhase(pilot,['running']);
    if(!parseReadiness(pilot.readiness).ready)throw problem(409,'Условия готовности не закрыты');
    const rows=await activeObservations(db,s.tenant_id,pilot.id);
    if(!rows.length)throw problem(409,'Нет агрегированных наблюдений');
    // Check shared statistical model before freezing the evidence.
    guard(()=>weeklyLedger(rows.map(({date,control,controlReturn,offer,offerReturn})=>({date,control,controlReturn,offer,offerReturn}))));
    const sha=proof(pilot,rows);
    const changed=await db.query(
      "UPDATE industry.guest_pilots SET phase='in_review',submitted_by=$1,submitted_digest=$2,reviewed_by=NULL,reviewed_at=NULL,version=version+1,updated_at=now() WHERE tenant_id=$3 AND id=$4 RETURNING *",
      [s.account_id,sha,s.tenant_id,pilot.id]);
    await record(db,s,'pilot.submitted',pilot.id,{evidenceDigest:sha});
    return {item:flatPilot(changed.rows[0]),evidenceDigest:sha};
  }));
  app.post(P+'/pilots/:id/review',req=>forTenant(req,MANAGE,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion','decision','evidenceDigest'],'Экспертная приёмка');
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    verifyVersion(pilot,versionOf(b));expectPhase(pilot,['in_review']);
    if(s.account_id===pilot.submitted_by)throw problem(403,'Нельзя проверять собственную отправку');
    if(!['accept_for_discussion','request_revision'].includes(b.decision))throw problem(400,'Недопустимое решение');
    if(typeof b.evidenceDigest!=='string'||!/^[a-f0-9]{64}$/.test(b.evidenceDigest))
      throw problem(400,'Неверная контрольная сумма доказательств');
    const obs=await activeObservations(db,s.tenant_id,pilot.id);
    const live=proof(pilot,obs);
    if(pilot.submitted_digest!==live||b.evidenceDigest!==live)
      throw problem(409,'Содержимое доказательств изменилось — требуется повторная подача');
    const summary=guard(()=>calculate(pilot,obs));
    if(b.decision==='accept_for_discussion' && !summary.analysis?.enough)
      throw problem(409,'Нельзя принять к обсуждению пилот с недостаточной выборкой');
    const phase=b.decision==='accept_for_discussion'?'reviewed':'returned';
    await db.query(
      'INSERT INTO industry.guest_reviews(tenant_id,pilot_id,actor_id,decision,evidence_digest) VALUES($1,$2,$3,$4,$5)',
      [s.tenant_id,pilot.id,s.account_id,b.decision,live]);
    const changed=await db.query(
      'UPDATE industry.guest_pilots SET phase=$1,reviewed_by=$2,reviewed_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$3 AND id=$4 RETURNING *',
      [phase,s.account_id,s.tenant_id,pilot.id]);
    await record(db,s,'pilot.'+phase,pilot.id,{evidenceDigest:live});
    return {item:flatPilot(changed.rows[0]),disclaimer:'Решение менеджера не доказывает рост, оплату или причинность.'};
  }));
  app.post(P+'/pilots/:id/resume',req=>forTenant(req,MANAGE,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion'],'Возобновление пилота');
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    verifyVersion(pilot,versionOf(b));expectPhase(pilot,['returned']);
    const changed=await db.query(
      "UPDATE industry.guest_pilots SET phase='running',submitted_by=NULL,submitted_digest=NULL,reviewed_by=NULL,reviewed_at=NULL,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *",
      [s.tenant_id,pilot.id]);
    await record(db,s,'pilot.resumed',pilot.id);
    return {item:flatPilot(changed.rows[0])};
  }));
  app.get(P+'/pilots/:id/report',req=>forTenant(req,null,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const observations=await activeObservations(db,s.tenant_id,pilot.id);
    const summary=calculate(pilot,observations);
    return {item:flatPilot(pilot),report:summary.report,analysis:summary.analysis,evidenceDigest:summary.evidenceDigest};
  }));
  app.get(P+'/pilots/:id/report.csv',(req,reply)=>forTenant(req,null,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const observations=await activeObservations(db,s.tenant_id,pilot.id);
    const summary=calculate(pilot,observations);
    if(!summary._evaluation)throw problem(409,'Нет наблюдений для экспорта');
    reply.header('Content-Type','text/csv; charset=utf-8');
    reply.header('Content-Disposition','attachment; filename="osmanx-guest-r4-report.csv"');
    return reply.send(reportCsv(summary._evaluation));
  }));
}
