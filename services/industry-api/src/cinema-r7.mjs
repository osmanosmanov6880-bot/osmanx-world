// CINEMA R7 - auditable work claiming, duplicate investigation and evidence-quality checks.
// DB transactions and tenant RLS are supplied by the existing protectOwner boundary.
const fail=(status,message)=>Object.assign(new Error(message),{statusCode:status});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPEN=new Set(['new','contacted','qualified','proposal']);
export function strictId(id){
  if(typeof id!=='string'||!UUID.test(id))throw fail(400,'Некорректный ID обращения');
  return id.toLowerCase();
}
export function claimInput(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['expectedVersion','action'].includes(k)))
    throw fail(400,'Недопустимые поля действия');
  if(!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<1)
    throw fail(400,'Неверная версия карточки');
  if(!['claim','release'].includes(raw.action))throw fail(400,'Неизвестное действие');
  return raw;
}
export function checkEventContinuity(version,stats){
  const count=Number(stats.event_count),min=stats.first_version===null?null:Number(stats.first_version),
    max=stats.last_version===null?null:Number(stats.last_version);
  const complete=Number.isInteger(version)&&version>=1&&count===version&&min===1&&max===version;
  return {complete,leadVersion:version,eventCount:count,firstEventVersion:min,lastEventVersion:max,
    hasNoGaps:count===0?false:(max-min+1===count),
    explanation:complete?'Записи событий покрывают каждую версию карточки':
      'Найдена неполная или несогласованная история. Не использовать как доказательство полной цепочки.',
    proofLevel:'sequence_consistency_only_not_cryptographic'};
}
export function registerCinemaR7Routes(app,{base,protectOwner}){
  app.post(base+'/leads/:id/claim',req=>protectOwner(req,['owner','manager'],async(db,session,role)=>{
    const id=strictId(req.params.id),input=claimInput(req.body);
    const result=await db.query(
      'SELECT id,assigned_to,state,version FROM industry.cinema_leads WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [session.tenant_id,id]);
    if(!result.rowCount)throw fail(404,'Обращение не найдено');
    const old=result.rows[0];
    if(old.version!==input.expectedVersion)throw fail(409,'Другой менеджер уже обновил обращение');
    if(!OPEN.has(old.state))throw fail(409,'Нельзя брать в работу завершённую сделку');
    let assigned=null;
    if(input.action==='claim'){
      if(old.assigned_to===session.account_id)throw fail(409,'Обращение уже закреплено за вами');
      if(old.assigned_to!==null)throw fail(409,'Обращение уже закреплено за другим менеджером');
      assigned=session.account_id;
    }else{
      if(old.assigned_to===null)throw fail(409,'Ответственный уже отсутствует');
      if(role!=='owner'&&old.assigned_to!==session.account_id)
        throw fail(403,'Снять другого ответственного может только владелец');
    }
    const changed=await db.query(
      'UPDATE industry.cinema_leads SET assigned_to=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,assigned_to,state,version,updated_at',
      [session.tenant_id,id,assigned]);
    const row=changed.rows[0];
    await db.query(
      "INSERT INTO industry.cinema_lead_events(tenant_id,lead_id,actor_id,event_type,old_state,new_state,version,assigned_to) VALUES($1,$2,$3,'assigned_changed',$4,$4,$5,$6)",
      [session.tenant_id,id,session.account_id,old.state,row.version,assigned]);
    return {item:row,action:input.action,recorded:true};
  }));
  app.get(base+'/leads/:id/similar',req=>protectOwner(req,['owner','manager'],async(db,s)=>{
    const id=strictId(req.params.id);
    const original=await db.query(
      'SELECT contact_email FROM industry.cinema_leads WHERE tenant_id=$1 AND id=$2',
      [s.tenant_id,id]);
    if(!original.rowCount)throw fail(404,'Обращение не найдено');
    const email=original.rows[0].contact_email;
    const count=await db.query(
      'SELECT count(*)::int AS n FROM industry.cinema_leads WHERE tenant_id=$1 AND lower(contact_email)=lower($2) AND id<>$3',
      [s.tenant_id,email,id]);
    const found=await db.query(
      'SELECT id,state,organization,story_id,assigned_to,created_at FROM industry.cinema_leads WHERE tenant_id=$1 AND lower(contact_email)=lower($2) AND id<>$3 ORDER BY created_at DESC,id DESC LIMIT 25',
      [s.tenant_id,email,id]);
    return {schema:'osmanx.cinema.similar.v1',items:found.rows,total:count.rows[0].n,
      matchBasis:'exact_email_only',truncated:count.rows[0].n>25,
      note:'Совпадение адреса не доказывает, что это один клиент. Объединение записей не выполняется.'};
  }));
  app.get(base+'/leads/:id/audit-integrity',req=>protectOwner(req,['owner'],async(db,s)=>{
    const id=strictId(req.params.id);
    const lead=await db.query(
      'SELECT version FROM industry.cinema_leads WHERE tenant_id=$1 AND id=$2',
      [s.tenant_id,id]);
    if(!lead.rowCount)throw fail(404,'Обращение не найдено');
    const events=await db.query(
      'SELECT count(*)::int AS event_count,min(version)::int AS first_version,max(version)::int AS last_version FROM industry.cinema_lead_events WHERE tenant_id=$1 AND lead_id=$2',
      [s.tenant_id,id]);
    return {schema:'osmanx.cinema.audit-check.v1',...checkEventContinuity(lead.rows[0].version,events.rows[0])};
  }));
  app.get(base+'/team/workload',req=>protectOwner(req,['owner','manager'],async(db,s)=>{
    const rows=await db.query(
      "SELECT m.account_id AS id,a.email,m.role,"+
      "count(l.id) FILTER (WHERE l.state IN ('new','contacted','qualified','proposal'))::int AS active,"+
      "count(l.id) FILTER (WHERE l.state IN ('new','contacted','qualified','proposal') AND l.next_action_at<now())::int AS overdue,"+
      "count(l.id) FILTER (WHERE l.state IN ('new','contacted','qualified','proposal') AND l.contact_count=0)::int AS awaiting_first_attempt"+
      " FROM industry.memberships m JOIN industry.accounts a ON a.id=m.account_id"+
      " LEFT JOIN industry.cinema_leads l ON l.tenant_id=m.tenant_id AND l.assigned_to=m.account_id"+
      " WHERE m.tenant_id=$1 AND m.role IN ('owner','manager') AND NOT a.disabled"+
      " GROUP BY m.account_id,a.email,m.role ORDER BY active ASC,overdue DESC,a.email LIMIT 100",
      [s.tenant_id]);
    return {schema:'osmanx.cinema.team-workload.v1',items:rows.rows,
      note:'Число назначенных открытых заявок, не оценка эффективности сотрудника'};
  }));
}
