// CINEMA R7 fail-closed loopback-only API canary; NEVER sends personal information.
const fail=(message)=>Object.assign(new Error(message),{statusCode:2});
export function canaryTarget(value='http://127.0.0.1:3149'){
  let u;
  try{u=new URL(value);}catch{throw fail('Invalid staging API address');}
  if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||
     u.username||u.password||u.pathname!=='/'||u.search||u.hash)
    throw fail('Only an explicit loopback HTTP staging endpoint is accepted');
  return u.origin;
}
async function read(url,method='GET',fetcher=fetch){
  const response=await fetcher(url,{method,
    headers:{'accept':'application/json',...(method==='POST'?{'content-type':'application/json'}:{})},
    ...(method==='POST'?{body:'{}'}:{}),redirect:'error',signal:AbortSignal.timeout(8000)});
  let payload={};
  try{payload=await response.json();}catch{}
  return {status:response.status,payload};
}
export async function cinemaR7Canary({origin='http://127.0.0.1:3149',fetcher=fetch}={}){
  const base=canaryTarget(origin)+'/api/industry/v1';
  const live=await read(base+'/health/live','GET',fetcher);
  const config=await read(base+'/cinema/public/config','GET',fetcher);
  // Critical: never submit even a synthetic lead if the server says public collection is enabled.
  if(config.status!==200 || config.payload.intakeEnabled!==false||
     config.payload.aggregateEventsEnabled!==false)throw fail('NO-GO: public intake/telemetry is not disabled');
  const privateRoutes=[
    '/cinema/queue',
    '/cinema/team/workload',
    '/cinema/leads/00000000-0000-4000-8000-000000000001/audit-integrity',
    '/cinema/privacy/access-log'
  ];
  const states=[];
  for(const route of privateRoutes){
    const response=await read(base+route,'GET',fetcher);
    states.push({route,status:response.status});
    if(response.status!==401)throw fail('Protected route did not reject anonymous client: '+route);
  }
  const write=await read(base+'/cinema/public/leads','POST',fetcher);
  if(write.status!==503)throw fail('Public submissions are not fail-closed');
  if(live.status!==200||live.payload.status!=='live')throw fail('API is not live');
  return {safe:true,host:canaryTarget(origin),checks:{
    health:true,publicIntakeDisabled:true,aggregateTelemetryDisabled:true,
    anonymousPrivateRoutesDenied:states.length,publicWritesRejected:true},
    note:'Local read-only access test with an empty rejected request; does not prove readiness to collect personal data.'};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  try{
    const result=await cinemaR7Canary({origin:process.env.CINEMA_R7_STAGING_URL});
    console.log(JSON.stringify(result));
  }catch(e){console.error('CINEMA R7 CANARY NO-GO: '+e.message);process.exitCode=2;}
}
