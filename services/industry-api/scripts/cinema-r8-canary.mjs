// CINEMA R8: zero-customer-data staging canary; rejects remote endpoints and unsafe flags.
import {canaryTarget,cinemaR7Canary} from './cinema-r7-canary.mjs';
export async function cinemaR8Canary({origin='http://127.0.0.1:3149',fetcher=fetch}={}){
  const base=canaryTarget(origin)+'/api/industry/v1';
  const previous=await cinemaR7Canary({origin,fetcher});
  const get=async(path)=>{
    const response=await fetcher(base+path,{method:'GET',headers:{accept:'application/json'},
      redirect:'error',signal:AbortSignal.timeout(8000)});
    let data={};try{data=await response.json();}catch{}
    return {status:response.status,data};
  };
  const runtime=await get('/cinema/public/runtime');
  if(runtime.status!==200||runtime.data.apiRelease!=='r8'||
     runtime.data.onlineIntakeEnabled!==false||
     runtime.data.aggregateActionsEnabled!==false||
     runtime.data.capabilities?.ownerCsvApproval!==true)
    throw Error('NO-GO: R8 release/capabilities missing or public collection not disabled');
  const operator=await get('/cinema/ops/preflight');
  if(operator.status!==401)throw Error('NO-GO: anonymous access to operator preflight');
  const exportGuard=await get('/cinema/exports/approve');
  // The endpoint is POST-only and GET must not expose anything.
  if(![401,404,405].includes(exportGuard.status))
    throw Error('NO-GO: public export authorization exposed via GET');
  return {safe:true,apiRelease:'r8',previous:previous.checks,
    checks:{publicRuntime:true,collectionDisabled:true,ownerOpsDenied:true,bulkExportNotExposed:true},
    note:'Local staging check, no real customer data; cannot prove DNS/TLS/controller readiness.'};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  try{
    const result=await cinemaR8Canary({origin:process.env.CINEMA_R8_STAGING_URL});
    console.log(JSON.stringify(result));
  }catch(e){console.error('CINEMA R8 STAGING NO-GO: '+e.message);process.exitCode=2;}
}
