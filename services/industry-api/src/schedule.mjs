// R4 scheduling: timezone-aware availability and transactional resource locks.
import { recordChange } from './database.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TIME=/^([01]\d|2[0-3]):[0-5]\d$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
function err(code,message){const e=new Error(message);e.statusCode=code;return e;}
const uuid=x=>{if(typeof x!=='string'||!UUID.test(x))throw err(400,'Некорректный идентификатор');return x;};
const iso=x=>{if(typeof x!=='string'||!ISO.test(x))throw err(400,'Неверная дата и часовой пояс');const d=new Date(x);if(!Number.isFinite(d.getTime()))throw err(400,'Неверное время');return d.toISOString();};
const roles=['owner','manager'];
function dateOnly(value){if(typeof value!=='string'||!DATE.test(value))throw err(400,'Укажите дату YYYY-MM-DD');const d=new Date(value+'T00:00:00.000Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)throw err(400,'Некорректная дата');return value;}

export async function lockResource(db,tenantId,resourceId){
  uuid(resourceId);
  const r=await db.query('SELECT id FROM industry.resources WHERE tenant_id=$1 AND id=$2 AND active FOR UPDATE',[tenantId,resourceId]);
  if(!r.rowCount)throw err(404,'Рабочий календарь не найден');
}
export async function assertBookable(db,tenantId,resourceId,startISO,endISO,ignoreAppointmentId=null){
  const query='SELECT EXISTS (SELECT 1 FROM industry.resource_hours h '+
    'JOIN industry.resources r ON r.tenant_id=h.tenant_id AND r.id=h.resource_id '+
    'JOIN industry.tenants t ON t.id=r.tenant_id '+
    'WHERE h.tenant_id=$1 AND h.resource_id=$2 '+
    'AND h.weekday=EXTRACT(ISODOW FROM ($3::timestamptz AT TIME ZONE t.timezone)) '+
    'AND ($3::timestamptz AT TIME ZONE t.timezone)::time >= h.opens_at '+
    'AND ($4::timestamptz AT TIME ZONE t.timezone)::time <= h.closes_at '+
    'AND ($3::timestamptz AT TIME ZONE t.timezone)::date = ($4::timestamptz AT TIME ZONE t.timezone)::date '+
    'AND mod((EXTRACT(EPOCH FROM ((($3::timestamptz AT TIME ZONE t.timezone)::time)-h.opens_at))/60)::int,r.slot_interval_minutes)=0 '+
    'AND NOT EXISTS (SELECT 1 FROM industry.resource_closed_dates c WHERE c.tenant_id=$1 AND c.resource_id=$2 AND c.closed_date=($3::timestamptz AT TIME ZONE t.timezone)::date)) AS within_hours, '+
    'EXISTS (SELECT 1 FROM industry.appointments a JOIN industry.resources r ON r.tenant_id=a.tenant_id AND r.id=a.resource_id '+
    "WHERE a.tenant_id=$1 AND a.resource_id=$2 AND a.id IS DISTINCT FROM $5::uuid AND a.status IN ('new','confirmed') AND "+
    "tstzrange(a.starts_at-make_interval(mins=>r.buffer_minutes),a.ends_at+make_interval(mins=>r.buffer_minutes),'[)') && "+
    "tstzrange($3::timestamptz-make_interval(mins=>r.buffer_minutes),$4::timestamptz+make_interval(mins=>r.buffer_minutes),'[)')) AS conflict, "+
    "EXISTS (SELECT 1 FROM industry.resource_time_off o JOIN industry.resources r ON r.tenant_id=o.tenant_id AND r.id=o.resource_id "+
    "WHERE o.tenant_id=$1 AND o.resource_id=$2 AND tstzrange(o.starts_at,o.ends_at,'[)') && "+
    "tstzrange($3::timestamptz-make_interval(mins=>r.buffer_minutes),$4::timestamptz+make_interval(mins=>r.buffer_minutes),'[)')) AS time_off";
  const r=await db.query(query,[tenantId,resourceId,startISO,endISO,ignoreAppointmentId]);
  if(!r.rows[0].within_hours)throw err(409,'Время вне рабочего графика, сетки слотов или дата закрыта');
  if(r.rows[0].conflict)throw err(409,'Ресурс занят с учётом буфера между визитами');
  if(r.rows[0].time_off)throw err(409,'Календарь недоступен в это время');
}export function registerScheduleRoutes(app,{prefix,forTenant,bodyOf,identifier}){
  app.get(prefix+'/settings/timezone',req=>forTenant(req,null,async(db,s)=>{
    const r=await db.query('SELECT timezone FROM industry.tenants WHERE id=$1',[s.tenant_id]);
    return {timezone:r.rows[0]?.timezone||'UTC'};
  }));
  app.patch(prefix+'/settings/timezone',req=>forTenant(req,['owner'],async(db,s)=>{
    const timezone=bodyOf(req).timezone;
    if(typeof timezone!=='string'||timezone.length>80||
       !(timezone==='UTC'||Intl.supportedValuesOf('timeZone').includes(timezone)))throw err(400,'Неверный часовой пояс');
    const active=await db.query("SELECT 1 FROM industry.appointments WHERE tenant_id=$1 AND status IN ('new','confirmed') AND starts_at>now() LIMIT 1",[s.tenant_id]);
    if(active.rowCount)throw err(409,'Часовой пояс нельзя изменить при наличии будущих записей');
    await db.query('UPDATE industry.tenants SET timezone=$1 WHERE id=$2',[timezone,s.tenant_id]);
    await recordChange(db,s.tenant_id,s.account_id,'tenant.timezone_changed',s.tenant_id);
    return {timezone};
  }));
  app.get(prefix+'/resources/:id/hours',req=>forTenant(req,null,async(db,s)=>{
    const id=uuid(req.params.id);
    const resource=await db.query('SELECT slot_interval_minutes,buffer_minutes FROM industry.resources WHERE tenant_id=$1 AND id=$2 AND active',[s.tenant_id,id]);
    if(!resource.rowCount)throw err(404,'Рабочий календарь не найден');
    const [hours,off,closed]=await Promise.all([
      db.query('SELECT weekday,opens_at::text,closes_at::text FROM industry.resource_hours WHERE tenant_id=$1 AND resource_id=$2 ORDER BY weekday',[s.tenant_id,id]),
      db.query('SELECT id,starts_at,ends_at,reason FROM industry.resource_time_off WHERE tenant_id=$1 AND resource_id=$2 AND ends_at>now() ORDER BY starts_at ASC LIMIT 100',[s.tenant_id,id]),
      db.query('SELECT id,closed_date::text,reason FROM industry.resource_closed_dates WHERE tenant_id=$1 AND resource_id=$2 AND closed_date>=CURRENT_DATE ORDER BY closed_date LIMIT 100',[s.tenant_id,id])
    ]);
    return {hours:hours.rows,timeOff:off.rows,closedDates:closed.rows,slotIntervalMinutes:resource.rows[0].slot_interval_minutes,bufferMinutes:resource.rows[0].buffer_minutes};
  }));
  app.put(prefix+'/resources/:id/hours',req=>forTenant(req,roles,async(db,s)=>{
    const id=uuid(req.params.id),b=bodyOf(req);
    if(!Array.isArray(b.hours)||b.hours.length>7)throw err(400,'Не более 7 рабочих дней');
    const slotIntervalMinutes=b.slotIntervalMinutes??30,bufferMinutes=b.bufferMinutes??0;
    if(![15,30,60].includes(slotIntervalMinutes))throw err(400,'Шаг слота: 15, 30 или 60 минут');
    if(!Number.isInteger(bufferMinutes)||bufferMinutes<0||bufferMinutes>120||bufferMinutes%5!==0)throw err(400,'Буфер должен быть от 0 до 120 минут с шагом 5');
    const days=new Set();
    for(const h of b.hours){
      if(!h||!Number.isInteger(h.weekday)||h.weekday<1||h.weekday>7||
        !TIME.test(h.opensAt)||!TIME.test(h.closesAt)||h.opensAt>=h.closesAt||days.has(h.weekday))
        throw err(400,'Некорректный рабочий график');
      days.add(h.weekday);
    }
    await lockResource(db,s.tenant_id,id);
    const active=await db.query("SELECT 1 FROM industry.appointments WHERE tenant_id=$1 AND resource_id=$2 AND status IN ('new','confirmed') AND starts_at>now() LIMIT 1",[s.tenant_id,id]);
    if(active.rowCount)throw err(409,'Сначала перенесите или завершите будущие записи');
    await db.query('UPDATE industry.resources SET slot_interval_minutes=$3,buffer_minutes=$4 WHERE tenant_id=$1 AND id=$2',[s.tenant_id,id,slotIntervalMinutes,bufferMinutes]);
    await db.query('DELETE FROM industry.resource_hours WHERE tenant_id=$1 AND resource_id=$2',[s.tenant_id,id]);
    for(const h of b.hours)await db.query('INSERT INTO industry.resource_hours(tenant_id,resource_id,weekday,opens_at,closes_at) VALUES($1,$2,$3,$4::time,$5::time)',[s.tenant_id,id,h.weekday,h.opensAt,h.closesAt]);
    await recordChange(db,s.tenant_id,s.account_id,'resource.hours_changed',id);
    return {updated:true,slotIntervalMinutes,bufferMinutes};
  }));
  app.post(prefix+'/resources/:id/time-off',(req,reply)=>forTenant(req,roles,async(db,s)=>{
    const id=uuid(req.params.id),b=bodyOf(req),start=iso(b.startsAt),end=iso(b.endsAt);
    if(Date.parse(start)<Date.now()||Date.parse(end)<=Date.parse(start)||
      Date.parse(end)-Date.parse(start)>45*24*3600*1000)throw err(400,'Недопустимый период блокировки');
    const reason=typeof b.reason==='string'&&b.reason.trim()?b.reason.trim().slice(0,160):'Недоступно';
    await lockResource(db,s.tenant_id,id);
    const booked=await db.query("SELECT 1 FROM industry.appointments WHERE tenant_id=$1 AND resource_id=$2 AND status IN ('new','confirmed') "+
      "AND tstzrange(starts_at,ends_at,'[)') && tstzrange($3::timestamptz,$4::timestamptz,'[)') LIMIT 1",[s.tenant_id,id,start,end]);
    if(booked.rowCount)throw err(409,'На период блокировки есть записи');
    const r=await db.query('INSERT INTO industry.resource_time_off(tenant_id,resource_id,starts_at,ends_at,reason) VALUES($1,$2,$3,$4,$5) RETURNING id,starts_at,ends_at,reason',[s.tenant_id,id,start,end,reason]);
    await recordChange(db,s.tenant_id,s.account_id,'resource.time_off_created',r.rows[0].id);
    reply.code(201);return {item:r.rows[0]};
  }));
  app.delete(prefix+'/resources/:id/time-off/:offId',req=>forTenant(req,roles,async(db,s)=>{
    const id=uuid(req.params.id),offId=uuid(req.params.offId);
    await lockResource(db,s.tenant_id,id);
    const r=await db.query('DELETE FROM industry.resource_time_off WHERE tenant_id=$1 AND resource_id=$2 AND id=$3 RETURNING id',[s.tenant_id,id,offId]);
    if(!r.rowCount)throw err(404,'Блокировка не найдена');
    await recordChange(db,s.tenant_id,s.account_id,'resource.time_off_removed',offId);
    return {removed:true};
  }));
  app.post(prefix+'/resources/:id/closed-dates',(req,reply)=>forTenant(req,roles,async(db,s)=>{
    const id=uuid(req.params.id),b=bodyOf(req),closedDate=dateOnly(b.date);
    const delta=Date.parse(closedDate+'T00:00:00Z')-Date.now();
    if(delta< -86400000||delta>370*24*3600*1000)throw err(400,'Дата исключения должна быть в пределах 370 дней');
    const reason=typeof b.reason==='string'&&b.reason.trim()?b.reason.trim().slice(0,160):'Закрыто';
    await lockResource(db,s.tenant_id,id);
    const booked=await db.query("SELECT 1 FROM industry.appointments a JOIN industry.tenants t ON t.id=a.tenant_id WHERE a.tenant_id=$1 AND a.resource_id=$2 AND a.status IN ('new','confirmed') AND (a.starts_at AT TIME ZONE t.timezone)::date=$3::date LIMIT 1",[s.tenant_id,id,closedDate]);
    if(booked.rowCount)throw err(409,'На выбранную дату уже есть активные записи');
    const item=await db.query('INSERT INTO industry.resource_closed_dates(tenant_id,resource_id,closed_date,reason) VALUES($1,$2,$3::date,$4) RETURNING id,closed_date::text,reason',[s.tenant_id,id,closedDate,reason]);
    await recordChange(db,s.tenant_id,s.account_id,'resource.closed_date_created',item.rows[0].id);
    reply.code(201);return {item:item.rows[0]};
  }));
  app.delete(prefix+'/resources/:id/closed-dates/:dateId',req=>forTenant(req,roles,async(db,s)=>{
    const id=uuid(req.params.id),dateId=uuid(req.params.dateId);await lockResource(db,s.tenant_id,id);
    const removed=await db.query('DELETE FROM industry.resource_closed_dates WHERE tenant_id=$1 AND resource_id=$2 AND id=$3 RETURNING id',[s.tenant_id,id,dateId]);
    if(!removed.rowCount)throw err(404,'Исключённая дата не найдена');
    await recordChange(db,s.tenant_id,s.account_id,'resource.closed_date_removed',dateId);return {removed:true};
  }));
  app.get(prefix+'/availability',req=>forTenant(req,null,async(db,s)=>{
    const {resourceId,serviceId,date}=req.query||{};
    uuid(resourceId);uuid(serviceId);dateOnly(date);
    const d=new Date(date+'T00:00:00.000Z');
    if(!Number.isFinite(d.getTime())||d.getTime()<Date.now()-86400000||d.getTime()>Date.now()+370*24*3600*1000)throw err(400,'Дата вне периода записи');
    const service=await db.query('SELECT duration_minutes FROM industry.services WHERE tenant_id=$1 AND id=$2 AND active',[s.tenant_id,serviceId]);
    const resource=await db.query('SELECT id,slot_interval_minutes,buffer_minutes FROM industry.resources WHERE tenant_id=$1 AND id=$2 AND active',[s.tenant_id,resourceId]);
    if(!service.rowCount||!resource.rowCount)throw err(404,'Услуга или календарь недоступны');
    const mins=service.rows[0].duration_minutes,policy=resource.rows[0];
    const query='SELECT gs.slot AS starts_at FROM industry.resources r JOIN industry.tenants t ON t.id=r.tenant_id '+
      'JOIN industry.resource_hours h ON h.tenant_id=r.tenant_id AND h.resource_id=r.id '+
      'CROSS JOIN LATERAL generate_series((($3::date+h.opens_at) AT TIME ZONE t.timezone),'+
      '(($3::date+h.closes_at) AT TIME ZONE t.timezone)-make_interval(mins=>$4::int),make_interval(mins=>r.slot_interval_minutes)) AS gs(slot) '+
      'WHERE r.tenant_id=$1 AND r.id=$2 AND r.active AND h.weekday=EXTRACT(ISODOW FROM $3::date) AND gs.slot>=now() '+
      'AND NOT EXISTS (SELECT 1 FROM industry.resource_closed_dates c WHERE c.tenant_id=$1 AND c.resource_id=r.id AND c.closed_date=$3::date) '+
      "AND NOT EXISTS (SELECT 1 FROM industry.appointments a WHERE a.tenant_id=$1 AND a.resource_id=r.id AND a.status IN ('new','confirmed') "+
      "AND tstzrange(a.starts_at-make_interval(mins=>r.buffer_minutes),a.ends_at+make_interval(mins=>r.buffer_minutes),'[)') && "+
      "tstzrange(gs.slot-make_interval(mins=>r.buffer_minutes),gs.slot+make_interval(mins => $4::int + r.buffer_minutes),'[)')) "+
      "AND NOT EXISTS (SELECT 1 FROM industry.resource_time_off o WHERE o.tenant_id=$1 AND o.resource_id=r.id "+
      "AND tstzrange(o.starts_at,o.ends_at,'[)') && tstzrange(gs.slot-make_interval(mins=>r.buffer_minutes),gs.slot+make_interval(mins=>$4::int+r.buffer_minutes),'[)')) "+
      'ORDER BY starts_at LIMIT 100';
    const result=await db.query(query,[s.tenant_id,resourceId,date,mins]);
    const timezone=(await db.query('SELECT timezone FROM industry.tenants WHERE id=$1',[s.tenant_id])).rows[0].timezone;
    return {items:result.rows,timezone,slotIntervalMinutes:policy.slot_interval_minutes,bufferMinutes:policy.buffer_minutes};
  }));
  app.patch(prefix+'/appointments/:id/reschedule',req=>forTenant(req,['owner','manager','operator'],async(db,s)=>{
    const id=identifier(req.params.id),body=bodyOf(req),newResource=uuid(body.resourceId),start=iso(body.startsAt);
    if(Date.parse(start)<Date.now()-60000||Date.parse(start)>Date.now()+370*24*3600*1000)throw err(400,'Недопустимая дата');
    await lockResource(db,s.tenant_id,newResource);
    const existing=await db.query('SELECT a.status,v.duration_minutes FROM industry.appointments a JOIN industry.services v ON v.tenant_id=a.tenant_id AND v.id=a.service_id WHERE a.tenant_id=$1 AND a.id=$2 FOR UPDATE OF a',[s.tenant_id,id]);
    if(!existing.rowCount)throw err(404,'Запись не найдена');
    if(!['new','confirmed'].includes(existing.rows[0].status))throw err(409,'Нельзя переносить завершённую/отменённую запись');
    const end=new Date(Date.parse(start)+existing.rows[0].duration_minutes*60000).toISOString();
    await assertBookable(db,s.tenant_id,newResource,start,end,id);
    const r=await db.query('UPDATE industry.appointments SET resource_id=$1,starts_at=$2,ends_at=$3,updated_at=now() WHERE tenant_id=$4 AND id=$5 RETURNING id,resource_id,starts_at,ends_at,status',[newResource,start,end,s.tenant_id,id]);
    await recordChange(db,s.tenant_id,s.account_id,'appointment.rescheduled',id);
    return {item:r.rows[0]};
  }));
}
