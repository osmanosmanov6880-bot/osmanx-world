/**
 * R10 read-only live readiness: static deploy != Industry API != customer acceptance.
 * Performs only bounded anonymous GETs, no cookies, no secret headers, no redirects.
 */
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const PROD_BASE='https://osmanx.world';
export const EXPECTED_SCHEMA='010_guest_launch_gate.sql';
const PILOT='00000000-0000-4000-8000-000000000000';
export const CHECKS=Object.freeze([
  {key:'staticConsole',path:'/assets/guest/console.html',expect:200,marker:'Guest Intelligence / R11 / Защищённый кабинет'},
  {key:'staffJoin',path:'/assets/guest/join.html',expect:200,marker:'Приглашение сотрудника'},
  {key:'apiLive',path:'/api/industry/v1/health/live',expect:200,kind:'live'},
  {key:'apiReady',path:'/api/industry/v1/health/ready',expect:200,kind:'ready'},
  {key:'pilotsProtected',path:'/api/industry/v1/guest/pilots',expect:401,kind:'protected'},
  {key:'evidenceProtected',path:'/api/industry/v1/guest/pilots/'+PILOT+'/evidence.json',expect:401,kind:'protected'},
  {key:'diagnosticsProtected',path:'/api/industry/v1/guest/pilots/'+PILOT+'/diagnostics',expect:401,kind:'protected'},
  {key:'actionsProtected',path:'/api/industry/v1/guest/pilots/'+PILOT+'/actions',expect:401,kind:'protected'},
  {key:'importsProtected',path:'/api/industry/v1/guest/pilots/'+PILOT+'/observations/imports',expect:401,kind:'protected'}
]);
export function assertProbeOrigin(base){
  if(typeof base!=='string')throw new TypeError('Base must be a string');
  const url=new URL(base);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
     url.origin!==base || !(base===PROD_BASE||/^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/.test(base)))
    throw new TypeError('Base must be the production origin or isolated test loopback');
  return url.origin;
}
export async function inspect(base=PROD_BASE,fetcher=fetch){
  const origin=assertProbeOrigin(base),observations={};
  for(const spec of CHECKS){
    try{
      const res=await fetcher(origin+spec.path,{
        method:'GET',cache:'no-store',redirect:'error',
        headers:{Accept:spec.marker?'text/html':'application/json'},
        signal:AbortSignal.timeout(8000)
      });
      const type=res.headers?.get('content-type')||'';
      let ok=res.status===spec.expect;
      if(ok&&spec.marker){
        ok=type.includes('text/html')&&(await res.text()).includes(spec.marker);
      }else if(ok&&spec.kind){
        if(!type.includes('application/json'))ok=false;
        else{
          const body=await res.json();
          if(spec.kind==='live')ok=body?.status==='live';
          else if(spec.kind==='ready')ok=body?.status==='ready'&&
            body?.schemaVersion===EXPECTED_SCHEMA&&body?.database==='ok'&&
            body?.leastPrivilege===true&&body?.forcedRls===true&&
            typeof body?.guestWritesEnabled==='boolean';
          else ok=typeof body?.error==='string'&&body.error.length>0;
        }
      }
      observations[spec.key]={ok,status:res.status};
    }catch{
      observations[spec.key]={ok:false,status:null};
    }
  }
  const staticReady=observations.staticConsole.ok&&observations.staffJoin.ok;
  const apiReady=CHECKS.filter(spec=>!spec.marker).every(spec=>observations[spec.key].ok);
  return {schema:'osmanx.guest.r10.readiness.v1',base:origin,
    expectedSchemaVersion:EXPECTED_SCHEMA,staticReady,apiReady,observations,
    interpretation:apiReady?
      'API R9 доступен с применённой схемой, RLS и ограниченными правами. Отдельно нужны вход двух сотрудников, тест резервного восстановления и разрешение оператора на запись.':
      'Защищённый API R9 НЕ подтверждён. Статика сама по себе не даёт разрешения собирать клиентские данные.'};
}
function publicBase(){
  const candidate=process.env.GUEST_R10_TEST_BASE||process.env.GUEST_R5_TEST_BASE;
  if(candidate){
    if(process.env.NODE_ENV!=='test')throw Error('Test loopback override forbidden outside NODE_ENV=test');
    assertProbeOrigin(candidate);
    if(candidate===PROD_BASE)throw Error('Test override cannot claim production');
    return candidate;
  }
  return PROD_BASE;
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  const mode=process.argv[2]||'--report';
  if(!['--report','--require-api'].includes(mode))throw Error('Use --report or --require-api');
  const report=await inspect(publicBase());
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  if(!report.staticReady||(mode==='--require-api'&&!report.apiReady))process.exitCode=2;
}
