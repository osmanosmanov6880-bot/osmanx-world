/**
 * R23 two-origin read-only canary: compare loopback API with canonical HTTPS
 * without credentials, redirects, arbitrary URLs, query injection or writes.
 *
 * A valid HTTPS status never authorizes production or claims the VPS has
 * correct keys/real customer consent. Exposes bounded booleans, not bodies.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectAvailability,LOCAL,PUBLIC,PROBES}
  from './r14-monitor.mjs';

export const CANARY_SCHEMA='osmanx.guest.r23.https-canary-parity.v1';
const EXPECTED=['live','ready','pilotsPrivate','safetyPrivate','incidentPrivate'];
export function assessR23Canary(local,remote){
  const checks={
    loopbackHealthy:local?.schema==='osmanx.guest.r14.monitor.v1'&&
      local?.target===LOCAL&&local.status==='healthy'&&
      local.guestWritesExpected===false&&local.ready===true,
    publicHealthy:remote?.schema==='osmanx.guest.r14.monitor.v1'&&
      remote?.target===PUBLIC&&remote.status==='healthy'&&
      remote.guestWritesExpected===false&&remote.ready===true,
    allUnauthorizedRoutesPrivate:EXPECTED.slice(2).every(id=>
      local?.observations?.[id]?.ok===true&&
      remote?.observations?.[id]?.ok===true&&
      local?.observations?.[id]?.status===401&&
      remote?.observations?.[id]?.status===401),
    statusParity:EXPECTED.every(id=>
      local?.observations?.[id]?.ok===true&&
      remote?.observations?.[id]?.ok===true&&
      local?.observations?.[id]?.status===remote?.observations?.[id]?.status),
    productionGuestWritesOff:local?.guestWritesExpected===false&&
      remote?.guestWritesExpected===false
  };
  const blockers=Object.entries(checks).filter(([,v])=>v!==true)
    .map(([k])=>'r23_canary_'+k);
  return {schema:CANARY_SCHEMA,checks,blockers,
    technicalCanaryReady:blockers.length===0,
    probeCount:PROBES.length*2,
    observedGuestData:false,
    customerGo:false,productionAuthorized:false,changedProduction:false,
    offsiteEvidenceVerified:false};
}
export async function inspectR23Canary({fetcher=fetch}={}){
  // Exact hostnames only, fixed five GET endpoints via R14 monitor.
  const [local,remote]=await Promise.all([
    inspectAvailability({base:LOCAL,fetcher,expectedWrites:false}),
    inspectAvailability({base:PUBLIC,fetcher,expectedWrites:false})
  ]);
  return assessR23Canary(local,remote);
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--compare')
      throw Error('Use --compare');
    const result=await inspectR23Canary();
    process.stdout.write(JSON.stringify(result)+'\n');
    if(!result.technicalCanaryReady)process.exitCode=2;
  }catch{
    process.stdout.write(JSON.stringify({schema:CANARY_SCHEMA,
      technicalCanaryReady:false,blockers:['r23_canary_unavailable'],
      productionAuthorized:false,customerGo:false,
      changedProduction:false})+'\n');
    process.exitCode=2;
  }
}
