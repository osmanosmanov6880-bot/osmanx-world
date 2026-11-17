// R4 integration observability and dead-letter recovery, tenant-scoped by RLS.
import { recordChange } from './database.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function err(code,message){const e=new Error(message);e.statusCode=code;return e;}
export function registerIntegrationRoutes(app,{prefix,forTenant}){
  app.get(prefix+'/integrations/status',req=>forTenant(req,['owner','manager'],async(db,s)=>{
    const r=await db.query(
      'SELECT count(*) FILTER (WHERE delivered_at IS NULL AND dead_at IS NULL)::int AS queued,'+
      ' count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,'+
      ' count(*) FILTER (WHERE dead_at IS NOT NULL)::int AS dead,'+
      " max(created_at) FILTER (WHERE delivered_at IS NULL AND dead_at IS NULL) AS newest_pending FROM industry.outbox WHERE tenant_id=$1",
      [s.tenant_id]);
    return {stats:r.rows[0],webhookConfigured:!!(process.env.WEBHOOK_URL&&process.env.WEBHOOK_HMAC_KEY)};
  }));
  app.get(prefix+'/integrations/events',req=>forTenant(req,['owner','manager'],async(db,s)=>{
    const status=req.query?.status||'all';
    if(!['all','queued','delivered','dead'].includes(status))throw err(400,'Некорректный статус');
    const condition={
      all:'true',
      queued:'delivered_at IS NULL AND dead_at IS NULL',
      delivered:'delivered_at IS NOT NULL',
      dead:'dead_at IS NOT NULL'
    }[status];
    const result=await db.query(
      'SELECT id,kind,attempts,created_at,available_at,locked_until,delivered_at,dead_at,last_error FROM industry.outbox WHERE tenant_id=$1 AND ('+condition+') ORDER BY created_at DESC LIMIT 100',
      [s.tenant_id]);
    // Event payload intentionally excluded (it may include user data).
    return {items:result.rows};
  }));
  app.post(prefix+'/integrations/events/:id/retry',req=>forTenant(req,['owner','manager'],async(db,s)=>{
    const id=req.params.id;
    if(typeof id!=='string'||!UUID.test(id))throw err(400,'Некорректный ID');
    const x=await db.query(
      "UPDATE industry.outbox SET attempts=0,dead_at=NULL,available_at=now(),locked_until=NULL,lease_token=NULL,last_error=NULL "+
      'WHERE tenant_id=$1 AND id=$2 AND dead_at IS NOT NULL AND delivered_at IS NULL RETURNING id,kind',
      [s.tenant_id,id]);
    if(!x.rowCount)throw err(409,'Событие отсутствует или не ожидает повтора');
    // Do not create an outbox event for this action (avoids infinite feedback loops).
    await db.query('INSERT INTO industry.audit_events(tenant_id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[s.tenant_id,s.account_id,'integration.retry',id]);
    return {requeued:true,eventId:id};
  }));
}
