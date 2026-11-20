// OSMANX CINEMA R3 — commercial intake, protected pipeline and aggregate-only telemetry.
// Public intake is strictly opt-in for operations: disabled by default in every environment.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { withTenant } from './database.mjs';
import {campaignCode,planFollowup,followupWindow} from './cinema-r4.mjs';
import {sweepCinemaRows} from './cinema-retention.mjs';
import {assigneeValue,registerCinemaR5Routes} from './cinema-r5.mjs';
import {registerCinemaR6Routes} from './cinema-r6.mjs';
import {registerCinemaR7Routes} from './cinema-r7.mjs';

const STATES=['new','contacted','qualified','proposal','won','lost'];
const PATHS={
  new:['contacted','lost'],
  contacted:['qualified','lost'],
  qualified:['proposal','lost'],
  proposal:['won','lost','qualified'],
  won:[],
  lost:['contacted']
};
const STORY_IDS=new Set([
  '01-restaurant','02-fashion','03-dentistry','04-auto','05-fitness','06-education',
  '07-coffee','08-return','09-appointment','10-construction','11-logistics','12-shoes'
]);
const EVENTS=new Set(['film_started','film_finished','brief_created','offer_opened']);
const SOURCES=new Set(['cinema','guest','catalog','industry']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY=/^[a-zA-Z0-9._:-]{16,80}$/;
const EMAIL=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const error=(status,message)=>Object.assign(new Error(message),{statusCode:status});
export function cinemaConfig(env=process.env){
  const tenant=env.CINEMA_TENANT_ID||'';
  const secret=env.CINEMA_RATE_SECRET||'';
  const configured=UUID.test(tenant)&&secret.length>=32;
  return {
    configured,
    tenant:configured?tenant:null,
    secret:configured?secret:null,
    enabled:configured&&env.CINEMA_PUBLIC_WRITE_ENABLED==='true',
    metrics:configured&&env.CINEMA_PUBLIC_WRITE_ENABLED==='true'&&env.CINEMA_AGGREGATE_EVENTS_ENABLED==='true'
  };
}
const digest=x=>createHash('sha256').update(x).digest('hex');
const bounded=(input,name,max,{min=0,optional=false}={})=>{
  if(optional && (input===undefined||input===null||input===''))return null;
  if(typeof input!=='string')throw error(400,'Некорректное поле: '+name);
  const s=input.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  if(s.length<min||s.length>max)throw error(400,'Некорректная длина поля: '+name);
  return s;
};
const only=(obj,allowed)=>{
  if(!obj||typeof obj!=='object'||Array.isArray(obj))throw error(400,'Нужен JSON-объект');
  if(Object.keys(obj).some(k=>!allowed.includes(k)))throw error(400,'Неизвестные поля запроса');
  return obj;
};
export function parseLead(data,requestKey){
  const b=only(data,['storyId','contactName','contactEmail','organization','observation','goal','source','consent','website','campaignCode']);
  if(b.website!==undefined && typeof b.website!=='string')throw error(400,'Проверьте поле website');
  if(b.consent!==true)throw error(400,'Для запроса необходимо согласие на обработку данных');
  const storyId=bounded(b.storyId,'storyId',40,{min:8});
  if(!STORY_IDS.has(storyId))throw error(400,'Неизвестный сюжет');
  const contactName=bounded(b.contactName,'Имя',120,{min:2});
  const contactEmail=bounded(b.contactEmail,'Email',254,{min:5}).toLowerCase();
  if(!EMAIL.test(contactEmail))throw error(400,'Проверьте email');
  const organization=bounded(b.organization,'Организация',120,{optional:true});
  const observation=bounded(b.observation,'Наблюдение',500,{min:8});
  const goal=bounded(b.goal,'Цель',300,{optional:true});
  const source=b.source??'cinema';
  if(!SOURCES.has(source))throw error(400,'Некорректный источник');
  if(typeof requestKey!=='string'||!KEY.test(requestKey))throw error(400,'Требуется корректный Idempotency-Key');
  const item={storyId,contactName,contactEmail,organization,observation,goal,source,campaignCode:campaignCode(b.campaignCode)};
  return {
    ...item,key:requestKey,
    fingerprint:digest(JSON.stringify(item)),
    honeypot:Boolean(b.website?.trim())
  };
}
export function parseEvent(data){
  const b=only(data,['eventType','storyId','campaignCode']);
  if(!EVENTS.has(b.eventType))throw error(400,'Неизвестное событие');
  const storyId=b.storyId??'all';
  if(storyId!=='all'&&!STORY_IDS.has(storyId))throw error(400,'Неизвестный сюжет');
  return {eventType:b.eventType,storyId,campaignCode:campaignCode(b.campaignCode)};
}
const tokenHash=(secret,value)=>createHmac('sha256',secret).update(value).digest('hex');
const constantEqual=(a,b)=>{
  if(typeof a!=='string'||typeof b!=='string'||a.length!==64||b.length!==64)return false;
  return timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
};
async function incrementBucket(db,tenant,secret,key,max){
  const hash=tokenHash(secret,key);
  const row=await db.query(
    "INSERT INTO industry.cinema_rate_limits(tenant_id,key_hash,bucket_hour,hits) VALUES($1,$2,date_trunc('hour',now()),1) ON CONFLICT(tenant_id,key_hash,bucket_hour) DO UPDATE SET hits=industry.cinema_rate_limits.hits+1 RETURNING hits",
    [tenant,hash]
  );
  if(Number(row.rows[0].hits)>max)throw error(429,'Слишком много запросов. Повторите позже.');
}
const requireUUID=v=>{if(typeof v!=='string'||!UUID.test(v))throw error(400,'Некорректный ID');return v;};
export function permittedTransition(from,to){return PATHS[from]?.includes(to)===true;}

export function registerCinemaRoutes(app,{prefix,pool,forTenant}){
  const base=prefix+'/cinema';
  function config(){return cinemaConfig();}
  function ready(){
    const cfg=config();
    if(!cfg.enabled)throw error(503,'Онлайн-приём заявок пока отключён. Используйте email.');
    return cfg;
  }
  function protectOwner(req,roles,fn){
    const cfg=config();
    if(!cfg.configured)throw error(503,'Кабинет запросов не настроен');
    return forTenant(req,roles,async(db,session,role)=>{
      if(session.tenant_id.toLowerCase()!==cfg.tenant.toLowerCase())throw error(403,'Нет доступа к запросам CINEMA');
      return fn(db,session,role,cfg);
    });
  }
  app.get(base+'/public/config',async()=>({
    schema:'osmanx.cinema.intake.v1',
    intakeEnabled:config().enabled,
    aggregateEventsEnabled:config().metrics,
    retentionDays:90
  }));
  app.post(base+'/public/leads',async(req,reply)=>{
    const cfg=ready();
    const data=parseLead(req.body,req.headers['idempotency-key']);
    if(data.honeypot){reply.code(202);return {accepted:false};}
    const result=await withTenant(pool,cfg.tenant,async(db)=>{
      // Serialize same-key submissions across API processes before charging rate-limit buckets.
      // PostgreSQL transaction-scoped advisory lock avoids racing on UNIQUE(tenant,idempotency_key).
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['cinema:lead:'+cfg.tenant+':'+data.key]);
      const previous=await db.query(
        'SELECT id,payload_digest FROM industry.cinema_leads WHERE tenant_id=$1 AND idempotency_key=$2',
        [cfg.tenant,data.key]
      );
      if(previous.rowCount){
        if(!constantEqual(previous.rows[0].payload_digest,data.fingerprint))throw error(409,'Этот ключ уже использован для другого запроса');
        return {id:previous.rows[0].id,duplicate:true};
      }
      // DB-atomic hourly limit, hashed email only: no IP address retained.
      await incrementBucket(db,cfg.tenant,cfg.secret,'global:leads',250);
      await incrementBucket(db,cfg.tenant,cfg.secret,'email:'+data.contactEmail,4);
      const created=await db.query(
        "INSERT INTO industry.cinema_leads(tenant_id,contact_name,contact_email,organization,story_id,observation,goal,source,idempotency_key,payload_digest,campaign_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
        [cfg.tenant,data.contactName,data.contactEmail,data.organization,data.storyId,data.observation,data.goal,data.source,data.key,data.fingerprint,data.campaignCode]
      );
      const id=created.rows[0].id;
      await db.query(
        "INSERT INTO industry.cinema_lead_events(tenant_id,lead_id,event_type,new_state,version) VALUES($1,$2,'created','new',1)",
        [cfg.tenant,id]
      );
      return {id,duplicate:false};
    });
    reply.code(result.duplicate?200:201);
    return {accepted:true,reference:result.id,duplicate:result.duplicate};
  });
  app.post(base+'/public/events',async(req,reply)=>{
    const cfg=ready();
    if(!cfg.metrics)throw error(503,'Агрегированные события отключены');
    const event=parseEvent(req.body);
    await withTenant(pool,cfg.tenant,async db=>{
      await incrementBucket(db,cfg.tenant,cfg.secret,'global:events',10000);
      await db.query(
        "INSERT INTO industry.cinema_daily_events(tenant_id,date_utc,event_type,story_id,campaign_code,total) VALUES($1,(now() AT TIME ZONE 'UTC')::date,$2,$3,$4,1) ON CONFLICT(tenant_id,date_utc,event_type,story_id,campaign_code) DO UPDATE SET total=industry.cinema_daily_events.total+1",
        [cfg.tenant,event.eventType,event.storyId,event.campaignCode]
      );
    });
    reply.code(202);return {recorded:true,uniqueVisitor:false};
  });
  app.get(base+'/leads',req=>protectOwner(req,['owner','manager'],async(db,session)=>{
    const query=only(req.query||{},['limit','offset','state','campaign']);
    const limit=Number(query.limit??40),offset=Number(query.offset??0);
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(offset)||offset<0||offset>10000)
      throw error(400,'Некорректная пагинация');
    const state=query.state;
    if(state!==undefined&&!STATES.includes(state))throw error(400,'Некорректный статус');
    const campaign=query.campaign===undefined?null:campaignCode(query.campaign);
    const records=await db.query(
      "SELECT id,contact_name,contact_email,organization,story_id,observation,goal,source,campaign_code,state,deal_value_minor::text,version,next_action_at,next_action_kind,loss_reason_code,assigned_to,contact_count,first_contact_at,last_contact_at,created_at,updated_at FROM industry.cinema_leads WHERE tenant_id=$1 AND ($2::text IS NULL OR state=$2) AND ($5::text IS NULL OR campaign_code=$5) ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4",
      [session.tenant_id,state??null,limit,offset,campaign]
    );
    return {items:records.rows,limit,offset};
  }));
  app.get(base+'/metrics',req=>protectOwner(req,['owner','manager'],async(db,session)=>{
    const [stages,sources,stories,events,campaigns,followups]=await Promise.all([
      db.query("SELECT state,count(*)::int AS leads,COALESCE(sum(CASE WHEN state='won' THEN deal_value_minor ELSE 0 END),0)::text AS won_value_minor FROM industry.cinema_leads WHERE tenant_id=$1 GROUP BY state ORDER BY state",[session.tenant_id]),
      db.query('SELECT source,count(*)::int AS leads FROM industry.cinema_leads WHERE tenant_id=$1 GROUP BY source ORDER BY source',[session.tenant_id]),
      db.query('SELECT story_id,count(*)::int AS leads FROM industry.cinema_leads WHERE tenant_id=$1 GROUP BY story_id ORDER BY leads DESC,story_id LIMIT 12',[session.tenant_id]),
      db.query("SELECT date_utc::text,event_type,story_id,campaign_code,total::text FROM industry.cinema_daily_events WHERE tenant_id=$1 AND date_utc>=(now() AT TIME ZONE 'UTC')::date-interval '29 days' ORDER BY date_utc DESC,event_type,story_id,campaign_code LIMIT 300",[session.tenant_id]),
      db.query("SELECT campaign_code,count(*)::int AS leads,count(*) FILTER(WHERE state='won')::int AS won,COALESCE(sum(CASE WHEN state='won' THEN deal_value_minor ELSE 0 END),0)::text AS won_estimate_minor FROM industry.cinema_leads WHERE tenant_id=$1 GROUP BY campaign_code ORDER BY leads DESC,campaign_code LIMIT 50",[session.tenant_id]),
      db.query("SELECT count(*) FILTER(WHERE next_action_at<now() AND state NOT IN ('won','lost'))::int AS overdue,count(*) FILTER(WHERE next_action_at>=now() AND next_action_at<(date_trunc('day',now() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' AND state NOT IN ('won','lost'))::int AS due_today FROM industry.cinema_leads WHERE tenant_id=$1",[session.tenant_id])
    ]);
    return {schema:'osmanx.cinema.metrics.v2',stages:stages.rows,sources:sources.rows,stories:stories.rows,events:events.rows,campaigns:campaigns.rows,followups:followups.rows[0],
      warning:'События — количество действий, не уникальных посетителей. Выручка — только вручную подтверждённые сделки.'};
  }));
  app.get(base+'/followups',req=>protectOwner(req,['owner','manager'],async(db,s)=>{
    const query=only(req.query||{},['window','limit']);
    const windowName=query.window??'overdue',limit=Number(query.limit??50);
    if(!Number.isInteger(limit)||limit<1||limit>100)throw error(400,'Неверный размер страницы');
    const bounds=followupWindow(windowName);
    const data=await db.query(
      "SELECT id,contact_name,organization,story_id,state,campaign_code,next_action_at,next_action_kind,version FROM industry.cinema_leads WHERE tenant_id=$1 AND next_action_at IS NOT NULL AND next_action_at<$2::timestamptz AND ($3::timestamptz IS NULL OR next_action_at>=$3::timestamptz) AND state NOT IN ('won','lost') ORDER BY next_action_at ASC,id ASC LIMIT $4",
      [s.tenant_id,bounds.before,bounds.after,limit]
    );
    return {window:windowName,items:data.rows};
  }));
  app.patch(base+'/leads/:id',req=>protectOwner(req,['owner','manager'],async(db,s,role)=>{
    const id=requireUUID(req.params.id);
    const b=only(req.body,['expectedVersion','state','dealValueMinor','nextActionAt','nextActionKind','lossReasonCode','assignedTo']);
    const version=b.expectedVersion;
    if(!Number.isSafeInteger(version)||version<1)throw error(400,'Некорректная версия');
    if(!Object.keys(b).some(k=>k!=='expectedVersion'))throw error(400,'Нет изменений');
    if(b.state!==undefined&&!STATES.includes(b.state))throw error(400,'Неизвестный статус');
    if(b.dealValueMinor!==undefined && b.dealValueMinor!==null &&
       (!Number.isSafeInteger(b.dealValueMinor)||b.dealValueMinor<0||b.dealValueMinor>100000000000))
       throw error(400,'Некорректная стоимость сделки');
    const old=(await db.query('SELECT state,version,deal_value_minor,next_action_at,next_action_kind,loss_reason_code,assigned_to FROM industry.cinema_leads WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[s.tenant_id,id])).rows[0];
    if(!old)throw error(404,'Заявка не найдена');
    if(old.version!==version)throw error(409,'Заявка изменена другим пользователем');
    const plan=planFollowup(old,b);
    if(plan.state!==old.state&&!permittedTransition(old.state,plan.state))
      throw error(409,'Недопустимый переход статуса');
    if(b.dealValueMinor!==undefined && !['qualified','proposal','won'].includes(plan.state))
      throw error(409,'Сумма возможна только для квалифицированной или согласованной сделки');
    const amount=b.dealValueMinor===undefined?old.deal_value_minor:b.dealValueMinor;
    const oldDue=old.next_action_at?new Date(old.next_action_at).toISOString():null;
    const changedState=plan.state!==old.state;
    const changedValue=String(amount)!==String(old.deal_value_minor);
    const changedFollowup=plan.nextActionAt!==oldDue||plan.nextActionKind!==old.next_action_kind;
    const changedReason=plan.lossReasonCode!==old.loss_reason_code;
    const assigned=b.assignedTo===undefined?old.assigned_to:assigneeValue(b.assignedTo);
    if(b.assignedTo!==undefined && role!=='owner' &&
       ((old.assigned_to!==null&&old.assigned_to!==s.account_id) ||
        (assigned!==null&&assigned!==s.account_id)))
      throw error(403,'Назначения других менеджеров разрешены только владельцу');
    if(assigned!==null){
      const person=await db.query(
        "SELECT 1 FROM industry.memberships m JOIN industry.accounts a ON a.id=m.account_id WHERE m.tenant_id=$1 AND m.account_id=$2 AND m.role IN ('owner','manager') AND NOT a.disabled",
        [s.tenant_id,assigned]
      );
      if(!person.rowCount)throw error(400,'Назначить можно только действующего менеджера своей компании');
    }
    const changedAssignment=String(assigned)!==String(old.assigned_to);
    if(!changedState&&!changedValue&&!changedFollowup&&!changedReason&&!changedAssignment)
      throw error(409,'Изменения отсутствуют');
    const row=await db.query(
      'UPDATE industry.cinema_leads SET state=$3,deal_value_minor=$4,next_action_at=$5,next_action_kind=$6,loss_reason_code=$7,assigned_to=$8,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,state,deal_value_minor::text,version,next_action_at,next_action_kind,loss_reason_code,assigned_to,updated_at',
      [s.tenant_id,id,plan.state,amount,plan.nextActionAt,plan.nextActionKind,plan.lossReasonCode,assigned]
    );
    const eventType=changedState?'state_changed':changedValue?'value_changed':changedFollowup?'followup_changed':changedReason?'outcome_coded':'assigned_changed';
    await db.query(
      'INSERT INTO industry.cinema_lead_events(tenant_id,lead_id,actor_id,event_type,old_state,new_state,version,next_action_at,next_action_kind,loss_reason_code,assigned_to) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [s.tenant_id,id,s.account_id,eventType,old.state,plan.state,row.rows[0].version,plan.nextActionAt,plan.nextActionKind,plan.lossReasonCode,assigned]
    );
    return {item:row.rows[0]};
  }));
  app.get(base+'/leads/:id/history',req=>protectOwner(req,['owner','manager'],async(db,s)=>{
    const id=requireUUID(req.params.id);
    const exists=await db.query('SELECT 1 FROM industry.cinema_leads WHERE tenant_id=$1 AND id=$2',[s.tenant_id,id]);
    if(!exists.rowCount)throw error(404,'Заявка не найдена');
    const rows=await db.query('SELECT event_type,old_state,new_state,version,next_action_at,next_action_kind,loss_reason_code,assigned_to,contact_channel,contact_outcome,occurred_at FROM industry.cinema_lead_events WHERE tenant_id=$1 AND lead_id=$2 ORDER BY version ASC LIMIT 100',[s.tenant_id,id]);
    return {items:rows.rows};
  }));
  app.delete(base+'/leads/:id',req=>protectOwner(req,['owner'],async(db,s)=>{
    const id=requireUUID(req.params.id);
    const row=await db.query('DELETE FROM industry.cinema_leads WHERE tenant_id=$1 AND id=$2 RETURNING id',[s.tenant_id,id]);
    if(!row.rowCount)throw error(404,'Заявка не найдена');
    // No lead ID or email is retained in deletion receipts.
    await db.query(
      "INSERT INTO industry.cinema_access_events(tenant_id,actor_id,action,result_count) VALUES($1,$2,'lead_deleted',1)",
      [s.tenant_id,s.account_id]);
    return {erased:true,id};
  }));
  app.post(base+'/retention',req=>protectOwner(req,['owner'],async(db,s)=>{
    const b=only(req.body, ['confirm']);
    if(b.confirm!=='ERASE_EXPIRED')throw error(400,'Требуется подтверждение удаления');
    return sweepCinemaRows(db,s.tenant_id);
  }));
  registerCinemaR5Routes(app,{base,protectOwner});
  registerCinemaR6Routes(app,{base,protectOwner});
  registerCinemaR7Routes(app,{base,protectOwner});
}
