// CINEMA R9: server-generated, transactionally auditable CSV and measured first attempts.
// No external integrations and no AI-estimated customer or revenue claims.
const fail=(status,message)=>Object.assign(new Error(message),{statusCode:status});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const headers=['ID','Имя','Email','Компания','Сюжет','Наблюдение','Цель','Источник',
  'Кампания','Стадия','Оценка, коп.','Следующее действие','Срок','Причина отказа','Дата'];
export function csvCell(value){
  let s=value===null||value===undefined?'':String(value);
  // Spreadsheet formula injection also works after whitespace and Unicode BOM.
  s=s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,' ').replace(/\r\n?|\n/g,' ');
  if(/^[\s\uFEFF\u200B]*[=+\-@]/u.test(s))s="'"+s;
  return '"'+s.replace(/"/g,'""')+'"';
}
export function exportInput(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||
     Object.keys(value).some(k=>!['confirm','leadIds'].includes(k))||
     value.confirm!=='GENERATE_CSV')throw fail(400,'Подтвердите формирование CSV');
  const ids=value.leadIds;
  if(!Array.isArray(ids)||ids.length<1||ids.length>500||
     ids.some(v=>typeof v!=='string'||!UUID.test(v)))
    throw fail(400,'От 1 до 500 корректных идентификаторов');
  const normalized=ids.map(v=>v.toLowerCase());
  if(new Set(normalized).size!==normalized.length)throw fail(400,'Повторяющиеся заявки');
  return normalized;
}
export function makeCsv(rows){
  const line=row=>[
    row.id,row.contact_name,row.contact_email,row.organization,row.story_id,
    row.observation,row.goal,row.source,row.campaign_code,row.state,
    row.deal_value_minor,row.next_action_kind,row.next_action_at,
    row.loss_reason_code,row.created_at instanceof Date?row.created_at.toISOString():row.created_at
  ].map(csvCell).join(';');
  return '\uFEFF'+headers.map(csvCell).join(';')+'\r\n'+rows.map(line).join('\r\n')+'\r\n';
}
export function reviewPeriod(query){
  if(!query||typeof query!=='object'||Array.isArray(query)||
     Object.keys(query).some(k=>k!=='days'))throw fail(400,'Недопустимый фильтр отчёта');
  const d=query.days??'30';
  if(typeof d!=='string'||!['7','30','90'].includes(d))
    throw fail(400,'Период: 7, 30 или 90 дней');
  return Number(d);
}
export function rate(numerator,denominator){
  const a=Number(numerator),b=Number(denominator);
  return b>0?Math.round(a/b*1000)/10:null;
}
export function registerCinemaR9Routes(app,{base,protectOwner,config}){
  app.get(base+'/public/r9-runtime',async(req,reply)=>{
    reply.header('Cache-Control','no-store');
    const state=config();
    return {schema:'osmanx.cinema.runtime.v2',apiRelease:'r9',
      onlineIntakeEnabled:Boolean(state.enabled),
      aggregateActionsEnabled:Boolean(state.metrics),
      capabilities:{serverCsvSnapshot:true,contactResponseReview:true,conflictRefresh:true},
      note:'Техническая версия API; не подтверждает готовность законно собирать данные.'};
  });
  app.post(base+'/exports/csv',async(req,reply)=>{
    // protectOwner commits the whole transaction before the response body is sent.
    const body=await protectOwner(req,['owner'],async(db,session)=>{
      const ids=exportInput(req.body);
      const found=await db.query(
        'SELECT id,contact_name,contact_email,organization,story_id,observation,goal,'+
        'source,campaign_code,state,deal_value_minor::text,next_action_kind,next_action_at,'+
        'loss_reason_code,created_at FROM industry.cinema_leads'+
        ' WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY array_position($2::uuid[],id) FOR SHARE',
        [session.tenant_id,ids]);
      if(found.rowCount!==ids.length)
        throw fail(409,'Одна или несколько заявок изменены или удалены. Обновите кабинет.');
      const csv=makeCsv(found.rows);
      // Exact rows and the audit receipt are prepared in the same transaction.
      await db.query(
        "INSERT INTO industry.cinema_access_events(tenant_id,actor_id,action,result_count) VALUES($1,$2,'bulk_export_generated',$3)",
        [session.tenant_id,session.account_id,found.rowCount]);
      return {csv};
    });
    reply.header('Cache-Control','private, no-store, max-age=0');
    reply.header('Pragma','no-cache');
    reply.header('X-Content-Type-Options','nosniff');
    reply.header('Content-Disposition','attachment; filename="osmanx-cinema-snapshot.csv"');
    reply.type('text/csv; charset=utf-8');
    return reply.send(body.csv);
  });
  app.get(base+'/ops/response-review',req=>protectOwner(req,['owner','manager'],async(db,s)=>{
    const days=reviewPeriod(req.query||{});
    const q=[
      "WITH leads_window AS (",
      " SELECT id,created_at,state,assigned_to,next_action_at,first_contact_at",
      " FROM industry.cinema_leads WHERE tenant_id=$1 AND created_at>=now()-($2::int*interval '1 day')",
      "), first_attempt AS (",
      " SELECT e.lead_id,min(e.occurred_at) AS first_at,count(*)::int AS attempts",
      " FROM industry.cinema_lead_events e JOIN leads_window l ON l.id=e.lead_id",
      " WHERE e.tenant_id=$1 AND e.event_type='contact_logged' GROUP BY e.lead_id",
      ") SELECT",
      " count(*)::int AS total,",
      " count(*) FILTER(WHERE a.first_at IS NOT NULL)::int AS with_attempt,",
      " count(*) FILTER(WHERE l.first_contact_at IS NOT NULL)::int AS manager_marked_connected,",
      " count(*) FILTER(WHERE l.assigned_to IS NULL AND l.state IN ('new','contacted','qualified','proposal'))::int AS unassigned_active,",
      " count(*) FILTER(WHERE l.next_action_at<now() AND l.state IN ('new','contacted','qualified','proposal'))::int AS overdue_active,",
      " count(*) FILTER(WHERE a.first_at IS NULL AND l.created_at<=now()-interval '24 hours')::int AS without_attempt_24h,",
      " count(*) FILTER(WHERE l.created_at<=now()-interval '1 hour')::int AS eligible_1h,",
      " count(*) FILTER(WHERE l.created_at<=now()-interval '1 hour' AND a.first_at IS NOT NULL",
      " AND a.first_at<=l.created_at+interval '1 hour')::int AS responded_within_1h,",
      " coalesce(sum(a.attempts),0)::int AS recorded_attempts,",
      " round(avg(extract(epoch FROM (a.first_at-l.created_at))/60)::numeric,1)::text AS avg_minutes_to_first_attempt",
      " FROM leads_window l LEFT JOIN first_attempt a ON a.lead_id=l.id"
    ].join(' ');
    const r=await db.query(q,[s.tenant_id,days]),counts=r.rows[0];
    return {schema:'osmanx.cinema.response-review.v1',windowDays:days,
      asOf:new Date().toISOString(),counts,
      percentages:{everAttempted:rate(counts.with_attempt,counts.total),
        respondedWithin1h:rate(counts.responded_within_1h,counts.eligible_1h)},
      definitions:{
        with_attempt:'Число заявок с вручную зарегистрированным событием contact_logged',
        eligible_1h:'Заявки не моложе одного часа, чтобы измерять срок без перекоса',
        responded_within_1h:'Первая зарегистрированная попытка в пределах 60 минут',
        manager_marked_connected:'Менеджер сообщил connected; не проверенный факт разговора',
        attribution:'Нет вывода о причинах отказов, оплате или уникальных посетителях'
      }};
  }));
}
