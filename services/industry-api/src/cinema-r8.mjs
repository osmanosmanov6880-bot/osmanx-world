// CINEMA R8: honest runtime capability contract, owner-only CSV authorization,
// and evidence of executed (not merely configured) retention. No outbound messages.
const fail=(status,message)=>Object.assign(new Error(message),{statusCode:status});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function approveExportInput(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||
     Object.keys(value).some(k=>!['confirm','leadIds'].includes(k))||
     value.confirm!=='EXPORT_LOADED')
    throw fail(400,'Необходимо явное разрешение выгрузки');
  const ids=value.leadIds;
  if(!Array.isArray(ids)||ids.length<1||ids.length>100||
     ids.some(id=>typeof id!=='string'||!UUID.test(id)))
    throw fail(400,'Разрешение возможно для 1–100 корректных ID');
  const normalized=ids.map(id=>id.toLowerCase());
  if(new Set(normalized).size!==normalized.length)throw fail(400,'Повторяющиеся ID в запросе');
  return normalized;
}
export function runtimeStatus(config){
  return {schema:'osmanx.cinema.runtime.v1',apiRelease:'r8',
    onlineIntakeEnabled:Boolean(config.enabled),
    aggregateActionsEnabled:Boolean(config.metrics),
    operatorTenantConfigured:Boolean(config.configured),
    capabilities:{queue:true,manualContact:true,teamClaims:true,
      subjectAccessPost:true,ownerCsvApproval:true,retentionReceipts:true},
    note:'Состояние API, а не подтверждение юридического допуска, проверки почты или работы таймера.'};
}
export function retentionAssessment(lastRun,expiredCount,now=Date.now()){
  if(!lastRun)return {status:'not_observed',hoursSince:null,
    explanation:'Нет записи о завершённой очистке. Неизвестно, запускался ли таймер.'};
  const time=Date.parse(lastRun);
  if(!Number.isFinite(time))return {status:'unknown',hoursSince:null,
    explanation:'Некорректное время последней очистки.'};
  const hours=Math.max(0,Math.round((now-time)/3600000*10)/10);
  return {status:hours>48?'stale':expiredCount>0?'needs_review':'recent',
    hoursSince:hours,
    explanation:hours>48?'Последняя запись старше 48 часов: проверить таймер и ошибки.':
      expiredCount>0?'Есть просроченные записи: проверить запуск/время обработки.':
      'Недавняя очистка зарегистрирована; будущий запуск не гарантируется.'};
}

export function registerCinemaR8Routes(app,{base,protectOwner,config}){
  app.get(base+'/public/runtime',async(req,reply)=>{
    reply.header('Cache-Control','no-store');
    return runtimeStatus(config());
  });
  app.get(base+'/ops/preflight',req=>protectOwner(req,['owner'],async(db,s)=>{
    const leads=await db.query(
      "SELECT count(*)::int AS total,count(*) FILTER(WHERE created_at<now()-interval '90 days')::int AS expired FROM industry.cinema_leads WHERE tenant_id=$1",
      [s.tenant_id]);
    const run=await db.query(
      'SELECT erased_leads,expired_metrics,expired_rate_buckets,expired_access_receipts,executed_at FROM industry.cinema_retention_runs WHERE tenant_id=$1 ORDER BY executed_at DESC,id DESC LIMIT 1',
      [s.tenant_id]);
    const counts=leads.rows[0],last=run.rows[0]||null;
    return {schema:'osmanx.cinema.ops-preflight.v1',
      apiRelease:'r8',intakeEnabled:config().enabled,aggregateEventsEnabled:config().metrics,
      leads:{total:counts.total,expired:counts.expired},
      retention:{lastExecution:last,assessment:retentionAssessment(last?.executed_at,counts.expired)},
      requiresHumanReview:true,
      note:'Запись о прошлой очистке не доказывает наличие действующего расписания или законного основания сбора.'};
  }));
  app.post(base+'/exports/approve',req=>protectOwner(req,['owner'],async(db,s)=>{
    const ids=approveExportInput(req.body);
    const matching=await db.query(
      'SELECT count(*)::int AS n FROM industry.cinema_leads WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
      [s.tenant_id,ids]);
    if(matching.rows[0].n!==ids.length)
      throw fail(409,'Список содержит удалённую или недоступную запись. Обновите данные.');
    // Audit stores no names, email, report body or exported rows.
    await db.query(
      "INSERT INTO industry.cinema_access_events(tenant_id,actor_id,action,result_count) VALUES($1,$2,'bulk_export_authorized',$3)",
      [s.tenant_id,s.account_id,ids.length]);
    return {approved:true,approvedCount:ids.length,
      schema:'osmanx.cinema.export-authorization.v1',
      note:'Зафиксировано разрешение на экспорт, а не подтверждение скачивания файла.'};
  }));
}
