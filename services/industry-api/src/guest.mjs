// OSMANX Guest Intelligence R4 — real, authenticated multi-company pilot API.
// Reuses Industry API hashed sessions, CSRF, membership checks and PostgreSQL RLS.
// Deliberately does NOT issue invoices, charge cards, email prospects or assert causal lift.
import { createHash } from 'node:crypto';
import { recordChange } from './database.mjs';
import {diagnoseAggregates,RECOMMENDATIONS} from './guest-diagnostics.mjs';
import {parseAggregateCsv,validateBatchWindow,batchDigest,summarizeBatch} from './guest-bulk.mjs';
import {createOperationsOverview,createOperationsExport} from './guest-operations.mjs';
import {launchPreflight} from './guest-launch.mjs';
import {assessGuestQuality,buildSafetyExport,REASONS} from './guest-safety.mjs';
import {r19Configured,loadR19Scope,protocolDigest} from './guest-r19-scope.mjs';
import {inspectR19Budget} from './guest-r19-usage.mjs';
import {inspectR16Tenant} from './guest-r16-registry.mjs';
import {loadR17Witness} from './guest-r17-witness.mjs';
import {loadR18Anchor} from './guest-r18-anchor.mjs';
import {inspectR20Pilot} from './guest-r20-inspection.mjs';
import {auditR21Database} from './guest-r21-db-audit.mjs';
import {inspectR23Panel} from './guest-r23-panel.mjs';
import {inspectR24AggregateQuality} from './guest-r24-quality.mjs';
import {summarizeR24Retention} from './guest-r24-statistics.mjs';
import {modelR24Economics} from './guest-r24-economics.mjs';
import {buildR24Playbook} from './guest-r24-playbook.mjs';
import {createR24Brief,r24BriefCsv} from './guest-r24-brief.mjs';
import {parseR25Tally,R25_CODES} from './guest-r25-signals.mjs';
import {makeR25Brief,r25BriefCsv} from './guest-r25-brief.mjs';
import {parseR26ReviewRequest} from './guest-r26-review.mjs';
import {makeR26Brief,r26BriefCsv} from './guest-r26-brief.mjs';
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
  launchGateEnrolledAt:row.launch_gate_enrolled_at||null,
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
async function checkBatchSlots(db,tenant,pilot,rows){
  const active=await db.query(
    'SELECT observed_on::text AS date FROM industry.guest_observations WHERE tenant_id=$1 AND pilot_id=$2 AND voided_at IS NULL',
    [tenant,pilot.id]);
  const occupied=new Set(active.rows.map(row=>row.date));
  for(const row of rows)if(occupied.has(row.date))
    throw problem(409,'CSV содержит дату, уже занятую активным наблюдением: '+row.date);
  if(active.rowCount+rows.length>12)
    throw problem(409,'Максимум 12 активных непересекающихся периодов на пилот');
  return 12-active.rowCount;
}
function validatedCsv(raw,pilot,version){
  const rows=guard(()=>validateBatchWindow(parseAggregateCsv(raw),pilot.protocol));
  const hash=batchDigest(pilot.id,version,rows);
  return {rows,hash,summary:summarizeBatch(rows)};
}
async function addActionHistory(db,session,pilot,action,{type,previous=null}){
  const old=previous;
  await db.query(
    'INSERT INTO industry.guest_action_history(tenant_id,pilot_id,action_id,actor_id,event_type,from_status,to_status,previous_assignee,next_assignee,previous_due_on,next_due_on,action_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12)',
    [session.tenant_id,pilot.id,action.id,session.account_id,type,
      old?.status||null,action.status,old?.assigned_to||null,action.assigned_to,
      old?.due_on||null,action.due_on,action.version]
  );
}
async function validateAssignee(db,session,id){
  const assignee=uuid(id);
  const member=await db.query(
    "SELECT m.role FROM industry.memberships m JOIN industry.accounts a ON a.id=m.account_id WHERE m.tenant_id=$1 AND m.account_id=$2 AND NOT a.disabled",
    [session.tenant_id,assignee]);
  if(!member.rowCount||member.rows[0].role==='viewer')
    throw problem(400,'Назначить можно только действующего сотрудника с правом работы');
  return assignee;
}
function validDueWithin180(raw){
  const dueDate=parseDate(raw),today=new Date().toISOString().slice(0,10);
  const delta=(Date.parse(dueDate+'T00:00:00.000Z')-Date.parse(today+'T00:00:00.000Z'))/86400000;
  if(delta<0||delta>180)throw problem(400,'Срок исполнения должен быть в пределах 180 дней');
  return dueDate;
}
async function currentLaunchGate(db,tenant,pilot){
  // The tenant RLS transaction is inherited; expired and demoted signers never authorize.
  const members=await db.query(
    "SELECT m.account_id,m.role,NOT a.disabled AS active FROM industry.memberships m"+
    " JOIN industry.accounts a ON a.id=m.account_id"+
    " WHERE m.tenant_id=$1 AND m.role IN ('owner','manager')",
    [tenant]);
  const signed=await db.query(
    "SELECT DISTINCT ON (role) role,actor_id,snapshot_digest,accepted_at,expires_at"+
    " FROM industry.guest_launch_attestations WHERE tenant_id=$1 AND pilot_id=$2"+
    " ORDER BY role,accepted_at DESC,id DESC",
    [tenant,pilot.id]);
  return launchPreflight({pilot,members:members.rows,attestations:signed.rows});
}
async function getActiveHold(db,tenant,pilotId){
  const found=await db.query(
    'SELECT tenant_id,pilot_id,active,reason_code,held_by,held_at,resolved_by,resolved_at,version,updated_at'+
    ' FROM industry.guest_pilot_holds WHERE tenant_id=$1 AND pilot_id=$2',
    [tenant,pilotId]);
  return found.rows[0]||null;
}
async function assertUnheld(db,tenant,pilotId){
  const hold=await getActiveHold(db,tenant,pilotId);
  if(hold?.active)throw problem(409,'R13: сбор и представление результатов остановлены. Требуется независимое возобновление управляющим.');
}
function safetyReason(code){
  if(typeof code!=='string'||!REASONS.includes(code))
    throw problem(400,'Выберите конкретную причину из справочника безопасности');
  return code;
}
export function registerGuestRoutes(app,{prefix,forTenant,bodyOf}){
  const P=prefix+'/guest';

  // R11 leadership queue: no guest contacts; bounded, tenant-scoped risk signals.
  app.get(P+'/operations',req=>forTenant(req,MANAGE,async(db,s)=>{
    const result=await db.query(
      "SELECT p.id,p.title,p.phase,p.version,p.updated_at,p.protocol,"+
      " (SELECT count(*)::int FROM industry.guest_observations o WHERE o.tenant_id=$1 AND o.pilot_id=p.id AND o.voided_at IS NULL) AS period_count,"+
      " (SELECT count(*)::int FROM industry.guest_actions a WHERE a.tenant_id=$1 AND a.pilot_id=p.id AND a.status IN ('open','in_progress')) AS open_actions,"+
      " (SELECT count(*)::int FROM industry.guest_actions a WHERE a.tenant_id=$1 AND a.pilot_id=p.id AND a.status IN ('open','in_progress') AND a.due_on<CURRENT_DATE) AS overdue_actions"+
      " FROM industry.guest_pilots p WHERE p.tenant_id=$1 AND p.phase<>'archived'"+
      " ORDER BY p.updated_at ASC,p.id ASC LIMIT 101",
      [s.tenant_id]);
    return createOperationsOverview(result.rows,{limit:50});
  }));

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
  // R19: read-only first-customer activation preflight. No client details, no
  // consent documents and no action to enable writes or lift STOP is exposed.
  app.get(P+'/pilots/:id/r19/preflight',req=>forTenant(req,MANAGE,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const gate=await currentLaunchGate(db,s.tenant_id,pilot);
    const hold=await getActiveHold(db,s.tenant_id,pilot.id);
    let scope=null,reason=null;
    if(r19Configured(process.env)){
      try{scope=await loadR19Scope(process.env);}
      catch{reason='signed_scope_or_external_receipt_unavailable';}
    }else reason='r19_not_configured';
    let fingerprint=null;
    try{fingerprint=protocolDigest(pilot);}
    catch{/* Historical pilot without a locked protocol cannot be activated. */}
    const ownScope=!!scope&&scope.tenantId===s.tenant_id&&scope.pilotId===pilot.id;
    const budget=ownScope?
      await inspectR19Budget(db,s.tenant_id,pilot.id,scope):
      {available:false,used:null,maxDaily:null};
    const signedPeople=gate.checks.ownerSigned&&gate.checks.managerSigned&&
      gate.checks.independent;
    // R12 checks independent human approvals at draft -> running transition.
    // Later observation version increments must not retroactively invalidate
    // the legitimate start; R19 still rechecks protocol and R13 hold per write.
    const approvedAtLaunch=pilot.phase==='running'&&!!pilot.launch_gate_enrolled_at;
    const checks={
      signedTenantAndPilot:ownScope,
      exactRegisteredProtocol:ownScope&&scope.record.protocolDigest===fingerprint,
      launchTwoHumans:approvedAtLaunch||
        (signedPeople&&!!pilot.launch_gate_enrolled_at),
      correctLifecycle:pilot.phase==='draft'?
        gate.canStartIsolatedPilot:pilot.phase==='running',
      noSafetyHold:hold?.active!==true,
      withinDailyLimit:budget.available
    };
    const blockers=Object.entries(checks).filter(([,pass])=>!pass)
      .map(([code])=>code);
    if(reason)blockers.push(reason);
    return {
      schema:'osmanx.guest.r19.first-pilot-preflight.v1',
      pilotId:pilot.id,phase:pilot.phase,checks,
      blockers,technicalCollectionPreflight:ownScope&&blockers.length===0,
      scopeExpiresAt:ownScope?scope.expiresAt:null,
      maxDailyWrites:budget.maxDaily,usedToday:budget.used,
      protocolDigest:fingerprint,
      customerGo:false,legalApprovalNotVerified:true,
      productionChanged:false
    };
  }));

  // R20: tenant-scoped, owner/manager only, intentionally READ-ONLY.
  // All network-proof and operator release approvals are external; none of
  // these booleans can enable production or lift a safety STOP.
  app.get(P+'/pilots/:id/r20/inspection',req=>forTenant(req,MANAGE,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const hold=await getActiveHold(db,s.tenant_id,pilot.id);
    let permit=null,witness=null,anchor=null,scope=null;
    try{permit=await inspectR16Tenant(s.tenant_id,process.env);}
    catch{/* Missing R16 permits remain explicitly blocked. */}
    try{witness=await loadR17Witness(process.env);}
    catch{/* Missing R17 checkpoints remain explicitly blocked. */}
    if(witness){
      try{anchor=await loadR18Anchor(process.env,witness);}
      catch{/* Missing independent R18 remains blocked. */}
    }
    if(anchor){
      try{scope=await loadR19Scope(process.env,anchor);}
      catch{/* Missing R19 signed scope/STOP remains blocked. */}
    }
    const report=await inspectR20Pilot(db,{
      tenantId:s.tenant_id,pilot,hold,permit,witness,anchor,scope
    });
    // No raw consent evidence, key material, signer identities, other-tenant
    // URLs or PII-containing source documents leave this server.
    return report;
  }));

  // R21 database security/retention report. This request is strictly READ-ONLY,
  // tenant- and membership-bound; it never returns DB names, credentials,
  // key paths, raw customer records or independent operator documents.
  app.get(P+'/pilots/:id/r21/posture',req=>forTenant(req,MANAGE,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    let scope=null;
    try{scope=await loadR19Scope(process.env);}
    catch{/* Invalid/expired scope is NO-GO, not an HTTP 500. */}
    const scopeMatches=scope?.valid===true&&
      scope.tenantId===s.tenant_id&&scope.pilotId===pilot.id;
    const days=scopeMatches?scope.record.policy.retentionDays:30;
    const audit=await auditR21Database(db,{
      tenantId:s.tenant_id,pilotId:pilot.id,retentionDays:days
    });
    return {
      ...audit,
      signedScopeCurrent:scopeMatches,
      technicalPostureReady:audit.technicalPostureReady&&scopeMatches,
      blockers:scopeMatches?audit.blockers:
        [...audit.blockers,'signed_r19_scope_missing_or_wrong_pilot'],
      independentHostAuditVerified:false,
      signedReleaseChainVerified:false,
      legalEvidenceReviewed:false,
      externalWormRetentionVerified:false,
      productionAuthorized:false,
      legalGo:false,customerGo:false,productionChanged:false
    };
  }));

  // R22 combined first-pilot inspection remains strictly read-only.
  // Detached host, DR and two-human evidence are verified OFFLINE; never
  // infer their validity from mere filesystem existence on an API server.
  app.get(P+'/pilots/:id/r22/launch-review',req=>forTenant(req,MANAGE,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const hold=await getActiveHold(db,s.tenant_id,pilot.id);
    let permit=null,witness=null,anchor=null,scope=null;
    try{permit=await inspectR16Tenant(s.tenant_id,process.env);}catch{}
    try{witness=await loadR17Witness(process.env);}catch{}
    if(witness){
      try{anchor=await loadR18Anchor(process.env,witness);}catch{}
    }
    if(anchor){
      try{scope=await loadR19Scope(process.env,anchor);}catch{}
    }
    const permitForPilot=scope?.valid===true&&
      scope.tenantId===s.tenant_id&&scope.pilotId===pilot.id;
    const r21=await auditR21Database(db,{
      tenantId:s.tenant_id,pilotId:pilot.id,
      retentionDays:permitForPilot?scope.record.policy.retentionDays:30
    });
    const r20=await inspectR20Pilot(db,{
      tenantId:s.tenant_id,pilot,hold,permit,witness,anchor,scope
    });
    const checks={
      tenantIsolated:true,
      signedPilotScope:permitForPilot,
      emergencyHoldInactive:hold?.active!==true,
      sourceProtocolLocked:r20.checks.registeredProtocol===true,
      quotaMatchesAppendOnlyEvents:r21.checks.auditMatchesQuota===true,
      retentionRequiresNoAction:r21.checks.noOverRetentionDrift===true,
      databaseSecurityPasses:r21.technicalPostureReady===true,
      historicalTechnicalPasses:r20.technicalReviewPossible===true,
      independentVpsWitness:false,
      twoDistinctDrCopiesVerified:false,
      twoHumanReleaseTicketVerified:false,
      allPrsMergedAndMainProtected:false,
      legalAndOffsiteApproved:false
    };
    const pending=Object.entries(checks).filter(([,v])=>v!==true)
      .map(([key])=>key);
    return {schema:'osmanx.guest.r22.launch-review.v1',
      pilotId:pilot.id,phase:pilot.phase,checks,pending,
      operatorReviewNeeded:true,localTechnicalReviewPossible:[
        'signedPilotScope','emergencyHoldInactive','sourceProtocolLocked',
        'quotaMatchesAppendOnlyEvents','retentionRequiresNoAction',
        'databaseSecurityPasses','historicalTechnicalPasses'
      ].every(k=>checks[k]===true),
      daily:r20.daily,customerGo:false,legalGo:false,
      productionAuthorized:false,productionChanged:false};
  }));

  // R23: authenticated owner/manager handoff is local evidence only. The
  // external release plan and host/DR checks are never loaded from untrusted
  // browser fields or marked complete based on successful CI alone.
  app.get(P+'/pilots/:id/r23/handoff',req=>forTenant(req,MANAGE,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const hold=await getActiveHold(db,s.tenant_id,pilot.id);
    let permit=null,witness=null,anchor=null,scope=null;
    try{permit=await inspectR16Tenant(s.tenant_id,process.env);}catch{}
    try{witness=await loadR17Witness(process.env);}catch{}
    if(witness){try{anchor=await loadR18Anchor(process.env,witness);}catch{}}
    if(anchor){try{scope=await loadR19Scope(process.env,anchor);}catch{}}
    const validScope=scope?.valid===true&&
      scope.tenantId===s.tenant_id&&scope.pilotId===pilot.id;
    const days=validScope?scope.record.policy.retentionDays:30;
    const r20=await inspectR20Pilot(db,{
      tenantId:s.tenant_id,pilot,hold,permit,witness,anchor,scope
    });
    const r21=await auditR21Database(db,{
      tenantId:s.tenant_id,pilotId:pilot.id,retentionDays:days
    });
    return inspectR23Panel({
      pilot,tenantId:s.tenant_id,hold,scope,r20,r21
    });
  }));

  // R12 human pilot gate. Optional enrollment is irreversible; legacy pilots stay compatible.
  app.get(P+'/pilots/:id/launch/gate',req=>forTenant(req,null,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    return currentLaunchGate(db,s.tenant_id,pilot);
  }));

  app.post(P+'/pilots/:id/launch/enroll',req=>forTenant(req,['owner'],async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion','confirm'],'Включение двухсотрудникового допуска');
    if(b.confirm!==true)throw problem(400,'Требуется прямое подтверждение необратимого включения');
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    verifyVersion(pilot,versionOf(b));expectPhase(pilot,['draft']);
    if(pilot.launch_gate_enrolled_at)
      throw problem(409,'Двухсотрудниковый допуск уже включён и не может быть отменён');
    if(!pilot.protocol)
      throw problem(409,'Нужен предварительно зафиксированный протокол');
    const updated=await db.query(
      'UPDATE industry.guest_pilots SET launch_gate_enrolled_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
      [s.tenant_id,pilot.id]);
    await record(db,s,'launch.enrolled',pilot.id);
    return {item:flatPilot(updated.rows[0]),gate:await currentLaunchGate(db,s.tenant_id,updated.rows[0])};
  }));

  app.post(P+'/pilots/:id/launch/attest',(req,reply)=>forTenant(req,MANAGE,async(db,s,role)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion','acknowledge'],'Подтверждение запуска');
    if(b.acknowledge!==true)throw problem(400,'Подтверждение должно быть явным');
    const key=keyOf(req);
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    verifyVersion(pilot,versionOf(b));expectPhase(pilot,['draft']);
    if(!pilot.launch_gate_enrolled_at)throw problem(409,'Сначала владелец должен включить R12');
    const gate=await currentLaunchGate(db,s.tenant_id,pilot);
    const conflicting=gate.blockers.filter(x=>!['ownerSigned','managerSigned','independent'].includes(x.code));
    if(conflicting.length)
      throw problem(409,'Нельзя подтвердить допуск: '+conflicting.map(x=>x.reason).join(' '));
    const existing=await db.query(
      'SELECT id,actor_id,role,snapshot_digest FROM industry.guest_launch_attestations WHERE tenant_id=$1 AND pilot_id=$2 AND idempotency_key=$3',
      [s.tenant_id,pilot.id,key]);
    if(existing.rowCount){
      const e=existing.rows[0];
      if(e.actor_id!==s.account_id||e.role!==role||e.snapshot_digest!==gate.snapshotDigest)
        throw problem(409,'Idempotency-Key использован для другого подтверждения');
      return {duplicate:true,attestationId:e.id,gate};
    }
    if(gate.attestations[role]?.current)
      throw problem(409,'Подтверждение этой роли уже действительно. Повторять запись нельзя');
    const created=await db.query(
      "INSERT INTO industry.guest_launch_attestations(tenant_id,pilot_id,actor_id,role,snapshot_digest,pilot_version,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [s.tenant_id,pilot.id,s.account_id,role,gate.snapshotDigest,pilot.version,key]);
    await record(db,s,'launch.attested',pilot.id,{role});
    reply.code(201);
    return {attestationId:created.rows[0].id,gate:await currentLaunchGate(db,s.tenant_id,pilot)};
  }));

  // R12 export preserves the ORIGINAL protocol/aggregate digest and adds a distinct launch SHA.
  app.get(P+'/pilots/:id/launch/evidence.json',(req,reply)=>forTenant(req,MANAGE,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const gate=await currentLaunchGate(db,s.tenant_id,pilot);
    const rows=await db.query(
      "SELECT id,role,actor_id,snapshot_digest,pilot_version,accepted_at,expires_at"+
      " FROM industry.guest_launch_attestations WHERE tenant_id=$1 AND pilot_id=$2"+
      " ORDER BY accepted_at ASC,id ASC LIMIT 101",
      [s.tenant_id,pilot.id]);
    if(rows.rowCount>100)
      throw problem(409,'История больше допустимого полного пакета');
    const observations=await activeObservations(db,s.tenant_id,pilot.id);
    const snapshot={
      schema:'osmanx.guest.launch.export.snapshot.v1',pilotId:pilot.id,
      enrolledAt:pilot.launch_gate_enrolled_at||null,
      gate,attestations:rows.rows,
      originalEvidenceSha256:proof(pilot,observations)
    };
    const packet={
      format:'osmanx.guest.launch.export.v1',
      sha256:digest(snapshot),snapshot,
      disclaimer:'Хеш подтверждает целостность пакета, не подпись, не согласие клиента, не платёж и не разрешение на production.'
    };
    reply.header('Content-Disposition','attachment; filename="osmanx-guest-r12-launch-proof.json"');
    reply.header('Content-Type','application/json; charset=utf-8');
    return reply.send(packet);
  }));

  // R13: operational read-only risk assessment and hard pause switch. Never collect PII.
  app.get(P+'/pilots/:id/safety',req=>forTenant(req,null,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const hold=await getActiveHold(db,s.tenant_id,pilot.id);
    const observations=await activeObservations(db,s.tenant_id,pilot.id);
    return {
      schema:'osmanx.guest.safety.v1',
      pilotId:pilot.id,version:pilot.version,phase:pilot.phase,hold,
      quality:assessGuestQuality(pilot,observations),
      guestCollectionPaused:!!hold?.active,
      disclaimer:'Остановка влияет только на этот пилот, не запускает production API и не заменяет согласия клиента.'
    };
  }));

  app.post(P+'/pilots/:id/safety/hold',req=>forTenant(req,ROLES,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion','reasonCode'],'Приостановка пилота');
    const version=versionOf(b),reason=safetyReason(b.reasonCode);
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    verifyVersion(pilot,version);expectPhase(pilot,['running']);
    if((await getActiveHold(db,s.tenant_id,pilot.id))?.active)
      throw problem(409,'Сбор уже приостановлен');
    const h=await db.query(
      "INSERT INTO industry.guest_pilot_holds(tenant_id,pilot_id,active,reason_code,held_by,held_at,version)"+
      " VALUES($1,$2,true,$3,$4,now(),1)"+
      " ON CONFLICT(tenant_id,pilot_id) DO UPDATE"+
      " SET active=true,reason_code=EXCLUDED.reason_code,held_by=EXCLUDED.held_by,"+
      " held_at=now(),resolved_by=NULL,resolved_at=NULL,version=industry.guest_pilot_holds.version+1,updated_at=now()"+
      " RETURNING *",
      [s.tenant_id,pilot.id,reason,s.account_id]);
    const hold=h.rows[0];
    await db.query(
      "INSERT INTO industry.guest_pilot_hold_events(tenant_id,pilot_id,actor_id,event_type,reason_code,hold_version) VALUES($1,$2,$3,'held',$4,$5)",
      [s.tenant_id,pilot.id,s.account_id,reason,hold.version]);
    const updated=await db.query(
      'UPDATE industry.guest_pilots SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
      [s.tenant_id,pilot.id]);
    await record(db,s,'safety.held',pilot.id,{reasonCode:reason,holdVersion:hold.version});
    return {item:flatPilot(updated.rows[0]),hold};
  }));

  app.post(P+'/pilots/:id/safety/resume',req=>forTenant(req,MANAGE,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion','acknowledge'],'Возобновление пилота');
    if(b.acknowledge!==true)
      throw problem(400,'Нужно подтвердить проверку причины и независимый контроль');
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    verifyVersion(pilot,versionOf(b));expectPhase(pilot,['running']);
    const hold=await getActiveHold(db,s.tenant_id,pilot.id);
    if(!hold?.active)throw problem(409,'Сбор не приостановлен');
    if(s.account_id===hold.held_by)
      throw problem(403,'Возобновление должен подтвердить другой действующий сотрудник-руководитель');
    const changed=await db.query(
      'UPDATE industry.guest_pilot_holds SET active=false,resolved_by=$1,resolved_at=now(),'+
      ' version=version+1,updated_at=now() WHERE tenant_id=$2 AND pilot_id=$3 RETURNING *',
      [s.account_id,s.tenant_id,pilot.id]);
    const current=changed.rows[0];
    await db.query(
      "INSERT INTO industry.guest_pilot_hold_events(tenant_id,pilot_id,actor_id,event_type,reason_code,hold_version) VALUES($1,$2,$3,'resumed',$4,$5)",
      [s.tenant_id,pilot.id,s.account_id,current.reason_code,current.version]);
    const updated=await db.query(
      'UPDATE industry.guest_pilots SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
      [s.tenant_id,pilot.id]);
    await record(db,s,'safety.resumed',pilot.id,{reasonCode:current.reason_code,holdVersion:current.version});
    return {item:flatPilot(updated.rows[0]),hold:current};
  }));

  app.get(P+'/pilots/:id/safety/export.json',(req,reply)=>forTenant(req,MANAGE,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const hold=await getActiveHold(db,s.tenant_id,pilot.id);
    const rows=await activeObservations(db,s.tenant_id,pilot.id);
    const history=await db.query(
      'SELECT id,pilot_id,actor_id,event_type,reason_code,hold_version,recorded_at'+
      ' FROM industry.guest_pilot_hold_events WHERE tenant_id=$1 AND pilot_id=$2'+
      ' ORDER BY hold_version ASC LIMIT 101',
      [s.tenant_id,pilot.id]);
    if(history.rowCount>100)throw problem(409,'Журнал превышает предел полного проверяемого пакета');
    const packet=buildSafetyExport({
      pilot,hold,events:history.rows,
      quality:assessGuestQuality(pilot,rows),evidenceDigest:proof(pilot,rows)
    });
    reply.header('Content-Disposition','attachment; filename="osmanx-guest-r13-safety.json"');
    reply.header('Content-Type','application/json; charset=utf-8');
    return reply.send(packet);
  }));

  // R9.1+2: authenticated, deterministic diagnosis from aggregate-only tenant data.
  app.get(P+'/pilots/:id/diagnostics',req=>forTenant(req,null,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const rows=await activeObservations(db,s.tenant_id,pilot.id);
    return {
      pilotId:pilot.id,version:pilot.version,evidenceDigest:proof(pilot,rows),
      diagnostic:diagnoseAggregates({pilot,observations:rows})
    };
  }));

  // R24: usable guest retention intelligence from existing validated AGGREGATES.
  // Both routes are GET-only, owner/manager+tenant-scoped and cannot mutate
  // a pilot, assign an action, lift STOP or enable data collection.
  async function r24Intelligence(db,s,pilotId){
    const pilot=await getPilot(db,s.tenant_id,pilotId);
    const rows=await activeObservations(db,s.tenant_id,pilot.id);
    const hold=await getActiveHold(db,s.tenant_id,pilot.id);
    const quality=inspectR24AggregateQuality({pilot,observations:rows});
    const statistics=summarizeR24Retention(quality);
    const economics=modelR24Economics({
      plan:pilot.plan,quality,statistics
    });
    const playbook=buildR24Playbook({
      quality,statistics,economics,stopActive:hold?.active===true
    });
    return createR24Brief({
      pilotId:pilot.id,version:pilot.version,phase:pilot.phase,
      evidenceDigest:proof(pilot,rows),quality,statistics,
      economics,playbook,stopActive:hold?.active===true
    });
  }
  app.get(P+'/pilots/:id/r24/intelligence',req=>forTenant(req,MANAGE,
    async(db,s)=>r24Intelligence(db,s,req.params.id)));
  app.get(P+'/pilots/:id/r24/brief.csv',(req,reply)=>forTenant(req,MANAGE,
    async(db,s)=>{
      const brief=await r24Intelligence(db,s,req.params.id);
      reply.header('Content-Type','text/csv; charset=utf-8');
      reply.header('Content-Disposition',
        'attachment; filename="osmanx-guest-r24-aggregate-brief.csv"');
      reply.header('Cache-Control','no-store');
      return reply.send(r24BriefCsv(brief));
    }));

  // R25: append-only ANONYMOUS shift counts. This is a separately gated
  // extension of R19 collection, NOT a substitute for guest consent.
  const r25Path=P+'/pilots/:id/operational-signals';
  app.post(r25Path,(req,reply)=>forTenant(req,MANAGE,async(db,s)=>{
    if(process.env.GUEST_R25_SIGNALS_ENABLED!=='true'||
       (process.env.NODE_ENV==='production'&&!r19Configured(process.env)))
      throw problem(503,'R25: запись анонимных сводок отключена до отдельной приёмки');
    const b=bodyOf(req);
    requiredKeys(b,['expectedVersion','tally'],'Операционная сводка R25');
    const key=keyOf(req),version=versionOf(b);
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    await assertUnheld(db,s.tenant_id,pilot.id);
    const tally=guard(()=>parseR25Tally(b.tally,{protocol:pilot.protocol}));
    const fingerprint=digest(tally);
    const previous=await db.query(
      'SELECT id,payload_digest FROM industry.guest_r25_operational_tallies'+
      ' WHERE tenant_id=$1 AND pilot_id=$2 AND idempotency_key=$3',
      [s.tenant_id,pilot.id,key]);
    if(previous.rowCount){
      if(previous.rows[0].payload_digest!==fingerprint)
        throw problem(409,'R25: ключ уже привязан к другому агрегату');
      return {duplicate:true,signalId:previous.rows[0].id,
        version:pilot.version,productionActivated:false};
    }
    verifyVersion(pilot,version);
    expectPhase(pilot,['running']);
    const existing=await db.query(
      'SELECT id FROM industry.guest_r25_operational_tallies'+
      ' WHERE tenant_id=$1 AND pilot_id=$2 AND observed_on=$3::date AND shift=$4',
      [s.tenant_id,pilot.id,tally.date,tally.shift]
    );
    if(existing.rowCount)throw problem(409,'R25: эта смена уже зафиксирована');
    const countRows=await db.query(
      'SELECT count(*)::int AS n FROM industry.guest_r25_operational_tallies'+
      ' WHERE tenant_id=$1 AND pilot_id=$2',
      [s.tenant_id,pilot.id]);
    if(countRows.rows[0].n>=36)
      throw problem(409,'R25: максимум 36 анонимных смен на пилот');
    const values=[
      s.tenant_id,pilot.id,tally.date,tally.shift,tally.source,tally.sampled,
      ...R25_CODES.map(k=>tally.counts[k]),key,fingerprint,s.account_id
    ];
    const inserted=await db.query(
      'INSERT INTO industry.guest_r25_operational_tallies'+
      '(tenant_id,pilot_id,observed_on,shift,source_kind,sampled,'+
      'wait_count,stockout_count,ordering_count,price_count,service_count,'+
      'unknown_count,idempotency_key,payload_digest,recorded_by)'+
      ' VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)'+
      ' RETURNING id',values
    );
    const updated=await db.query(
      'UPDATE industry.guest_pilots SET version=version+1,updated_at=now()'+
      ' WHERE tenant_id=$1 AND id=$2 RETURNING version',
      [s.tenant_id,pilot.id]
    );
    await record(db,s,'r25.tally.recorded',inserted.rows[0].id,{pilotId:pilot.id});
    reply.code(201);
    return {signalId:inserted.rows[0].id,
      version:updated.rows[0].version,productionActivated:false};
  }));
  async function r25Intelligence(db,s,pilotId){
    const pilot=await getPilot(db,s.tenant_id,pilotId);
    const hold=await getActiveHold(db,s.tenant_id,pilot.id);
    const r24=await r24Intelligence(db,s,pilot.id);
    const list=await db.query(
      'SELECT observed_on::text AS date,shift,source_kind AS source,sampled,'+
      'wait_count AS wait,stockout_count AS stockout,'+
      'ordering_count AS ordering,price_count AS price,'+
      'service_count AS service,unknown_count AS unknown'+
      ' FROM industry.guest_r25_operational_tallies'+
      ' WHERE tenant_id=$1 AND pilot_id=$2'+
      ' ORDER BY observed_on ASC,shift ASC LIMIT 37',
      [s.tenant_id,pilot.id]
    );
    if(list.rowCount>36)throw problem(409,'R25: число смен требует аудита');
    const rows=list.rows.map(row=>({
      date:row.date,shift:row.shift,source:row.source,
      sampled:row.sampled,
      counts:Object.fromEntries(R25_CODES.map(k=>[k,row[k]]))
    }));
    let signedForPilot=false;
    if(process.env.GUEST_R25_SIGNALS_ENABLED==='true'&&
       pilot.phase==='running'&&hold?.active!==true){
      if(process.env.NODE_ENV!=='production')signedForPilot=true;
      else if(process.env.GUEST_WRITES_ENABLED==='true'&&r19Configured(process.env)){
        try{
          const scope=await loadR19Scope(process.env);
          signedForPilot=scope.valid===true&&
            scope.tenantId===s.tenant_id&&scope.pilotId===pilot.id;
        }catch{/* Missing real external scope = blocked. */}
      }
    }
    return makeR25Brief({pilot,rows,r24,hold:hold?.active===true,
      recordingAvailable:signedForPilot});
  }
  app.get(P+'/pilots/:id/r25/insights',req=>forTenant(req,MANAGE,
    async(db,s)=>r25Intelligence(db,s,req.params.id)));
  app.get(P+'/pilots/:id/r25/report.csv',(req,reply)=>forTenant(req,MANAGE,
    async(db,s)=>{
      const report=await r25Intelligence(db,s,req.params.id);
      reply.header('Content-Type','text/csv; charset=utf-8');
      reply.header('Content-Disposition',
        'attachment; filename="osmanx-guest-r25-barriers.csv"');
      reply.header('Cache-Control','no-store');
      return reply.send(r25BriefCsv(report));
    }));

  // R26: two-role declarations of source reconciliation. No guest PII,
  // independent cryptographic signatures, permission to activate collection,
  // or equivalence with external audit.
  async function loadR26Rows(db,tenantId,pilotId){
    const raw=await db.query(
      'SELECT observed_on::text AS date,shift,source_kind AS source,sampled,'+
      'wait_count AS wait,stockout_count AS stockout,'+
      'ordering_count AS ordering,price_count AS price,'+
      'service_count AS service,unknown_count AS unknown'+
      ' FROM industry.guest_r25_operational_tallies'+
      ' WHERE tenant_id=$1 AND pilot_id=$2'+
      ' ORDER BY observed_on ASC,shift ASC LIMIT 37',
      [tenantId,pilotId]
    );
    if(raw.rowCount>36)throw problem(409,'R26: too many operational tallies');
    return raw.rows.map(row=>({
      date:row.date,shift:row.shift,source:row.source,
      sampled:row.sampled,
      counts:Object.fromEntries(R25_CODES.map(code=>[code,row[code]]))
    }));
  }
  async function r26CanReview(pilot,tenantId,hold,signals){
    if(process.env.GUEST_R26_SOURCE_REVIEW_ENABLED!=='true'||
       hold?.active===true||
       !['in_review','reviewed','returned'].includes(pilot.phase)||
       signals.profile.recordedShifts===0)return false;
    if(process.env.NODE_ENV!=='production')return true;
    if(process.env.GUEST_WRITES_ENABLED!=='true'||!r19Configured(process.env))
      return false;
    try{
      const scope=await loadR19Scope(process.env);
      return scope.valid===true&&scope.tenantId===tenantId&&
        scope.pilotId===pilot.id;
    }catch{return false;}
  }
  async function r26Intelligence(db,s,pilotId){
    const pilot=await getPilot(db,s.tenant_id,pilotId);
    const hold=await getActiveHold(db,s.tenant_id,pilot.id);
    const signals=await r25Intelligence(db,s,pilot.id);
    const rows=await loadR26Rows(db,s.tenant_id,pilot.id);
    const history=await db.query(
      'SELECT pilot_version AS "pilotVersion",'+
      'tally_source_sha AS "sourceSha",'+
      'r24_evidence_sha AS "r24EvidenceSha",'+
      'tally_rows AS "tallyRows",actor_id AS "actorId",'+
      'actor_role AS role,method,verdict,evidence_sha AS "evidenceSha"'+
      ' FROM industry.guest_r26_source_reviews'+
      ' WHERE tenant_id=$1 AND pilot_id=$2 ORDER BY reviewed_at DESC,id DESC LIMIT 101',
      [s.tenant_id,pilot.id]
    );
    if(history.rowCount>100)throw problem(409,'R26 review history requires audit');
    return makeR26Brief({pilot,r25:signals,rows,
      reviews:history.rows,stopActive:hold?.active===true,
      reviewEnabled:await r26CanReview(pilot,s.tenant_id,hold,signals)});
  }
  app.get(P+'/pilots/:id/r26/reliability',req=>forTenant(req,MANAGE,
    async(db,s)=>r26Intelligence(db,s,req.params.id)));
  app.get(P+'/pilots/:id/r26/report.csv',(req,reply)=>forTenant(req,MANAGE,
    async(db,s)=>{
      const report=await r26Intelligence(db,s,req.params.id);
      reply.header('Content-Type','text/csv; charset=utf-8');
      reply.header('Content-Disposition',
        'attachment; filename="osmanx-guest-r26-reliability.csv"');
      reply.header('Cache-Control','no-store');
      return reply.send(r26BriefCsv(report));
    }));
  app.post(P+'/pilots/:id/r26/source-review',(req,reply)=>
    forTenant(req,MANAGE,async(db,s,role)=>{
      if(process.env.GUEST_R26_SOURCE_REVIEW_ENABLED!=='true')
        throw problem(503,'R26: внутренние проверки источников выключены');
      const b=guard(()=>parseR26ReviewRequest(bodyOf(req)));
      const key=keyOf(req);
      const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
      await assertUnheld(db,s.tenant_id,pilot.id);
      verifyVersion(pilot,b.expectedVersion);
      const signals=await r25Intelligence(db,s,pilot.id);
      const can=await r26CanReview(pilot,s.tenant_id,null,signals);
      if(!can)throw problem(409,'R26: проверка источника пока запрещена');
      if(b.sourceSha!==signals.tallySourceSha||
         b.r24EvidenceSha!==signals.r24EvidenceSha)
        throw problem(409,'R26: контрольные суммы изменились');
      const fp=digest({version:b.expectedVersion,sourceSha:b.sourceSha,
        r24EvidenceSha:b.r24EvidenceSha,evidenceSha:b.evidenceSha,
        method:b.method,verdict:b.verdict,role});
      const sameKey=await db.query(
        'SELECT id,actor_id,payload_digest FROM industry.guest_r26_source_reviews'+
        ' WHERE tenant_id=$1 AND pilot_id=$2 AND idempotency_key=$3',
        [s.tenant_id,pilot.id,key]
      );
      if(sameKey.rowCount){
        if(sameKey.rows[0].actor_id!==s.account_id||
           sameKey.rows[0].payload_digest!==fp)
          throw problem(409,'R26: идемпотентный ключ уже занят');
        return {duplicate:true,reviewId:sameKey.rows[0].id,
          pilotVersion:pilot.version,sourceSha:signals.tallySourceSha,
          customerGo:false};
      }
      const existing=await db.query(
        'SELECT id FROM industry.guest_r26_source_reviews'+
        ' WHERE tenant_id=$1 AND pilot_id=$2 AND pilot_version=$3'+
        ' AND tally_source_sha=$4 AND actor_role=$5',
        [s.tenant_id,pilot.id,pilot.version,signals.tallySourceSha,role]
      );
      if(existing.rowCount)
        throw problem(409,'R26: решение этой роли уже неизменяемо зафиксировано');
      const inserted=await db.query(
        'INSERT INTO industry.guest_r26_source_reviews'+
        '(tenant_id,pilot_id,pilot_version,tally_source_sha,r24_evidence_sha,'+
        'tally_rows,actor_id,actor_role,method,verdict,evidence_sha,'+
        'idempotency_key,payload_digest)'+
        ' VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id',
        [s.tenant_id,pilot.id,pilot.version,signals.tallySourceSha,
          signals.r24EvidenceSha,signals.profile.recordedShifts,
          s.account_id,role,b.method,b.verdict,b.evidenceSha,key,fp]
      );
      await record(db,s,'r26.source.reviewed',inserted.rows[0].id,{
        pilotId:pilot.id,verdict:b.verdict,role
      });
      reply.code(201);
      return {reviewId:inserted.rows[0].id,pilotVersion:pilot.version,
        sourceSha:signals.tallySourceSha,customerGo:false};
    }));

  // R9.3: actionable decision log with owner/manager assignment and role-scoped execution.
  app.get(P+'/pilots/:id/actions',req=>forTenant(req,null,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const actions=await db.query(
      'SELECT id,code,status,assigned_to,created_by,due_on::text AS "dueDate",version,created_at,updated_at FROM industry.guest_actions WHERE tenant_id=$1 AND pilot_id=$2 ORDER BY due_on ASC,created_at ASC,id ASC LIMIT 100',
      [s.tenant_id,pilot.id]
    );
    return {pilotId:pilot.id,items:actions.rows};
  }));
  app.post(P+'/pilots/:id/actions',(req,reply)=>forTenant(req,MANAGE,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedPilotVersion','code','assigneeId','dueDate'],'Решение по пилоту');
    if(typeof b.code!=='string'||!Object.hasOwn(RECOMMENDATIONS,b.code))
      throw problem(400,'Такого проверяемого диагностического решения нет');
    const dueDate=validDueWithin180(b.dueDate);
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    verifyVersion(pilot,versionOf({expectedVersion:b.expectedPilotVersion}));
    const rows=await activeObservations(db,s.tenant_id,pilot.id);
    const recommendations=diagnoseAggregates({pilot,observations:rows}).recommendations;
    if(!recommendations.some(r=>r.code===b.code))
      throw problem(409,'Это действие уже не подтверждается текущей диагностикой');
    const assignee=await validateAssignee(db,s,b.assigneeId);
    const result=await db.query(
      "INSERT INTO industry.guest_actions(tenant_id,pilot_id,code,status,assigned_to,created_by,due_on) VALUES($1,$2,$3,'open',$4,$5,$6::date) RETURNING id,code,status,assigned_to,created_by,due_on::text AS \"dueDate\",version,created_at,updated_at",
      [s.tenant_id,pilot.id,b.code,assignee,s.account_id,dueDate]
    );
    await addActionHistory(db,s,pilot,{
      ...result.rows[0],due_on:dueDate
    },{type:'created'});
    await record(db,s,'action.created',result.rows[0].id,{pilotId:pilot.id,code:b.code});
    reply.code(201);return {item:result.rows[0]};
  }));
  app.patch(P+'/pilots/:id/actions/:actionId',req=>forTenant(req,null,async(db,s,role)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion','status'],'Обновление решения');
    if(!['in_progress','done','dismissed'].includes(b.status))
      throw problem(400,'Недопустимый статус задачи');
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const id=uuid(req.params.actionId);
    const result=await db.query(
      'SELECT * FROM industry.guest_actions WHERE tenant_id=$1 AND pilot_id=$2 AND id=$3 FOR UPDATE',
      [s.tenant_id,pilot.id,id]);
    if(!result.rowCount)throw problem(404,'Задача не найдена');
    const item=result.rows[0];
    if(role==='viewer'||(role==='operator'&&s.account_id!==item.assigned_to))
      throw problem(403,'Недостаточно прав для изменения этой задачи');
    if(item.version!==versionOf(b))throw problem(409,'Задача уже изменена, обновите список');
    const transitions={open:['in_progress','dismissed'],in_progress:['done','dismissed'],done:[],dismissed:[]};
    if(!transitions[item.status].includes(b.status))
      throw problem(409,'Этот переход статуса запрещён');
    const update=await db.query(
      'UPDATE industry.guest_actions SET status=$1,version=version+1,updated_at=now() WHERE tenant_id=$2 AND pilot_id=$3 AND id=$4 RETURNING id,code,status,assigned_to,created_by,due_on::text AS "dueDate",version,created_at,updated_at',
      [b.status,s.tenant_id,pilot.id,id]
    );
    await addActionHistory(db,s,pilot,{
      ...update.rows[0],due_on:item.due_on
    },{type:'status',previous:item});
    await record(db,s,'action.'+b.status,id,{pilotId:pilot.id});
    return {item:update.rows[0]};
  }));

  // R11 auditable reallocation: only active tasks, locked row, strict version and membership.
  app.patch(P+'/pilots/:id/actions/:actionId/assignment',req=>forTenant(req,MANAGE,async(db,s)=>{
    const b=bodyOf(req);
    requiredKeys(b,['expectedVersion','assigneeId','dueDate'],'Изменение ответственного');
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const id=uuid(req.params.actionId),version=versionOf(b);
    const due=validDueWithin180(b.dueDate),assignee=await validateAssignee(db,s,b.assigneeId);
    const current=await db.query(
      'SELECT * FROM industry.guest_actions WHERE tenant_id=$1 AND pilot_id=$2 AND id=$3 FOR UPDATE',
      [s.tenant_id,pilot.id,id]);
    if(!current.rowCount)throw problem(404,'Задача не найдена');
    const old=current.rows[0];
    if(old.version!==version)throw problem(409,'Задача изменилась, обновите список');
    if(!['open','in_progress'].includes(old.status))
      throw problem(409,'Завершённое или отклонённое действие нельзя переназначить');
    if(old.assigned_to===assignee && new Date(old.due_on).toISOString().slice(0,10)===due)
      throw problem(409,'Ответственный и срок не изменились');
    const update=await db.query(
      'UPDATE industry.guest_actions SET assigned_to=$1,due_on=$2::date,version=version+1,updated_at=now() WHERE tenant_id=$3 AND pilot_id=$4 AND id=$5 RETURNING *',
      [assignee,due,s.tenant_id,pilot.id,id]
    );
    await addActionHistory(db,s,pilot,update.rows[0],{type:'assignment',previous:old});
    await record(db,s,'action.assignment_changed',id,{pilotId:pilot.id});
    return {item:{id:update.rows[0].id,code:update.rows[0].code,status:update.rows[0].status,
      assigned_to:update.rows[0].assigned_to,created_by:update.rows[0].created_by,
      dueDate:due,version:update.rows[0].version,created_at:update.rows[0].created_at,
      updated_at:update.rows[0].updated_at}};
  }));

  app.get(P+'/pilots/:id/actions/:actionId/history',req=>forTenant(req,null,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const id=uuid(req.params.actionId);
    const found=await db.query(
      'SELECT 1 FROM industry.guest_actions WHERE tenant_id=$1 AND pilot_id=$2 AND id=$3',
      [s.tenant_id,pilot.id,id]);
    if(!found.rowCount)throw problem(404,'Задача не найдена');
    const events=await db.query(
      'SELECT id,event_type,from_status,to_status,previous_assignee,next_assignee,previous_due_on::text AS "previousDueDate",next_due_on::text AS "nextDueDate",actor_id,action_version,recorded_at FROM industry.guest_action_history WHERE tenant_id=$1 AND pilot_id=$2 AND action_id=$3 ORDER BY action_version ASC LIMIT 500',
      [s.tenant_id,pilot.id,id]);
    return {schema:'osmanx.guest.action.history.v1',pilotId:pilot.id,actionId:id,
      items:events.rows};
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
    if(pilot.launch_gate_enrolled_at){
      const gate=await currentLaunchGate(db,s.tenant_id,pilot);
      if(!gate.canStartIsolatedPilot)
        throw problem(409,'R12: запуск заблокирован. Нужны действующие независимые подтверждения владельца и управляющего и все предварительные условия');
    }
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
    await assertUnheld(db,s.tenant_id,pilot.id);
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
  // R9.4: isolated, strict dry-run. Preview NEVER writes any observation/import row.
  app.post(P+'/pilots/:id/observations/import/preview',req=>forTenant(req,ROLES,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion','csv'],'Предварительная проверка CSV');
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    await assertUnheld(db,s.tenant_id,pilot.id);
    const version=versionOf(b);verifyVersion(pilot,version);expectPhase(pilot,['running']);
    const {rows,hash,summary}=validatedCsv(b.csv,pilot,version);
    const remaining=await checkBatchSlots(db,s.tenant_id,pilot,rows);
    return {schema:'osmanx.guest.csv.preview.v1',pilotId:pilot.id,
      expectedVersion:version,sha256:hash,remainingSlots:remaining,summary,
      disclaimer:'Предварительная проверка без сохранения. Подтверждение не доказывает корректность источника или независимость групп.'};
  }));

  app.get(P+'/pilots/:id/observations/imports',req=>forTenant(req,null,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const rows=await db.query(
      'SELECT id,rows_imported,committed_version,created_at,created_by FROM industry.guest_bulk_imports WHERE tenant_id=$1 AND pilot_id=$2 ORDER BY created_at DESC LIMIT 40',
      [s.tenant_id,pilot.id]);
    return {items:rows.rows};
  }));

  // Commit is atomic within withTenant's BEGIN/COMMIT and serialized by the pilot FOR UPDATE.
  app.post(P+'/pilots/:id/observations/import',(req,reply)=>forTenant(req,ROLES,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion','csv','sha256'],'Импорт агрегатов');
    const version=versionOf(b),key=keyOf(req),pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    await assertUnheld(db,s.tenant_id,pilot.id);
    const {rows,hash,summary}=validatedCsv(b.csv,pilot,version);
    if(typeof b.sha256!=='string'||b.sha256!==hash)
      throw problem(409,'CSV изменён после предварительной проверки. Запустите просмотр заново.');
    const old=await db.query(
      'SELECT id,payload_digest,rows_imported,committed_version FROM industry.guest_bulk_imports WHERE tenant_id=$1 AND pilot_id=$2 AND idempotency_key=$3',
      [s.tenant_id,pilot.id,key]);
    if(old.rowCount){
      if(old.rows[0].payload_digest!==hash)
        throw problem(409,'Idempotency-Key уже использован для другого пакета');
      return {duplicate:true,importId:old.rows[0].id,
        rowsImported:old.rows[0].rows_imported,version:old.rows[0].committed_version,sha256:hash};
    }
    verifyVersion(pilot,version);expectPhase(pilot,['running']);
    await checkBatchSlots(db,s.tenant_id,pilot,rows);
    for(let i=0;i<rows.length;i++){
      const r=rows[i];
      // Exact row fingerprint is retained, raw CSV text and personal data are NOT stored.
      const perRowKey='bulk:'+digest({batchKey:key,rowIndex:i});
      await db.query(
        'INSERT INTO industry.guest_observations(tenant_id,pilot_id,observed_on,control_count,control_return,offer_count,offer_return,created_by,idempotency_key,payload_digest) VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10)',
        [s.tenant_id,pilot.id,r.date,r.control,r.controlReturn,r.offer,r.offerReturn,s.account_id,perRowKey,digest(r)]
      );
    }
    const changed=await db.query(
      'UPDATE industry.guest_pilots SET version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING version',
      [s.tenant_id,pilot.id]);
    const imported=await db.query(
      'INSERT INTO industry.guest_bulk_imports(tenant_id,pilot_id,idempotency_key,payload_digest,rows_imported,committed_version,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [s.tenant_id,pilot.id,key,hash,rows.length,changed.rows[0].version,s.account_id]);
    await record(db,s,'observations.batch_imported',pilot.id,{
      batchId:imported.rows[0].id,rowCount:rows.length,sha256:hash
    });
    reply.code(201);
    return {importId:imported.rows[0].id,rowsImported:rows.length,
      version:changed.rows[0].version,sha256:hash,summary};
  }));

  app.post(P+'/pilots/:id/observations/:observationId/void',req=>forTenant(req,MANAGE,async(db,s)=>{
    const b=bodyOf(req);requiredKeys(b,['expectedVersion'],'Отзыв наблюдения');
    const pilot=await getPilot(db,s.tenant_id,req.params.id,true);
    await assertUnheld(db,s.tenant_id,pilot.id);
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
    await assertUnheld(db,s.tenant_id,pilot.id);
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

  // R11 complete bounded operations evidence; original Guest evidence SHA remains untouched.
  app.get(P+'/pilots/:id/operations/export.json',(req,reply)=>forTenant(req,MANAGE,async(db,s)=>{
    const pilot=await getPilot(db,s.tenant_id,req.params.id);
    const observations=await activeObservations(db,s.tenant_id,pilot.id);
    if(!observations.length)throw problem(409,'Нет наблюдений для проверяемого экспорта');
    const evidence=snapshot(pilot,observations),evidenceDigest=digest(evidence);
    const review=(await db.query(
      'SELECT decision,actor_id,evidence_digest,decided_at FROM industry.guest_reviews WHERE tenant_id=$1 AND pilot_id=$2 ORDER BY decided_at DESC,id DESC LIMIT 1',
      [s.tenant_id,pilot.id])).rows[0]||null;
    if(['reviewed','archived'].includes(pilot.phase)&&
       (review?.decision!=='accept_for_discussion'||review.evidence_digest!==evidenceDigest||
        pilot.submitted_digest!==evidenceDigest))
      throw problem(409,'Архив не совпадает с утверждённым доказательством');
    const actions=await db.query(
      'SELECT id,code,status,assigned_to,created_by,due_on::text AS "dueDate",version,created_at,updated_at FROM industry.guest_actions WHERE tenant_id=$1 AND pilot_id=$2 ORDER BY code,id LIMIT 100',
      [s.tenant_id,pilot.id]);
    const history=await db.query(
      'SELECT h.id,h.action_id,h.event_type,h.from_status,h.to_status,h.previous_assignee,h.next_assignee,h.previous_due_on::text AS "previousDueDate",h.next_due_on::text AS "nextDueDate",h.actor_id,h.action_version,h.recorded_at FROM industry.guest_action_history h WHERE h.tenant_id=$1 AND h.pilot_id=$2 ORDER BY h.action_id,h.action_version LIMIT 501',
      [s.tenant_id,pilot.id]);
    const imports=await db.query(
      'SELECT id,payload_digest,rows_imported,committed_version,created_at FROM industry.guest_bulk_imports WHERE tenant_id=$1 AND pilot_id=$2 ORDER BY created_at,id LIMIT 501',
      [s.tenant_id,pilot.id]);
    if(history.rowCount>500||imports.rowCount>500)
      throw problem(409,'История превышает максимальный размер пакета; требуется независимая выгрузка');
    const packet=createOperationsExport({
      pilot,evidence,evidenceDigest,review,actions:actions.rows,history:history.rows,imports:imports.rows
    });
    reply.header('Content-Disposition','attachment; filename="osmanx-guest-operational-proof.json"');
    reply.header('Content-Type','application/json; charset=utf-8');
    return reply.send(packet);
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
