/**
 * R19 first-client operational rehearsal. Entire DB transaction is READ ONLY.
 * Produces no business approval; legal/offsite/contract evidence requires an
 * independently audited external procedure even if all synthetic tests pass.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makePool} from '../src/database.mjs';
import {probeGuestDatabase} from '../src/readiness.mjs';
import {inspectR16Tenant} from '../src/guest-r16-registry.mjs';
import {loadR17Witness} from '../src/guest-r17-witness.mjs';
import {inspectR17Fence} from '../src/guest-r17-fence.mjs';
import {loadR18Anchor} from '../src/guest-r18-anchor.mjs';
import {inspectR18Fence} from '../src/guest-r18-fence.mjs';
import {loadR19Scope,protocolDigest} from '../src/guest-r19-scope.mjs';
import {inspectR19Budget} from '../src/guest-r19-usage.mjs';
import {inspectAvailability,LOCAL} from './r14-monitor.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const add=(a,reason)=>{if(!a.includes(reason))a.push(reason);};
export async function rehearseR19({
  tenantId,pilotId,env=process.env,now=new Date(),pool=null,fetcher=fetch
}={}){
  const blockers=[];
  const report={
    schema:'osmanx.guest.r19.operator-rehearsal.v1',
    tenantId:UUID.test(tenantId||'')?tenantId:null,
    pilotId:UUID.test(pilotId||'')?pilotId:null,
    r16PermitValid:false,r17WitnessValid:false,r18CustodianValid:false,
    r19PilotScopeValid:false,r19ProtocolMatches:false,
    r12LaunchEnrolled:false,r13Unheld:false,canaryHealthy:false,
    dbMigrationReady:false,r17FenceReady:false,r18FenceReady:false,
    budgetRemaining:null,technicalPreflightReady:false,
    legalGo:false,customerGo:false,changedProduction:false,
    independentLegalEvidenceConfirmed:false,offsiteStorageVerified:false,
    blockers
  };
  if(!report.tenantId||!report.pilotId){
    add(blockers,'invalid_tenant_or_pilot');return report;
  }
  try{
    const permit=await inspectR16Tenant(tenantId,env,now);
    report.r16PermitValid=permit.permitValid===true;
    if(!report.r16PermitValid)add(blockers,'r16_tenant_not_admitted');
  }catch{add(blockers,'r16_tenant_not_admitted');}
  let witness=null,anchor=null,scope=null;
  try{witness=await loadR17Witness(env,now);report.r17WitnessValid=true;}
  catch{add(blockers,'r17_witness_unavailable');}
  if(witness){
    try{anchor=await loadR18Anchor(env,witness,now);report.r18CustodianValid=true;}
    catch{add(blockers,'r18_custodian_unavailable');}
  }else add(blockers,'r18_custodian_unavailable');
  if(anchor){
    try{
      scope=await loadR19Scope(env,anchor,now);
      report.r19PilotScopeValid=scope.tenantId===tenantId&&scope.pilotId===pilotId;
      if(!report.r19PilotScopeValid)add(blockers,'r19_wrong_tenant_or_pilot');
    }catch{add(blockers,'r19_scope_missing_stopped_or_expired');}
  }else add(blockers,'r19_scope_missing_stopped_or_expired');
  try{
    const canary=await inspectAvailability({base:LOCAL,fetcher,expectedWrites:false});
    report.canaryHealthy=canary.status==='healthy';
    if(!report.canaryHealthy)add(blockers,'r14_canary_unavailable');
  }catch{add(blockers,'r14_canary_unavailable');}
  if(!pool){add(blockers,'read_only_database_unavailable');return report;}
  let client;
  try{
    await probeGuestDatabase(pool);
    client=await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantId]);
    const versions=await client.query(
      "SELECT count(*)::int AS n FROM industry.schema_migrations WHERE name='014_guest_single_pilot_rollout.sql'"
    );
    report.dbMigrationReady=Number(versions.rows[0]?.n)===1;
    if(!report.dbMigrationReady)add(blockers,'missing_migration_014');
    const pil=await client.query(
      'SELECT id,protocol,protocol_registered_at,launch_gate_enrolled_at,phase FROM industry.guest_pilots WHERE tenant_id=$1 AND id=$2',
      [tenantId,pilotId]
    );
    if(pil.rowCount!==1)add(blockers,'pilot_not_found');
    else{
      const pilot=pil.rows[0];
      report.r12LaunchEnrolled=!!pilot.launch_gate_enrolled_at;
      if(!report.r12LaunchEnrolled)add(blockers,'r12_launch_not_enrolled');
      report.r19ProtocolMatches=scope?.record?.protocolDigest===protocolDigest(pilot);
      if(!report.r19ProtocolMatches)add(blockers,'signed_protocol_mismatch');
    }
    const hold=await client.query(
      'SELECT active FROM industry.guest_pilot_holds WHERE tenant_id=$1 AND pilot_id=$2',
      [tenantId,pilotId]
    );
    report.r13Unheld=hold.rows[0]?.active!==true;
    if(!report.r13Unheld)add(blockers,'r13_active_safety_stop');
    if(witness){
      report.r17FenceReady=(await inspectR17Fence(client,witness)).fenceReady;
      if(!report.r17FenceReady)add(blockers,'r17_fence_not_ready');
    }
    if(anchor){
      report.r18FenceReady=(await inspectR18Fence(client,anchor)).fenceReady;
      if(!report.r18FenceReady)add(blockers,'r18_fence_not_ready');
    }
    if(scope&&report.r19PilotScopeValid){
      const budget=await inspectR19Budget(client,tenantId,pilotId,scope);
      report.budgetRemaining=budget.available?
        Math.max(0,budget.maxDaily-budget.used):0;
      if(!budget.available)add(blockers,'r19_daily_quota_exhausted');
    }
  }catch{add(blockers,'database_readiness_unavailable');}
  finally{
    if(client){
      await client.query('ROLLBACK').catch(()=>{});
      client.release();
    }
  }
  report.technicalPreflightReady=blockers.length===0;
  return report;
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  let pool;
  try{
    const [flagA,tenantId,flagB,pilotId,...extra]=process.argv.slice(2);
    if(flagA!=='--tenant'||flagB!=='--pilot'||extra.length)
      throw Error('Usage: --tenant TENANT_UUID --pilot PILOT_UUID');
    pool=makePool();
    const report=await rehearseR19({tenantId,pilotId,pool});
    process.stdout.write(JSON.stringify(report)+'\n');
    if(!report.technicalPreflightReady)process.exitCode=2;
  }catch{
    process.stderr.write('R19 technical rehearsal unavailable; no production actions taken.\n');
    process.exitCode=2;
  }finally{if(pool)await pool.end();}
}
