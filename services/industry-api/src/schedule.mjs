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

export async function lockResource(db,tenantId,resourceId){
  uuid(resourceId);
  const r=await db.query('SELECT id FROM industry.resources WHERE tenant_id=$1 AND id=$2 AND active FOR UPDATE',[tenantId,resourceId]);
  if(!r.rowCount)throw err(404,'Рабочий календарь не найден');
}
export async function assertBookable(db,tenantId,resourceId,startISO,endISO){
  // Caller must first lock the active resource FOR UPDATE.
  const query='SELECT EXISTS ( SELECT 1 FROM industry.resource_hours h JOIN industry.tenants t ON t.id=h.tenant_id '+
   'WHERE h.tenant_id=$1 AND h.resource_id=$2 '+
   'AND h.weekday=EXTRACT(ISODOW FROM ($3::timestamptz AT TIME ZONE t.timezone)) '+
   'AND ($3::timestamptz AT TIME ZONE t.timezone)::time >= h.opens_at '+
   'AND ($4::timestamptz AT TIME ZONE t.timezone)::time <= h.closes_at '+
   'AND ($3::timestamptz AT TIME ZONE t.timezone)::date = ($4::timestamptz AT TIME ZONE t.timezone)::date '+
   ') AS within_hours, EXISTS (SELECT 1 FROM industry.resource_time_off o WHERE o.tenant_id=$1 AND o.resource_id=$2 '+
   "AND tstzrange(o.starts_at,o.ends_at,'[)') && tstzrange($3::timestamptz,$4::timestamptz,'[)')) AS time_off";
  const r=await db.query(query,[tenantId,resourceId,startISO,endISO]);
  if(!r.rows[0].within_hours)throw err(409,'Время вне рабочего графика');
  if(r.rows[0].time_off)throw err(409,'Календарь недоступен в это время');
}
export function registerScheduleRoutes(app,{prefix,forTenant,bodyOf,identifier}){
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
    const hours=await db.query('SELECT weekday,opens_at::text,closes_at::text FROM industry.resource_hours WHERE tenant_id=$1 AND resource_id=$2 ORDER BY weekday',[s.tenant_id,id]);
    const off=await db.query('SELECT id,starts_at,ends_at,reason FROM industry.resource_time_off WHERE tenant_id=$1 AND resource_id=$2 AND ends_at>now() ORDER BY starts_at ASC LIMIT 100',[s.tenant_id,id]);
    return {hours:hours.rows,timeOff:off.rows};
  }));
  app.put(prefix+'/resources/:id/hours',req=>forTenant(req,roles,async(db,s)=>{
    const id=uuid(req.params.id),b=bodyOf(req);
    if(!Array.isArray(b.hours)||b.hours.length>7)throw err(400,'Не более 7 рабочих дней');
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
    await db.query('DELETE FROM industry.resource_hours WHERE tenant_id=$1 AND resource_id=$2',[s.tenant_id,id]);
    for(const h of b.hours)await db.query('INSERT INTO industry.resource_hours(tenant_id,resource_id,weekday,opens_at,closes_at) VALUES($1,$2,$3,$4::time,$5::time)',[s.tenant_id,id,h.weekday,h.opensAt,h.closesAt]);
    await recordChange(db,s.tenant_id,s.account_id,'resource.hours_changed',id);
    return {updated:true};
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
  app.get(prefix+'/availability',req=>forTenant(req,null,async(db,s)=>{
    const {resourceId,serviceId,date}=req.query||{};
    uuid(resourceId);uuid(serviceId);
    if(typeof date!=='string'||!DATE.test(date))throw err(400,'Укажите дату YYYY-MM-DD');
    const d=new Date(date+'T00:00:00.000Z');
    if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==date||
       d.getTime()<Date.now()-86400000||d.getTime()>Date.now()+370*86400000)throw err(400,'Дата вне периода записи');
    const service=await db.query('SELECT duration_minutes FROM industry.services WHERE tenant_id=$1 AND id=$2 AND active',[s.tenant_id,serviceId]);
    const resource=await db.query('SELECT id FROM industry.resources WHERE tenant_id=$1 AND id=$2 AND active',[s.tenant_id,resourceId]);
    if(!service.rowCount||!resource.rowCount)throw err(404,'Услуга или календарь недоступны');
    const mins=service.rows[0].duration_minutes;
    const query='SELECT gs.slot AS starts_at FROM industry.resources r JOIN industry.tenants t ON t.id=r.tenant_id '+
      'JOIN industry.resource_hours h ON h.tenant_id=r.tenant_id AND h.resource_id=r.id '+
      'CROSS JOIN LATERAL generate_series('+
      '(($3::date + h.opens_at) AT TIME ZONE t.timezone),'+
      '(($3::date + h.closes_at) AT TIME ZONE t.timezone) - make_interval(mins=>$4::int),'+
      "interval '30 minutes') AS gs(slot) "+
      'WHERE r.tenant_id=$1 AND r.id=$2 AND r.active AND h.weekday=EXTRACT(ISODOW FROM $3::date) AND gs.slot>=now() '+
      "AND NOT EXISTS (SELECT 1 FROM industry.appointments a WHERE a.tenant_id=$1 AND a.resource_id=r.id AND a.status IN ('new','confirmed') "+
      "AND tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(gs.slot,gs.slot+make_interval(mins=>$4::int),'[)')) "+
      "AND NOT EXISTS (SELECT 1 FROM industry.resource_time_off o WHERE o.tenant_id=$1 AND o.resource_id=r.id "+
      "AND tstzrange(o.starts_at,o.ends_at,'[)') && tstzrange(gs.slot,gs.slot+make_interval(mins=>$4::int),'[)')) "+
      'ORDER BY starts_at LIMIT 100';
    const result=await db.query(query,[s.tenant_id,resourceId,date,mins]);
    const timezone=(await db.query('SELECT timezone FROM industry.tenants WHERE id=$1',[s.tenant_id])).rows[0].timezone;
    return {items:result.rows,timezone};
  }));
  app.patch(prefix+'/appointments/:id/reschedule',req=>forTenant(req,['owner','manager','operator'],async(db,s)=>{
    const id=identifier(req.params.id),body=bodyOf(req),newResource=uuid(body.resourceId),start=iso(body.startsAt);
    if(Date.parse(start)<Date.now()-60000||Date.parse(start)>Date.now()+370*24*3600*1000)throw err(400,'Недопустимая дата');
    await lockResource(db,s.tenant_id,newResource);
    const existing=await db.query('SELECT a.status,v.duration_minutes FROM industry.appointments a JOIN industry.services v ON v.tenant_id=a.tenant_id AND v.id=a.service_id WHERE a.tenant_id=$1 AND a.id=$2 FOR UPDATE OF a',[s.tenant_id,id]);
    if(!existing.rowCount)throw err(404,'Запись не найдена');
    if(!['new','confirmed'].includes(existing.rows[0].status))throw err(409,'Нельзя переносить завершённую/отменённую запись');
    const end=new Date(Date.parse(start)+existing.rows[0].duration_minutes*60000).toISOString();
    await assertBookable(db,s.tenant_id,newResource,start,end);
    const r=await db.query('UPDATE industry.appointments SET resource_id=$1,starts_at=$2,ends_at=$3,updated_at=now() WHERE tenant_id=$4 AND id=$5 RETURNING id,resource_id,starts_at,ends_at,status',[newResource,start,end,s.tenant_id,id]);
    await recordChange(db,s.tenant_id,s.account_id,'appointment.rescheduled',id);
    return {item:r.rows[0]};
  }));
}
