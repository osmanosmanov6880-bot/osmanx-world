// CINEMA R9: local-only staging canary with no PII and zero successful writes.
import {canaryTarget} from './cinema-r7-canary.mjs';
import {cinemaR8Canary} from './cinema-r8-canary.mjs';
export async function cinemaR9Canary({origin='http://127.0.0.1:3149',fetcher=fetch}={}){
  const base=canaryTarget(origin)+'/api/industry/v1';
  const old=await cinemaR8Canary({origin,fetcher});
  const probe=async(path,method='GET')=>{
    const resp=await fetcher(base+path,{method,
      headers:{Accept:'application/json',...(method==='POST'?{'Content-Type':'application/json'}:{})},
      ...(method==='POST'?{body:'{}'}:{}),redirect:'error',signal:AbortSignal.timeout(8000)});
    let json={};try{json=await resp.json();}catch{}
    return {status:resp.status,json};
  };
  const runtime=await probe('/cinema/public/r9-runtime');
  if(runtime.status!==200||runtime.json.apiRelease!=='r9'||
     runtime.json.capabilities?.serverCsvSnapshot!==true||
     runtime.json.onlineIntakeEnabled!==false||
     runtime.json.aggregateActionsEnabled!==false)
    throw Error('NO-GO: R9 snapshot contract missing or public intake enabled');
  const report=await probe('/cinema/ops/response-review?days=7');
  if(report.status!==401)throw Error('NO-GO: anonymous contact report must be denied');
  const csv=await probe('/cinema/exports/csv','POST');
  if(csv.status!==401)throw Error('NO-GO: anonymous CSV request must be denied');
  const unsafeGet=await probe('/cinema/exports/csv');
  if(![404,405].includes(unsafeGet.status))
    throw Error('NO-GO: CSV data exposed on a GET route');
  return {safe:true,release:'r9',prior:old.checks,
    checks:{runtimePinned:true,intakeDisabled:true,anonymousReportDenied:true,
      anonymousCsvDenied:true,readOnlyDownloadUnavailable:true},
    note:'Only local loopback staging, no customer PII, no proof of external TLS or legal approval.'};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  try{
    const result=await cinemaR9Canary({origin:process.env.CINEMA_R9_STAGING_URL});
    console.log(JSON.stringify(result));
  }catch(e){console.error('CINEMA R9 STAGING NO-GO: '+e.message);process.exitCode=2;}
}
