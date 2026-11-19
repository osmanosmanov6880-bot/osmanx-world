/**
 * R19 first-pilot transactional controls. This module never approves a pilot
 * or obtains consent: it checks externally evidenced policy and counts only
 * successful collection transactions after existing R12-R18 gates.
 */
import {protocolDigest} from './guest-r19-scope.mjs';
const CLOSED=()=>{const e=new Error('R19: этот пилот не допущен к сбору или приостановлен');e.statusCode=503;return e;};
const QUOTA=()=>{const e=new Error('R19: дневной лимит операций пилота исчерпан');e.statusCode=429;return e;};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export async function assertR19Pilot(db,tenantId,pilotId,scope){
  if(!UUID.test(tenantId||'')||!UUID.test(pilotId||'')||
    scope?.tenantId!==tenantId||scope?.pilotId!==pilotId||scope?.valid!==true)
    throw CLOSED();
  try{
    const result=await db.query(
      'SELECT id,protocol,protocol_registered_at,launch_gate_enrolled_at FROM industry.guest_pilots WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [tenantId,pilotId]
    );
    if(result.rowCount!==1||!result.rows[0].launch_gate_enrolled_at||
       protocolDigest(result.rows[0])!==scope.record?.protocolDigest)
      throw CLOSED();
    const held=await db.query(
      'SELECT active FROM industry.guest_pilot_holds WHERE tenant_id=$1 AND pilot_id=$2',
      [tenantId,pilotId]
    );
    if(held.rows[0]?.active===true)throw CLOSED();
    const end=scope.record.policy.retentionDays;
    const protocolEnd=result.rows[0].protocol?.endDate;
    if(typeof protocolEnd!=='string'||!Number.isFinite(Date.parse(protocolEnd+'T00:00:00Z'))||
       Date.now()>Date.parse(protocolEnd+'T00:00:00Z')+end*86400000)
      throw CLOSED();
    return true;
  }catch{throw CLOSED();}
}
export async function consumeR19Budget(db,{tenantId,pilotId,kind,scope}){
  if(!UUID.test(tenantId||'')||!UUID.test(pilotId||'')||
     !['start','observations','observations/import'].includes(kind)||
     scope?.valid!==true||scope.tenantId!==tenantId||
     scope.pilotId!==pilotId)throw CLOSED();
  try{
    const maxDaily=scope.maxDailyWrites;
    const r=await db.query(
      "INSERT INTO industry.guest_r19_daily_usage"+
      "(tenant_id,pilot_id,utc_day,used_count,max_daily,last_scope_sha)"+
      " VALUES($1,$2,(now() AT TIME ZONE 'UTC')::date,1,$3,$4)"+
      " ON CONFLICT(tenant_id,pilot_id,utc_day) DO UPDATE"+
      " SET used_count=industry.guest_r19_daily_usage.used_count+1,"+
      " max_daily=LEAST(industry.guest_r19_daily_usage.max_daily,EXCLUDED.max_daily),"+
      " last_scope_sha=EXCLUDED.last_scope_sha,updated_at=now()"+
      " WHERE industry.guest_r19_daily_usage.used_count<LEAST(industry.guest_r19_daily_usage.max_daily,EXCLUDED.max_daily)"+
      " RETURNING used_count,max_daily",
      [tenantId,pilotId,maxDaily,scope.scopeDigest]
    );
    if(r.rowCount!==1)throw QUOTA();
    await db.query(
      "INSERT INTO industry.guest_r19_collection_events"+
      "(tenant_id,pilot_id,kind,utc_day,scope_sha)"+
      " VALUES($1,$2,$3,(now() AT TIME ZONE 'UTC')::date,$4)",
      [tenantId,pilotId,kind,scope.scopeDigest]
    );
    return {used:Number(r.rows[0].used_count),limit:Number(r.rows[0].max_daily)};
  }catch(e){
    if(e?.statusCode===429)throw e;
    // SQL details are not transmitted to API consumers.
    throw CLOSED();
  }
}
export async function inspectR19Budget(db,tenantId,pilotId,scope){
  try{
    if(!UUID.test(tenantId||'')||!UUID.test(pilotId||'')||
       scope?.tenantId!==tenantId||scope.pilotId!==pilotId)
      return {available:false,used:null,maxDaily:null};
    const result=await db.query(
      "SELECT used_count,max_daily FROM industry.guest_r19_daily_usage"+
      " WHERE tenant_id=$1 AND pilot_id=$2 AND utc_day=(now() AT TIME ZONE 'UTC')::date",
      [tenantId,pilotId]
    );
    const used=Number(result.rows[0]?.used_count??0);
    const maxDaily=Math.min(Number(result.rows[0]?.max_daily??scope.maxDailyWrites),
      scope.maxDailyWrites);
    return {available:used<maxDaily,used,maxDaily};
  }catch{return {available:false,used:null,maxDaily:null};}
}
