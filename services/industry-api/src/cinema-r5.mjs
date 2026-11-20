// OSMANX CINEMA R5: staff contact activity, private subject rights,
// and sales performance without cookies or unique-visitor tracking.
const fail=(status,message)=>Object.assign(new Error(message),{statusCode:status});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL=/^[^\s@<>/?#]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const CHANNELS=new Set(['email','phone','whatsapp','in_person']);
const OUTCOMES=new Set(['attempted','connected','no_reply','invalid_contact']);
const only=(value,keys)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))
    throw fail(400,'Недопустимые поля');
  return value;
};
export function checkedUuid(value){
  if(typeof value!=='string'||!UUID.test(value))throw fail(400,'Недопустимый идентификатор');
  return value.toLowerCase();
}
export function assigneeValue(value){
  if(value===null)return null;
  return checkedUuid(value);
}
export function parseContactActivity(value){
  const b=only(value,['expectedVersion','channel','outcome','completeFollowup']);
  if(!Number.isSafeInteger(b.expectedVersion)||b.expectedVersion<1)throw fail(400,'Некорректная версия');
  if(!CHANNELS.has(b.channel)||!OUTCOMES.has(b.outcome))throw fail(400,'Выберите канал и результат');
  if(b.completeFollowup!==undefined && typeof b.completeFollowup!=='boolean')throw fail(400,'Недопустимое подтверждение выполнения');
  return {...b,completeFollowup:b.completeFollowup===true};
}
export function exactEmail(value){
  if(typeof value!=='string'||value.length>254||value.length<5||!EMAIL.test(value.trim()))
    throw fail(400,'Требуется точный email');
  return value.trim().toLowerCase();
}
export function reportDays(raw){
  const days=raw===undefined?30:Number(raw);
  if(![7,30,90].includes(days)||!Number.isInteger(days))throw fail(400,'Период отчёта должен быть 7, 30 или 90 дней');
  return days;
}
export function registerCinemaR5Routes(app,{base,protectOwner}){
  app.get(base+'/assignees',req=>protectOwner(req,['owner','manager'],async(db,session)=>{
    const rows=await db.query(
      "SELECT m.account_id AS id,a.email,m.role FROM industry.memberships m JOIN industry.accounts a ON a.id=m.account_id WHERE m.tenant_id=$1 AND m.role IN ('owner','manager') AND NOT a.disabled ORDER BY a.email LIMIT 100",
      [session.tenant_id]);
    return {items:rows.rows};
  }));
  app.post(base+'/leads/:id/contacts',req=>protectOwner(req,['owner','manager'],async(db,session)=>{
    const id=checkedUuid(req.params.id),activity=parseContactActivity(req.body);
    const result=await db.query(
      'SELECT id,version,state FROM industry.cinema_leads WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [session.tenant_id,id]);
    if(!result.rowCount)throw fail(404,'Заявка не найдена');
    const row=result.rows[0];
    if(row.version!==activity.expectedVersion)throw fail(409,'Карточка изменена другим менеджером');
    if(['won','lost'].includes(row.state))throw fail(409,'Нельзя записать контакт по закрытой заявке');
    const changed=await db.query(
      "UPDATE industry.cinema_leads SET version=version+1,contact_count=contact_count+1,last_contact_at=now(),first_contact_at=CASE WHEN $3='connected' THEN COALESCE(first_contact_at,now()) ELSE first_contact_at END,next_action_at=CASE WHEN $4 THEN NULL ELSE next_action_at END,next_action_kind=CASE WHEN $4 THEN NULL ELSE next_action_kind END,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,version,contact_count,first_contact_at,last_contact_at,next_action_at,next_action_kind",
      [session.tenant_id,id,activity.outcome,activity.completeFollowup]);
    const saved=changed.rows[0];
    await db.query(
      "INSERT INTO industry.cinema_lead_events(tenant_id,lead_id,actor_id,event_type,old_state,new_state,version,contact_channel,contact_outcome,next_action_at,next_action_kind) VALUES($1,$2,$3,'contact_logged',$4,$4,$5,$6,$7,$8,$9)",
      [session.tenant_id,id,session.account_id,row.state,saved.version,activity.channel,activity.outcome,saved.next_action_at,saved.next_action_kind]);
    return {item:saved,recorded:true,verification:'manual_manager_record'};
  }));
  app.get(base+'/performance',req=>protectOwner(req,['owner','manager'],async(db,session)=>{
    const qs=only(req.query||{},['days']),days=reportDays(qs.days);
    const leadSql=[
      "SELECT campaign_code,count(*)::int AS leads,",
      "count(*) FILTER (WHERE state='won')::int AS agreed,",
      "count(*) FILTER (WHERE state='lost')::int AS lost,",
      "count(*) FILTER (WHERE contact_count>0)::int AS with_attempt,",
      "count(*) FILTER (WHERE first_contact_at IS NOT NULL)::int AS connected,",
      "coalesce(sum(contact_count),0)::text AS attempts,",
      "ROUND(AVG(EXTRACT(EPOCH FROM(first_contact_at-created_at))/3600)",
      "FILTER (WHERE first_contact_at IS NOT NULL),2)::text AS avg_hours_to_connection",
      "FROM industry.cinema_leads",
      "WHERE tenant_id=$1 AND created_at>=now()-($2::int*interval '1 day')",
      "GROUP BY campaign_code ORDER BY leads DESC,campaign_code LIMIT 75"
    ].join(' ');
    const eventSql=[
      "SELECT campaign_code,event_type,sum(total)::text AS actions",
      "FROM industry.cinema_daily_events",
      "WHERE tenant_id=$1 AND date_utc>=(now() AT TIME ZONE 'UTC')::date-($2::int-1)",
      "GROUP BY campaign_code,event_type ORDER BY campaign_code,event_type LIMIT 400"
    ].join(' ');
    // Same PostgreSQL transaction connection: serialize queries, never parallelize client.query.
    const leads=await db.query(leadSql,[session.tenant_id,days]);
    const events=await db.query(eventSql,[session.tenant_id,days]);
    return {schema:'osmanx.cinema.performance.v1',windowDays:days,
      campaigns:leads.rows,actions:events.rows,
      measurement:{
        agreed:'Согласовано менеджером, не подтверждена оплата',
        with_attempt:'Есть вручную зарегистрированная попытка',
        connected:'Менеджер отметил результат connected, требует проверки',
        actions:'Безличные действия, НЕ уникальные зрители',
        campaign:'Атрибуция по ссылке, не доказательство влияния рекламы'
      }};
  }));
  app.get(base+'/privacy/search',req=>protectOwner(req,['owner'],async(db,session)=>{
    const qs=only(req.query||{},['email']),email=exactEmail(qs.email);
    const rows=await db.query(
      'SELECT id,contact_email,created_at,state FROM industry.cinema_leads WHERE tenant_id=$1 AND contact_email=$2 ORDER BY created_at DESC LIMIT 50',
      [session.tenant_id,email]);
    return {items:rows.rows,requiresIdentityVerification:true};
  }));
  app.get(base+'/leads/:id/export',(req,reply)=>protectOwner(req,['owner'],async(db,session)=>{
    const id=checkedUuid(req.params.id);
    const rows=await db.query(
      'SELECT id,contact_name,contact_email,organization,story_id,observation,goal,source,campaign_code,consent_at,state,deal_value_minor::text,currency,created_at,updated_at,assigned_to,contact_count,first_contact_at,last_contact_at,loss_reason_code,next_action_at,next_action_kind,version FROM industry.cinema_leads WHERE tenant_id=$1 AND id=$2',
      [session.tenant_id,id]);
    if(!rows.rowCount)throw fail(404,'Заявка не найдена');
    const audit=await db.query(
      'SELECT event_type,version,old_state,new_state,next_action_at,next_action_kind,loss_reason_code,contact_channel,contact_outcome,occurred_at FROM industry.cinema_lead_events WHERE tenant_id=$1 AND lead_id=$2 ORDER BY version ASC LIMIT 1001',
      [session.tenant_id,id]);
    reply.header('Cache-Control','private, no-store, max-age=0');
    reply.header('Content-Disposition','attachment; filename="cinema-lead-'+id+'.json"');
    return {schema:'osmanx.cinema.subject-export.v1',lead:rows.rows[0],events:audit.rows.slice(0,1000),
      truncated:audit.rows.length>1000,verifiedByOperator:false,
      note:'Оператор обязан отдельно проверить право заявителя на получение данных'};
  }));
}
