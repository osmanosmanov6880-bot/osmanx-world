// OSMANX Guest Intelligence R4 — real, authenticated multi-company pilot API.
// Reuses Industry API hashed sessions, CSRF, membership checks and PostgreSQL RLS.
// Deliberately does NOT issue invoices, charge cards, email prospects or assert causal lift.
import { createHash } from 'node:crypto';
import { recordChange } from './database.mjs';
import { money, count, protocol as validateStudyProtocol } from '../shared/experiment-model.js';
import { READINESS_KEYS, readiness, planSampleSize, weeklyLedger, evaluate, reportCsv } from '../shared/pilot-model.js';

const ROLES=['owner','manager','operator'];
const MANAGE=['owner','manager'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN=/^[A-Za-z0-9._:-]{8,80}$/;
const PLAN_KEYS=['baselinePct','liftPp','margin','discount','fixed','fee'];
const PERIOD_KEYS=['date','control','controlReturn','offer','offerReturn'];
const PROTOCOL_KEYS=['startDate','endDate','outcomeWindowDays','allocation','source','primaryMetric'];
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
  const clean=raw.trim();
  if(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(clean)||
     /(?:\+?\d[\s().-]?){9,}/.test(clean))
    throw problem(400,'Названия не должны содержать email и телефоны');
  return clean;
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
function parseStudyProtocol(raw){
  requiredKeys(raw,PROTOCOL_KEYS,'Предварительный протокол');
  if(raw.primaryMetric!=='repeat_visit')throw problem(400,'Первичная метрика должна быть repeat_visit');
  if(!['pos','crm','manual'].includes(raw.source))
    throw problem(400,'Источник данных: pos, crm или manual');
  const p=guard(()=>validateStudyProtocol({
    startDate:raw.startDate,endDate:raw.endDate,
    allocation:raw.allocation,outcomeWindowDays:raw.outcomeWindowDays
  }));
  if(p.allocation==='unknown')throw problem(400,'Метод разделения на группы должен быть определён');
  return {startDate:p.startDate,endDate:p.endDate,
    outcomeWindowDays:p.outcomeWindowDays,allocation:p.allocation,
    source:raw.source,primaryMetric:'repeat_visit'};
}
function utcDate(){
  return new Date().toISOString().slice(0,10);
}
function checkPeriodInProtocol(pilot,date){
  if(!pilot.protocol)return; // archived R4/R7 legacy records only
  const p=pilot.protocol;
  if(date<p.startDate||date>p.endDate)
    throw problem(409,'Дата наблюдения не входит в заранее зафиксированный протокол');
  if(date>utcDate())throw problem(409,'Нельзя вводить наблюдение из будущего');
}
function assertMatured(pilot){
  if(!pilot.protocol)return;
  const {endDate,outcomeWindowDays}=pilot.protocol;
  const dayMs=86400000;
  const complete=Date.parse(endDate+'T00:00:00.000Z')+outcomeWindowDays*dayMs;
  if(Date.now()<complete)throw problem(409,'Окно наблюдения ещё не завершилось');
}
function prospective(pilot){
  if(!pilot.protocol)return null;
  // This is a fact about registration TIME, not proof of randomized assignment.
  return new Date(pilot.protocol_registered_at).getTime()<=
    Date.parse(pilot.protocol.startDate+'T00:00:00.000Z');
}
async function quota(db,tenant,type){
  // Transaction-scoped advisory lock serializes concurrent creations per tenant.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,8028))',[tenant]);
  const r=await db.query(
    'SELECT annual_request_limit,active_pilot_limit FROM industry.guest_quotas WHERE tenant_id=$1',[tenant]);
  const limits=r.rows[0]||{annual_request_limit:250,active_pilot_limit:50};
  const column=type==='request'?'annual_request_limit':'active_pilot_limit';
  const sql=type==='request'?
    "SELECT count(*)::int AS n FROM industry.guest_requests WHERE tenant_id=$1 AND created_at>=now()-interval '365 days'":
    "SELECT count(*)::int AS n FROM industry.guest_pilots WHERE tenant_id=$1 AND phase!='archived'";
  const usage=(await db.query(sql,[tenant])).rows[0].n;
  if(usage>=limits[column])throw problem(429,'Квота компании исчерпана; обратитесь к администратору');
  return {used:usage,limit:limits[column]};
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
  protocol:row.protocol||null,protocolRegisteredAt:row.protocol_registered_at||null,
  prospectivelyRegistered:prospective(row),
  createdAt:row.created_at,updatedAt:row.updated_at,
  submittedDigest:row.submitted_digest,
  submittedBy:row.submitted_by,reviewedBy:row.reviewed_by,reviewedAt:row.reviewed_at,
  archivedAt:row.archived_at,archivedBy:row.archived_by,archiveReason:row.archive_reason
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
function snapshot(pilot,observations){
  // Legacy archived R4/R7 proof must remain BYTE-COMPATIBLE for disaster recovery.
  const evidence={
    schema:pilot.protocol?'osmanx.guest.evidence.v2':'osmanx.guest.evidence.v1',
    plan:pilot.plan,readiness:pilot.readiness,targetPerGroup:pilot.target_per_group
  };
  if(pilot.protocol){
    evidence.protocol=pilot.protocol;
    evidence.protocolRegisteredAt=pilot.protocol_registered_at;
  }
  evidence.observations=observations.map(({date,control,controlReturn,offer,offerReturn})=>({date,control,controlReturn,offer,offerReturn}));
  return evidence;
}
function proof(pilot,observations){
  return digest(snapshot(pilot,observations));
}
function calculate(pilot,observations){
  const clean=observations.map(({date,control,controlReturn,offer,offerReturn})=>({date,control,controlReturn,offer,offerReturn}));
  const basis={plan:pilot.plan,readiness:pilot.readiness,rows:clean,
    finalized:['in_review','reviewed','returned','archived'].includes(pilot.phase)};
  if(clean.length===0)return {status:'NO_OBSERVATIONS',report:null,analysis:null,evidenceDigest:proof(pilot,clean)};
  // All inputs originate in strict database constraints; R3 model is the source of math.
  const analysis=evaluate(basis);
  const protocolNotice=pilot.protocol?'\nПротокол: '+pilot.protocol.startDate+' — '+pilot.protocol.endDate+
    '; окно '+pilot.protocol.outcomeWindowDays+' дней; метод '+pilot.protocol.allocation+
    '; источник '+pilot.protocol.source+'; '+(prospective(pilot)?'зарегистрирован до начала периода.':'зарегистрирован после начала периода: РЕТРОСПЕКТИВНЫЙ РИСК.'):'';
  return {status:pilot.phase,report:analysis.report+protocolNotice,analysis:{
    aggregate:analysis.ledger.aggregate,range:analysis.ledger.c.range,
    difference:analysis.ledger.c.difference,requiredPerGroup:analysis.sample.perGroup,
    ready:analysis.readinessResult.ready,enough:analysis.assessment.enough,
    financial:analysis.assessment.financial,risks:analysis.assessment.warnings,
    disposition:analysis.assessment.status,associationOnly:true,
    prospectivelyRegistered:prospective(pilot),protocol:pilot.protocol||null
  },evidenceDigest:proof(pilot,clean),_evaluation:analysis};
}
async function record(db,session,action,targetId,data){
  await recordChange(db,session.tenant_id,session.account_id,'guest.'+action,targetId,data);
}
export function registerGuestRoutes(app,{prefix,forTenant,bodyOf}){
  const P=prefix+'/guest';

  // R8 BLOCK 3: owner dashboard. No guest names/contacts: only RLS-filtered aggregates.
  app.get(P+'/overview',req=>forTenant(req,MANAGE,async(db,s)=>{
    // One transaction-scoped pg Client: always await queries sequentially.
    const requestStates=await db.query("SELECT state,count(*)::int AS n FROM industry.guest_requests WHERE tenant_id=$1 AND created_at>=now()-interval '365 days' GROUP BY state",[s.tenant_id]);
    const pilotStates=await db.query("SELECT phase,count(*)::int AS n FROM industry.guest_pilots WHERE tenant_id=$1 GROUP BY phase",[s.tenant_id]);
    const quotaResult=await db.query("SELECT annual_request_limit,active_pilot_limit FROM industry.guest_quotas WHERE tenant_id=$1",[s.tenant_id]);
    const observations=await db.query("SELECT count(*)::int AS periods,coalesce(sum(control_count),0)::bigint AS control,coalesce(sum(offer_count),0)::bigint AS offered FROM industry.guest_observations WHERE tenant_id=$1 AND voided_at IS NULL",[s.tenant_id]);
    const requestCounts=Object.fromEntries(['new','qualified','declined','converted'].map(x=>[x,0]));
    const phases=Object.fromEntries(['draft','running','in_review','returned','reviewed','archived'].map(x=>[x,0]));
    for(const row of requestStates.rows)requestCounts[row.state]=row.n;
    for(const row of pilotStates.rows)phases[row.phase]=row.n;
    const limits=quotaResult.rows[0]||{annual_request_limit:250,active_pilot_limit:50};
    const requestsUsed=Object.values(requestCounts).reduce((n,v)=>n+v,0);
    const pilotsUsed=Object.entries(phases).filter(([key])=>key!=='archived')
      .reduce((n,[,value])=>n+value,0);
    return {
      schema:'osmanx.guest.overview.v1',
      requests:requestCounts,pilots:phases,
      quotas:{requests:{used:requestsUsed,limit:limits.annual_request_limit,windowDays:365},
        activePilots:{used:pilotsUsed,limit:limits.active_pilot_limit}},
      aggregate:{periods:observations.rows[0].periods,
        control:Number(observations.rows[0].control),offered:Number(observations.rows[0].offered)},
      warning:'Числа показывают деятельность в компании, не причинный эффект, подтверждённую прибыль или оплату.'
    };
  }));

  // R8 BLOCK 4: safe bounded cleanup of declined, unlinked requests.
  // Preserve IDs, audit/outbox and decision; scrub only free-text PII-prone title.
  app.post(P+'/requests/retention',req=>forTenant(req,['owner'],async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['confirm'],'Очистка запросов');
    if(b.confirm!==true)throw problem(400,'Требуется явное подтверждение очистки');
    const changed=await db.query(
      "WITH candidates AS ("+
      " SELECT r.id FROM industry.guest_requests r WHERE r.tenant_id=$1"+
      " AND r.state='declined' AND r.redacted_at IS NULL"+
      " AND r.updated_at<now()-interval '90 days'"+
      " AND NOT EXISTS (SELECT 1 FROM industry.guest_pilots p WHERE p.tenant_id=$1 AND p.request_id=r.id)"+
      " ORDER BY r.updated_at ASC LIMIT 100 FOR UPDATE OF r SKIP LOCKED"+
      ") UPDATE industry.guest_requests r SET title='Данные удалены по сроку хранения',"+
      " redacted_at=now(),updated_at=now() FROM candidates c"+
      " WHERE r.tenant_id=$1 AND r.id=c.id RETURNING r.id",
      [s.tenant_id]
    );
    for(const {id} of changed.rows)await record(db,s,'request.redacted',id);
    return {redacted:changed.rowCount,limitPerRun:100,policy:'declined-unlinked-older-than-90-days'};
  }));

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
    await quota(db,s.tenant_id,'request');
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
    const b=bodyOf(req);exact(b,['title','plan','requestId','protocol'],'Пилот');
    if(!Object.hasOwn(b,'title')||!Object.hasOwn(b,'plan')||!Object.hasOwn(b,'protocol'))throw problem(400,'Укажите название, план и предварительный протокол');
    const title=label(b.title),{plan,target}=parsePlan(b.plan),study=parseStudyProtocol(b.protocol);
    let requestId=null;
    if(b.requestId!==undefined&&b.requestId!==null){
      requestId=uuid(b.requestId);
      const request=await db.query('SELECT state FROM industry.guest_requests WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenant_id,requestId]);
      if(!request.rowCount)throw problem(404,'Заявка не найдена');
      if(request.rows[0].state!=='qualified')throw problem(409,'Заявка ещё не квалифицирована или уже обработана');
    }
    await quota(db,s.tenant_id,'pilot');
    const empty=Object.fromEntries(READINESS_KEYS.map(k=>[k,false]));
    const r=await db.query(
      'INSERT INTO industry.guest_pilots(tenant_id,request_id,created_by,title,plan,readiness,target_per_group,protocol,protocol_registered_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,now()) RETURNING *',
      [s.tenant_id,requestId,s.account_id,title,JSON.stringify(plan),JSON.stringify(empty),target,JSON.stringify(study)]);
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
    if(!pilot.protocol)throw problem(409,'Исторический пилот без зарегистрированного протокола: запуск запрещён');
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
    checkPeriodInProtocol(pilot,ob.date);
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
    if(!pilot.protocol)throw problem(409,'Нет предварительно согласованного протокола');
    assertMatured(pilot);
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
  // R5 block 3: an independently reproducible, tenant-scoped evidence envelope.
  app.get(P+'/pilots/:id/evidence.json',(req,reply)=>forTenant(req,null,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const observations=await activeObservations(db,s.tenant_id,pilot.id);
    if(!observations.length)throw problem(409,'Нет агрегированных доказательств для экспорта');
    const evidence=snapshot(pilot,observations);
    const sha256=digest(evidence);
    const latest=(await db.query(
      'SELECT decision,actor_id,evidence_digest,decided_at FROM industry.guest_reviews WHERE tenant_id=$1 AND pilot_id=$2 ORDER BY decided_at DESC,id DESC LIMIT 1',
      [s.tenant_id,pilot.id])).rows[0]||null;
    if(['reviewed','archived'].includes(pilot.phase) &&
       (latest?.decision!=='accept_for_discussion' || latest.evidence_digest!==sha256 ||
        pilot.submitted_digest!==sha256)){
      throw problem(409,'Зафиксированный отчёт не совпадает с архивом доказательств');
    }
    const envelope={
      format:'osmanx.guest.evidence.export.v1',
      pilotId:pilot.id,phase:pilot.phase,sha256,evidence,
      review:latest,archivedAt:pilot.archived_at||null,
      disclaimer:'Слепок агрегированных данных. Подтверждение менеджера не доказывает причинный эффект, прибыль или оплату.'
    };
    reply.header('Content-Disposition','attachment; filename="osmanx-guest-evidence.json"');
    reply.header('Content-Type','application/json; charset=utf-8');
    return reply.send(envelope);
  }));

  // R5 block 3: only an OWNER may archive an independently approved pilot.
  // No deletes, no reopening: audit and review history remain intact.
  app.post(P+'/pilots/:id/archive',req=>forTenant(req,['owner'],async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion','reason'],'Архивация пилота');
    const version=versionOf(b);
    if(typeof b.reason!=='string'||b.reason.trim().length<6||
       b.reason.trim().length>160||/[\u0000-\u001f\u007f]/.test(b.reason))
      throw problem(400,'Причина архивации: от 6 до 160 символов без управляющих кодов');
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    verifyVersion(pilot,version);expectPhase(pilot,['reviewed']);
    const rows=await activeObservations(db,s.tenant_id,pilot.id);
    const latest=(await db.query(
      'SELECT decision,evidence_digest FROM industry.guest_reviews WHERE tenant_id=$1 AND pilot_id=$2 ORDER BY decided_at DESC,id DESC LIMIT 1',
      [s.tenant_id,pilot.id])).rows[0];
    const sha=proof(pilot,rows);
    if(!latest||latest.decision!=='accept_for_discussion'||latest.evidence_digest!==sha||
       pilot.submitted_digest!==sha)throw problem(409,'Нельзя архивировать неподтверждённые доказательства');
    const updated=await db.query(
      "UPDATE industry.guest_pilots SET phase='archived',archived_at=now(),archived_by=$1,archive_reason=$2,version=version+1,updated_at=now() WHERE tenant_id=$3 AND id=$4 RETURNING *",
      [s.account_id,b.reason.trim(),s.tenant_id,pilot.id]);
    await record(db,s,'pilot.archived',pilot.id,{evidenceDigest:sha});
    return {item:flatPilot(updated.rows[0]),sha256:sha};
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
