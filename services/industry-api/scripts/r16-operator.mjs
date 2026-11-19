/**
 * Operator-only R16 control.
 * - review and review-tenant inspect signed evidence without mutating systems
 * - stop-global / stop-tenant atomically create an emergency deny marker
 * Never un-stops, enables writes, alters DNS, reads guest rows or starts VPS.
 */
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {
  loadR16Registry,inspectR16Tenant,emergencyStop
} from '../src/guest-r16-registry.mjs';
import {inspectAvailability,LOCAL} from './r14-monitor.mjs';

export async function reviewRegistry(env=process.env,now=new Date()){
  const summary={schema:'osmanx.guest.r16.operator-review.v1',
    releaseVerified:false,tenantCount:0,revokedCount:0,validTenantCount:0,
    registryRevision:null,canaryStatus:'not_checked',
    customerGo:false,writesChanged:false,blockers:[],tenantStatuses:[]};
  try{
    const snapshot=await loadR16Registry(env,now);
    summary.releaseVerified=true;
    summary.registryRevision=snapshot.revision;
    summary.tenantCount=snapshot.registry.tenants.length;
    summary.revokedCount=snapshot.registry.revoked.length;
    for(const entry of snapshot.registry.tenants){
      const check=await inspectR16Tenant(entry.tenantId,env,now);
      summary.tenantStatuses.push({
        tenantId:entry.tenantId,
        reason:check.reason,permitValid:check.permitValid,
        validUntil:check.validUntil
      });
      if(check.permitValid)summary.validTenantCount++;
    }
    if(summary.validTenantCount!==summary.tenantCount)
      summary.blockers.push('one_or_more_tenants_unavailable');
  }catch{summary.blockers.push('invalid_signed_registry');}
  return summary;
}
export async function reviewWithCanary(env=process.env,now=new Date(),fetcher=fetch){
  const review=await reviewRegistry(env,now);
  const monitor=await inspectAvailability({base:LOCAL,fetcher,expectedWrites:false});
  review.canaryStatus=monitor.status;
  if(monitor.status!=='healthy')review.blockers.push('unhealthy_isolated_canary');
  // Even clean metrics are never a live authorization.
  return review;
}
async function main(args,env=process.env){
  const [command,tenantId,...extra]=args;
  if(extra.length||!['review','review-tenant','review-canary',
     'stop-global','stop-tenant'].includes(command))
    throw Error('Usage: r16-operator.mjs review|review-tenant UUID|review-canary|stop-global|stop-tenant UUID');
  if((command==='review-tenant'||command==='stop-tenant')&&!tenantId)
    throw Error('Tenant ID required');
  if(['review','review-canary','stop-global'].includes(command)&&tenantId)
    throw Error('Unexpected tenant ID');
  if(command==='review')return reviewRegistry(env);
  if(command==='review-canary')return reviewWithCanary(env);
  if(command==='review-tenant')return inspectR16Tenant(tenantId,env);
  return emergencyStop(env.GUEST_R16_REGISTRY_FILE,{
    tenantId:command==='stop-tenant'?tenantId:null,
    ack:env.R16_STOP_ACK
  });
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    const out=await main(process.argv.slice(2));
    process.stdout.write(JSON.stringify(out)+'\n');
    if(out.blockers?.length||out.permitValid===false)process.exitCode=2;
  }catch{
    process.stderr.write('R16 operation refused: verify private paths, privileges and explicit stop acknowledgment\n');
    process.exitCode=2;
  }
}
