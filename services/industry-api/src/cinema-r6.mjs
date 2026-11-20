// CINEMA R6: explainable sales triage + complete keyset-paginated work queue.
const fail=(status,message)=>Object.assign(new Error(message),{statusCode:status});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE=new Set(['new','contacted','qualified','proposal']);
const STATES=new Set([...ACTIVE,'won','lost']);
const VIEWS=new Set(['all','overdue','unassigned','uncontacted']);
const only=(v,keys)=>{
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))
    throw fail(400,'Недопустимые параметры');
  return v;
};
export function queueOptions(raw,accountId){
  const q=only(raw||{},['view','state','assignedTo','limit','beforeCreatedAt','beforeId']);
  const view=q.view??'all';
  if(!VIEWS.has(view))throw fail(400,'Неизвестный тип очереди');
  const state=q.state??null;if(state!==null&&!STATES.has(state))throw fail(400,'Неизвестная стадия');
  const limit=q.limit===undefined?50:Number(q.limit);
  if(!/^[1-9]\d{0,2}$/.test(String(q.limit??50))||!Number.isInteger(limit)||limit>100)
    throw fail(400,'Размер страницы: от 1 до 100');
  const assigned=q.assignedTo??'all';
  if(!['all','mine','unassigned'].includes(assigned)&&!(typeof assigned==='string'&&UUID.test(assigned)))
    throw fail(400,'Неверный ответственный');
  const assignedId=assigned==='mine'?accountId:UUID.test(assigned)?assigned:null;
  const onlyUnassigned=assigned==='unassigned';
  const hasDate=q.beforeCreatedAt!==undefined,hasId=q.beforeId!==undefined;
  if(hasDate!==hasId)throw fail(400,'Поля курсора должны использоваться вместе');
  let date=null,id=null;
  if(hasDate){
    if(typeof q.beforeCreatedAt!=='string'||q.beforeCreatedAt.length>35||
       !/^\d{4}-\d{2}-\d{2}T/.test(q.beforeCreatedAt))throw fail(400,'Некорректное время курсора');
    const parsed=new Date(q.beforeCreatedAt);
    if(!Number.isFinite(parsed.getTime()))throw fail(400,'Некорректная дата курсора');
    if(typeof q.beforeId!=='string'||!UUID.test(q.beforeId))throw fail(400,'Некорректный ID курсора');
    date=parsed.toISOString();id=q.beforeId.toLowerCase();
  }
  return {view,state,limit,assignedId,onlyUnassigned,cursorDate:date,cursorId:id};
}
export function explainTriage(lead,now=Date.now()){
  const signals=[];
  if(!ACTIVE.has(lead.state))return {priority:'closed',signals:[]};
  const created=Date.parse(lead.created_at);
  const due=lead.next_action_at?Date.parse(lead.next_action_at):null;
  if(due!==null&&Number.isFinite(due)&&due<now)
    signals.push({code:'followup_overdue',description:'Просрочен запланированный контакт'});
  if(!lead.assigned_to)
    signals.push({code:'unassigned',description:'Не назначен ответственный'});
  if(Number(lead.contact_count||0)===0&&Number.isFinite(created)&&now-created>=86400000)
    signals.push({code:'first_contact_24h',description:'Более суток нет зарегистрированной попытки связи'});
  if(due!==null&&Number.isFinite(due)&&due>=now&&due<=now+86400000)
    signals.push({code:'due_24h',description:'Действие запланировано на ближайшие сутки'});
  return {priority:signals.some(s=>s.code==='followup_overdue'||s.code==='first_contact_24h')?'urgent':
    signals.length?'attention':'normal',signals};
}
const QUEUE_WHERE=[
  'tenant_id=$1',
  'AND ($2::text IS NULL OR state=$2)',
  "AND ($3::text='all' OR"+
  " ($3::text='overdue' AND next_action_at<now() AND state IN ('new','contacted','qualified','proposal')) OR"+
  " ($3::text='unassigned' AND assigned_to IS NULL AND state IN ('new','contacted','qualified','proposal')) OR"+
  " ($3::text='uncontacted' AND contact_count=0 AND created_at<now()-interval '24 hours' AND state IN ('new','contacted','qualified','proposal')))",
  'AND ($4::uuid IS NULL OR assigned_to=$4)',
  'AND ($5::boolean IS FALSE OR assigned_to IS NULL)'
].join(' ');
export function registerCinemaR6Routes(app,{base,protectOwner}){
  app.get(base+'/queue',req=>protectOwner(req,['owner','manager'],async(db,s)=>{
    const q=queueOptions(req.query,s.account_id);
    const args=[s.tenant_id,q.state,q.view,q.assignedId,q.onlyUnassigned];
    const count=await db.query('SELECT count(*)::int AS n FROM industry.cinema_leads WHERE '+QUEUE_WHERE,args);
    const found=await db.query(
      'SELECT id,contact_name,contact_email,organization,story_id,observation,goal,source,campaign_code,state,deal_value_minor::text,version,next_action_at,next_action_kind,loss_reason_code,assigned_to,contact_count,first_contact_at,last_contact_at,created_at,updated_at FROM industry.cinema_leads WHERE '+
      QUEUE_WHERE+
      ' AND ($6::timestamptz IS NULL OR (created_at,id)<($6::timestamptz,$7::uuid))'+
      ' ORDER BY created_at DESC,id DESC LIMIT $8',
      [...args,q.cursorDate,q.cursorId,q.limit+1]
    );
    const hasMore=found.rows.length>q.limit,items=found.rows.slice(0,q.limit),last=items.at(-1);
    return {schema:'osmanx.cinema.queue.v1',items,total:count.rows[0].n,hasMore,
      nextCursor:hasMore&&last?{beforeCreatedAt:new Date(last.created_at).toISOString(),beforeId:last.id}:null,
      itemsWithTriage:items.map(x=>({id:x.id,...explainTriage(x)})),
      applied:{view:q.view,state:q.state,limit:q.limit},
      note:'Хронологический порядок; метки риска вычисляются по явным правилам, не AI-прогноз'};
  }));
  app.get(base+'/queue/summary',req=>protectOwner(req,['owner','manager'],async(db,s)=>{
    const rows=await db.query(
      "SELECT count(*) FILTER (WHERE state IN ('new','contacted','qualified','proposal'))::int AS active,"+
      "count(*) FILTER (WHERE state IN ('new','contacted','qualified','proposal') AND next_action_at<now())::int AS overdue,"+
      "count(*) FILTER (WHERE state IN ('new','contacted','qualified','proposal') AND assigned_to IS NULL)::int AS unassigned,"+
      "count(*) FILTER (WHERE state IN ('new','contacted','qualified','proposal') AND contact_count=0 AND created_at<now()-interval '24 hours')::int AS uncontacted"+
      " FROM industry.cinema_leads WHERE tenant_id=$1",[s.tenant_id]);
    return {schema:'osmanx.cinema.queue-summary.v1',counts:rows.rows[0],
      note:'Группы пересекаются; метки не устанавливают причины отказа клиента'};
  }));
  app.get(base+'/privacy/access-log',req=>protectOwner(req,['owner'],async(db,s)=>{
    const rows=await db.query(
      'SELECT id,action,actor_id,lead_id,result_count,created_at FROM industry.cinema_access_events WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100',
      [s.tenant_id]);
    return {items:rows.rows,containsEmail:false,limit:100};
  }));
}
