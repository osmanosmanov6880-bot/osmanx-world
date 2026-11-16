import pg from 'pg';
export function makePool(connectionString=process.env.DATABASE_URL) {
  if (!connectionString) throw Error('DATABASE_URL is required');
  const pool = new pg.Pool({connectionString,max:12,connectionTimeoutMillis:4500,idleTimeoutMillis:30000,application_name:'osmanx_industry_api'});
  pool.on('error',error=>console.error('Postgres idle connection error',error.message));
  return pool;
}
export async function withTenant(pool, tenantId, fn) {
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)",[tenantId]);
    const result=await fn(client);
    await client.query('COMMIT');
    return result;
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally {client.release();}
}
export async function requireMembership(client,tenantId,accountId,allowed) {
  const r=await client.query('SELECT role FROM industry.memberships WHERE tenant_id=$1 AND account_id=$2',[tenantId,accountId]);
  if (!r.rowCount) {
    const e=new Error('Нет доступа к организации');e.statusCode=403;throw e;
  }
  const role=r.rows[0].role;
  if (allowed && !allowed.includes(role)) {
    const e=new Error('Недостаточно прав');e.statusCode=403;throw e;
  }
  return role;
}
export async function recordChange(client,tenantId,actorId,action,targetId,data) {
  await client.query('INSERT INTO industry.audit_events(tenant_id,actor_id,action,target_id) VALUES($1,$2,$3,$4)',[tenantId,actorId,action,targetId]);
  await client.query('INSERT INTO industry.outbox(tenant_id,kind,payload) VALUES ($1,$2,$3::jsonb)',[tenantId,action,JSON.stringify({event:action,tenantId,entityId:targetId,...data})]);
}
