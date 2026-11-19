/**
 * R23 independent operator's cross-tenant RLS rehearsal.
 * Requires TWO pre-existing synthetic/authorized pilot UUIDs and a least-
 * privilege app-role pool. Only SELECT and transaction-local set_config in
 * ONE read-only transaction; any missing foreign control sample fails closed.
 * No raw tenant records, emails, user IDs or DB identifiers in the report.
 */
export const RLS_SCHEMA='osmanx.guest.r23.read-only-rls-rehearsal.v1';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const safeUuid=x=>UUID.test(x||'');
const result=()=>({
  schema:RLS_SCHEMA,firstOwnVisible:false,firstForeignHidden:false,
  secondOwnVisible:false,secondForeignHidden:false,
  appRoleLeastPrivilege:false,transactionRolledBack:false,
  readOnlyQueries:true,technicalIsolationPass:false,
  blockers:[],customerGo:false,productionAuthorized:false,
  changedProduction:false,customerDataReturned:false
});
export async function rehearseR23TenantIsolation(pool,{
  tenantA,pilotA,tenantB,pilotB
}={}){
  const out=result();
  if(!pool||![tenantA,pilotA,tenantB,pilotB].every(safeUuid)||
      tenantA===tenantB||pilotA===pilotB){
    out.blockers.push('invalid_distinct_tenant_control_samples');
    return out;
  }
  let client=null,started=false;
  try{
    client=await pool.connect();
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    started=true;
    const role=await client.query(
      "SELECT COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_roles"+
      " WHERE rolname=current_user),true) AS privileged"
    );
    out.appRoleLeastPrivilege=role.rowCount===1&&role.rows[0]?.privileged===false;
    for(const [tenant,ownPilot,foreignPilot,ownKey,foreignKey] of [
      [tenantA,pilotA,pilotB,'firstOwnVisible','firstForeignHidden'],
      [tenantB,pilotB,pilotA,'secondOwnVisible','secondForeignHidden']
    ]){
      await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
      const response=await client.query(
        "SELECT EXISTS(SELECT 1 FROM industry.guest_pilots WHERE id=$1) AS own,"+
        " EXISTS(SELECT 1 FROM industry.guest_pilots WHERE id=$2) AS foreign",
        [ownPilot,foreignPilot]
      );
      out[ownKey]=response.rowCount===1&&response.rows[0]?.own===true;
      out[foreignKey]=response.rowCount===1&&response.rows[0]?.foreign===false;
    }
  }catch{out.blockers.push('rls_read_only_rehearsal_unavailable');}
  finally{
    if(client){
      if(started){
        try{await client.query('ROLLBACK');out.transactionRolledBack=true;}
        catch{out.blockers.push('transaction_rollback_failed');}
      }
      client.release();
    }
  }
  for(const key of ['firstOwnVisible','firstForeignHidden','secondOwnVisible',
    'secondForeignHidden','appRoleLeastPrivilege','transactionRolledBack'])
    if(out[key]!==true)out.blockers.push('rls_'+key);
  out.blockers=[...new Set(out.blockers)];
  out.technicalIsolationPass=out.blockers.length===0;
  return out;
}
