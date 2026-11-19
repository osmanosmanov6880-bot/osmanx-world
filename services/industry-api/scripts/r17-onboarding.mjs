/**
 * R17 first-customer onboarding rehearsal. Strictly READ ONLY:
 * - verified R16 tenant permit / emergency STOP
 * - two independently signed R17 witnesses + hash-chain
 * - PostgreSQL read-only RLS, checkpoint floor, tenant existence and R13 holds
 * - loopback-only R14 canary GET probes
 * It NEVER enables writes, creates an account, lifts a hold or claims legal GO.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectR16Tenant} from '../src/guest-r16-registry.mjs';
import {loadR17Witness} from '../src/guest-r17-witness.mjs';
import {inspectR17Fence} from '../src/guest-r17-fence.mjs';
import {inspectAvailability,LOCAL} from './r14-monitor.mjs';
import {probeGuestDatabase} from '../src/readiness.mjs';
import {makePool,withTenant} from '../src/database.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const issue=(xs,msg)=>{if(!xs.includes(msg))xs.push(msg);};
export async function rehearseFirstCustomer({
  tenantId,env=process.env,now=new Date(),pool=null,fetcher=fetch
}={}){
  const blockers=[];
  const report={
    schema:'osmanx.guest.r17.first-customer-rehearsal.v1',
    tenantId:UUID.test(tenantId||'')?tenantId:null,
    signedTenantPermit:false,independentWitnesses:false,
    registryRevision:null,witnessSequence:null,
    schemaReady:false,fenceReady:false,tenantExists:false,
    heldPilotCount:null,canaryHealthy:false,
    technicalReviewPassed:false,customerGo:false,
    changedProduction:false,blockers
  };
  if(!report.tenantId){issue(blockers,'invalid_tenant_id');return report;}
  try{
    const permit=await inspectR16Tenant(tenantId,env,now);
    report.signedTenantPermit=permit.permitValid===true;
    report.registryRevision=permit.registryRevision;
    if(!report.signedTenantPermit)issue(blockers,'tenant_admission_or_hold');
  }catch{issue(blockers,'tenant_admission_or_hold');}
  let witness=null;
  try{
    witness=await loadR17Witness(env,now);
    report.independentWitnesses=true;
    report.witnessSequence=witness.sequence;
  }catch{issue(blockers,'witness_not_verified');}
  try{
    const canary=await inspectAvailability({base:LOCAL,fetcher,expectedWrites:false});
    report.canaryHealthy=canary.status==='healthy';
    if(!report.canaryHealthy)issue(blockers,'isolated_canary_not_healthy');
  }catch{issue(blockers,'isolated_canary_not_healthy');}
  if(pool){
    try{
      await probeGuestDatabase(pool);
      report.schemaReady=true;
      await withTenant(pool,tenantId,async db=>{
        const tenant=await db.query('SELECT id FROM industry.tenants WHERE id=$1',[tenantId]);
        report.tenantExists=tenant.rowCount===1;
        const holds=await db.query(
          'SELECT count(*)::int AS held FROM industry.guest_pilot_holds WHERE tenant_id=$1 AND active',
          [tenantId]
        );
        report.heldPilotCount=Number(holds.rows[0]?.held??0);
        if(witness){
          const status=await inspectR17Fence(db,witness);
          report.fenceReady=status.fenceReady;
        }
      });
      if(!report.tenantExists)issue(blockers,'tenant_not_provisioned');
      if(report.heldPilotCount!==0)issue(blockers,'r13_pilots_held');
      if(!report.fenceReady)issue(blockers,'database_checkpoint_fence');
    }catch{issue(blockers,'database_readiness_unavailable');}
  }else issue(blockers,'database_readiness_unavailable');
  report.technicalReviewPassed=blockers.length===0;
  return report;
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--tenant'){
    process.stderr.write('Usage: node scripts/r17-onboarding.mjs --tenant TENANT_UUID\n');
    process.exitCode=2;
  }else{
    let pool;
    try{
      pool=makePool();
      const report=await rehearseFirstCustomer({tenantId:args[1],pool});
      process.stdout.write(JSON.stringify(report)+'\n');
      if(!report.technicalReviewPassed)process.exitCode=2;
    }catch{
      process.stderr.write('R17 onboarding rehearsal unavailable. Never enable customer writes.\n');
      process.exitCode=2;
    }finally{if(pool)await pool.end();}
  }
}
