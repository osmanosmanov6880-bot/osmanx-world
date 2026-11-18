/**
 * R10 operator readiness for ISOLATED staging only. No cookies, passwords, POST or files.
 * A successful technical result NEVER enables payments or live customer collection.
 */
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const STAGE_ORIGIN='http://127.0.0.1:3149';
export const R10_SCHEMA='011_guest_pilot_safety.sql';
const PILOT='00000000-0000-4000-8000-000000000000';
const API='/api/industry/v1';
export const CHECKS=Object.freeze([
  {key:'live',url:API+'/health/live',status:200},
  {key:'ready',url:API+'/health/ready',status:200},
  {key:'privatePilots',url:API+'/guest/pilots',status:401},
  {key:'privateEvidence',url:API+'/guest/pilots/'+PILOT+'/evidence.json',status:401},
  {key:'privateDiagnostics',url:API+'/guest/pilots/'+PILOT+'/diagnostics',status:401},
  {key:'privateActions',url:API+'/guest/pilots/'+PILOT+'/actions',status:401},
  {key:'privateImports',url:API+'/guest/pilots/'+PILOT+'/observations/imports',status:401}
]);
export async function inspectStage(base=STAGE_ORIGIN,fetcher=fetch){
  if(base!==STAGE_ORIGIN)throw new TypeError('R10 stage gate restricted to 127.0.0.1:3149');
  const observations={};
  for(const item of CHECKS){
    try{
      const r=await fetcher(base+item.url,{method:'GET',cache:'no-store',
        redirect:'error',headers:{Accept:'application/json'},signal:AbortSignal.timeout(6000)});
      let safe=r.status===item.status;
      if(safe){
        if(!(r.headers?.get('content-type')||'').includes('application/json'))safe=false;
        else{
          const json=await r.json();
          if(item.key==='live')safe=json?.status==='live';
          else if(item.key==='ready')safe=json?.status==='ready'&&
            json?.schemaVersion===R10_SCHEMA&&json?.database==='ok'&&
            json?.forcedRls===true&&json?.leastPrivilege===true&&
            json?.guestWritesEnabled===false;
          else safe=typeof json?.error==='string'&&json.error.length>0;
        }
      }
      observations[item.key]={ok:safe,status:r.status};
    }catch{
      observations[item.key]={ok:false,status:null};
    }
  }
  const staged=CHECKS.every(c=>observations[c.key].ok);
  return {schema:'osmanx.guest.r10.staging.gate.v1',
    origin:STAGE_ORIGIN,technicalStageReady:staged,readyForCustomerData:false,
    version:R10_SCHEMA,observations,
    next:staged?
      'Схема и защищённые маршруты staging подтверждены. Нужны две рабочие учётные записи, подтверждённые резервные ключи и административное решение о запуске.':
      'NO-GO: изолированный staging не прошёл технические проверки. Не подключайте клиентские данные.'};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  const mode=process.argv[2]||'--report';
  if(!['--report','--require-ready'].includes(mode))
    throw Error('Usage: node scripts/r10-stage-gate.mjs [--report|--require-ready]');
  const result=await inspectStage();
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(mode==='--require-ready'&&!result.technicalStageReady)process.exitCode=2;
}
