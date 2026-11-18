/**
 * Guest R5 read-only public smoke: no login, no writes, no secrets and no extra hosts.
 * It differentiates "static published" from "real API is accessible and secured".
 */
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const PROD_BASE='https://osmanx.world';
const checks=Object.freeze([
  {key:'staticConsole',path:'/assets/guest/console.html',expect:200,marker:'Закрытый кабинет'},
  {key:'staffJoin',path:'/assets/guest/join.html',expect:200,marker:'Приглашение сотрудника'},
  {key:'apiLive',path:'/api/industry/v1/health/live',expect:200,jsonField:'live'},
  {key:'apiReady',path:'/api/industry/v1/health/ready',expect:200,jsonField:'ready'},
  {key:'privateBlocked',path:'/api/industry/v1/guest/pilots',expect:401,jsonError:true},
  {key:'r5EvidenceProtected',path:'/api/industry/v1/guest/pilots/00000000-0000-4000-8000-000000000000/evidence.json',expect:401,jsonError:true}
]);
export async function inspect(base=PROD_BASE,fetcher=fetch){
  const url=new URL(base);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
     !(['https:','http:'].includes(url.protocol))||url.origin!==base)
    throw new TypeError('Base must be a bare origin without credentials');
  const observations={};
  for(const spec of checks){
    try{
      const res=await fetcher(url.origin+spec.path,{
        method:'GET',cache:'no-store',redirect:'error',
        headers:{Accept:spec.key==='staticConsole'||spec.key==='staffJoin'?'text/html':'application/json'},
        signal:AbortSignal.timeout(8000)
      });
      const type=res.headers?.get('content-type')||'';
      let ok=res.status===spec.expect;
      if(ok&&spec.marker){
        ok=type.includes('text/html')&&(await res.text()).includes(spec.marker);
      }else if(ok&&(spec.jsonField||spec.jsonError)){
        if(!type.includes('application/json'))ok=false;
        else{
          const data=await res.json();
          ok=spec.jsonField?data.status===spec.jsonField:typeof data.error==='string';
        }
      }
      observations[spec.key]={ok,status:res.status};
    }catch{
      observations[spec.key]={ok:false,status:null};
    }
  }
  const staticReady=observations.staticConsole.ok&&observations.staffJoin.ok;
  const apiReady=observations.apiLive.ok&&observations.apiReady.ok&&observations.privateBlocked.ok&&observations.r5EvidenceProtected.ok;
  return {schema:'osmanx.guest.r5.readiness.v1',base:url.origin,
    staticReady,apiReady,observations,
    interpretation:apiReady?'Публичный API доступен и закрытые данные требуют входа. Двухсотрудниковый пилот ещё нужно проверить отдельно.':
      'Защищённый API НЕ готов к приёму клиентских данных. Нельзя утверждать, что backend развёрнут.'};
}
function publicBase(){
  const candidate=process.env.GUEST_R5_TEST_BASE;
  if(candidate && process.env.NODE_ENV==='test'){
    if(!/^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/.test(candidate))
      throw Error('Test base can only be loopback');
    return candidate;
  }
  return PROD_BASE;
}
const direct=process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  const mode=process.argv[2]||'--report';
  if(!['--report','--require-api'].includes(mode))throw Error('Use --report or --require-api');
  const report=await inspect(publicBase());
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  if(!report.staticReady || (mode==='--require-api'&&!report.apiReady))process.exitCode=2;
}
