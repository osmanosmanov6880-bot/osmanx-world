/**
 * R14 anonymous, bounded operational probe. It NEVER makes write requests,
 * follows redirects, sends cookies or reads tenant records.
 */
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const LOCAL='http://127.0.0.1:3150';
export const PUBLIC='https://osmanx.world';
export const API='/api/industry/v1';
export const SCHEMA='011_guest_pilot_safety.sql';
const PILOT='00000000-0000-4000-8000-000000000000';
export const PROBES=Object.freeze([
  {id:'live',path:API+'/health/live',status:200},
  {id:'ready',path:API+'/health/ready',status:200},
  {id:'pilotsPrivate',path:API+'/guest/pilots',status:401},
  {id:'safetyPrivate',path:API+'/guest/pilots/'+PILOT+'/safety',status:401},
  {id:'incidentPrivate',path:API+'/guest/pilots/'+PILOT+'/safety/export.json',status:401}
]);

export function assertMonitorOrigin(base){
  if(base!==LOCAL && base!==PUBLIC)throw new TypeError('Monitoring restricted to the R14 loopback or canonical public HTTPS origin');
  return base;
}
function validResponse(spec,json,expectedWrites){
  if(spec.id==='live')return json?.status==='live';
  if(spec.id==='ready')return json?.status==='ready'&&json.database==='ok'&&
    json.schemaVersion===SCHEMA&&json.leastPrivilege===true&&
    json.forcedRls===true&&json.guestWritesEnabled===expectedWrites;
  return typeof json?.error==='string'&&json.error.length>0;
}
export async function inspectAvailability({base=LOCAL,fetcher=fetch,expectedWrites=false}={}){
  assertMonitorOrigin(base);
  if(typeof expectedWrites!=='boolean')throw new TypeError('expectedWrites must be explicit boolean');
  const observations={};
  for(const spec of PROBES){
    let status=null,ok=false;
    try{
      const res=await fetcher(base+spec.path,{
        method:'GET',redirect:'error',cache:'no-store',
        headers:{Accept:'application/json'},
        signal:AbortSignal.timeout(6000)
      });
      status=res.status;
      if(status===spec.status &&
         (res.headers?.get('content-type')||'').includes('application/json')){
        const json=await res.json();
        ok=validResponse(spec,json,expectedWrites)===true;
      }
    }catch{
      // Avoid exception bodies, URLs, cookies or database details in exported telemetry.
    }
    observations[spec.id]={ok,status};
  }
  const live=observations.live.ok;
  const ready=observations.ready.ok;
  const privacy=PROBES.filter(x=>x.id!=='live'&&x.id!=='ready')
    .every(x=>observations[x.id].ok);
  const status=!live?'down':!ready||!privacy?'degraded':'healthy';
  return {
    schema:'osmanx.guest.r14.monitor.v1',target:base,
    status,apiReachable:live,ready,unauthorizedAccessDenied:privacy,
    guestWritesExpected:expectedWrites,observations,
    customerGoDecision:false
  };
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  const mode=process.argv[2]||'--local';
  if(!['--local','--public'].includes(mode)||process.argv.length>3)
    throw Error('Usage: node scripts/r14-monitor.mjs [--local|--public]');
  const report=await inspectAvailability({base:mode==='--public'?PUBLIC:LOCAL});
  process.stdout.write(JSON.stringify(report)+'\n');
  if(report.status!=='healthy')process.exitCode=2;
}
