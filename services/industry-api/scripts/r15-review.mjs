/**
 * R15 non-mutating operator command. Validates external signed evidence,
 * current release and fresh R14 canary monitor before suggesting any next step.
 * It cannot enable writes, clear an R13 hold, restart Docker or enroll a client.
 */
import {inspectAvailability,LOCAL} from './r14-monitor.mjs';
import {loadTenantPermit,inspectTenantPermit} from '../src/guest-tenant-authorization.mjs';
import {advanceIncident} from './r14-incident.mjs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function decideR15({permitReport,monitor,incident,tenantId}={}){
  const blockers=[];
  if(permitReport?.permitValid!==true)blockers.push('invalid_tenant_permit');
  if(monitor?.status!=='healthy'||monitor?.guestWritesExpected!==false||
      monitor?.customerGoDecision!==false)blockers.push('canary_not_safe');
  if(incident?.phase!=='normal'||incident?.event==='opened'||
      !Number.isSafeInteger(incident?.failures)||incident.failures!==0)
    blockers.push('unresolved_monitor_incident');
  if(typeof tenantId!=='string'||tenantId.length!==36)
    blockers.push('missing_tenant');
  return {
    schema:'osmanx.guest.r15.operational-review.v1',
    tenantId:tenantId||null,
    technicalReviewPassed:blockers.length===0,
    blockers,
    writesChanged:false,
    nextAction:blockers.length?
      'NO-GO: do not collect customer data; inspect blockers and repeat independent admission.':
      'Technical preflight passed. Separate independent administrative, legal and offsite recovery acceptance is still required.'
  };
}
export async function inspectR15({tenantId,fetcher=fetch,env=process.env,now=new Date()}={}){
  let report={permitValid:false,blockers:['missing_permit']},bundle;
  try{
    bundle=await loadTenantPermit(env,now);
    if(bundle)report=inspectTenantPermit({...bundle,tenantId,now});
  }catch{report={permitValid:false,blockers:['invalid_external_admission']};}
  // The read-only canary must not have collection enabled.
  const monitor=await inspectAvailability({base:LOCAL,fetcher,expectedWrites:false});
  const incident=advanceIncident(undefined,{status:monitor.status});
  return {
    permit:report,monitor,incident,
    decision:decideR15({permitReport:report,monitor,incident,tenantId})
  };
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  if(process.argv.length!==4||process.argv[2]!=='--tenant')
    throw Error('Usage: node scripts/r15-review.mjs --tenant TENANT_UUID');
  const result=await inspectR15({tenantId:process.argv[3]});
  process.stdout.write(JSON.stringify(result)+'\n');
  if(!result.decision.technicalReviewPassed)process.exitCode=2;
}
