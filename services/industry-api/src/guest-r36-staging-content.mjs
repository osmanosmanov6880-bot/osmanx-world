/**
 * R36 approved staging read-only semantic health/unauthorized validation.
 * No customer routes, credentials, replay writes, redirects or body persistence.
 */
import {createHash} from 'node:crypto';
import {PROBES,SCHEMA} from '../scripts/r14-monitor.mjs';
import {publicIpv4} from './guest-r34-host-evidence.mjs';
import {R35_PIN} from './guest-r36-source.mjs';
export const R36_STAGE_SCHEMA='osmanx.guest.r36.semantic-staging.v1';
const HOST='staging.osmanx.world';
const SHA=/^[a-f0-9]{64}$/;
const TREE=/^[a-f0-9]{40}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const keys=['schema','pilotId','sourceTreeSha','releaseSha',
  'origin','approvedIpv4','approvedCertSha256','issuedAt','expiresAt',
  'nonce','allowedMethods','guestWritesExpected'];
const exact=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&
  Object.keys(v).sort().join('|')===k.slice().sort().join('|');
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const isTime=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&
  new Date(Date.parse(x)).toISOString()===x;
export function validateR36StageApproval(approval,{now=new Date()}={}){
  const errors=[];
  if(!exact(approval,keys)||approval?.schema!==R36_STAGE_SCHEMA||
    !UUID.test(approval?.pilotId||'')||
    !TREE.test(approval?.sourceTreeSha||'')||
    approval?.releaseSha!==R35_PIN.sha||
    approval?.origin!=='https://'+HOST||
    !publicIpv4(approval?.approvedIpv4)||
    !SHA.test(approval?.approvedCertSha256||'')||
    !/^[a-f0-9]{32}$/.test(approval?.nonce||'')||
    !Array.isArray(approval?.allowedMethods)||
    approval.allowedMethods.length!==1||
    approval.allowedMethods[0]!=='GET'||
    approval?.guestWritesExpected!==false||
    !isTime(approval?.issuedAt)||!isTime(approval?.expiresAt))
    errors.push('INVALID_PINNED_READ_ONLY_APPROVAL');
  const issued=Date.parse(approval?.issuedAt),
    expires=Date.parse(approval?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(issued)||!Number.isFinite(expires)||
    issued>now.getTime()||now.getTime()>=expires||
    expires<=issued||expires-issued>600000)
    errors.push('EXPIRED_OR_INVALID_APPROVAL');
  return {valid:errors.length===0,blockers:[...new Set(errors)]};
}
export function validateR36SafeResponse(spec,response){
  if(!spec||!PROBES.some(p=>p.id===spec.id&&p.path===spec.path))
    return false;
  if(!response||typeof response!=='object'||
    response.status!==spec.status||
    typeof response.contentType!=='string'||
    !/^application\/json(?:;|$)/i.test(response.contentType)||
    typeof response.body!=='string'||
    Buffer.byteLength(response.body,'utf8')>4096)
    return false;
  let obj;
  try{obj=JSON.parse(response.body)}catch{return false}
  if(!obj||typeof obj!=='object'||Array.isArray(obj))return false;
  if(spec.id==='live')return obj.status==='live';
  if(spec.id==='ready')return obj.status==='ready'&&
    obj.database==='ok'&&obj.schemaVersion===SCHEMA&&
    obj.leastPrivilege===true&&obj.forcedRls===true&&
    obj.guestWritesEnabled===false;
  return typeof obj.error==='string'&&obj.error.length>0&&
    obj.error.length<=240;
}
export async function runR36SemanticStaging({approval,approved=false,
  resolveIpv4,inspectTls,fetchResponse,
  clock=()=>new Date(),delay}={}){
  // No network until the complete operator-approved envelope is checked.
  if(approved!==true||
    !validateR36StageApproval(approval,{now:clock()}).valid)
    throw Error('R36 requires approved exact staging IP/cert and current window');
  if(typeof resolveIpv4!=='function'||typeof inspectTls!=='function'||
    typeof fetchResponse!=='function'||typeof delay!=='function')
    throw TypeError('Approved read-only network adapters required');
  let firstAt=null,lastAt=null;
  const observations=[];
  const runSample=async()=>{
    if(!validateR36StageApproval(approval,{now:clock()}).valid)
      throw Error('Staging approval expired');
    const ips=await resolveIpv4(HOST);
    if(!Array.isArray(ips)||ips.length!==1||
      ips[0]!==approval.approvedIpv4)
      throw Error('DNS pin changed');
    const cert=await inspectTls({host:HOST,ip:approval.approvedIpv4});
    if(cert?.authorized!==true||cert?.serverName!==HOST||
      cert?.sha256!==approval.approvedCertSha256)
      throw Error('TLS fingerprint or hostname not trusted');
    const now=clock(),observedAt=now.toISOString(),local=[];
    for(const spec of PROBES){
      const result=await fetchResponse({
        host:HOST,ip:approval.approvedIpv4,method:'GET',
        path:spec.path,certSha256:approval.approvedCertSha256,
        maxBodyBytes:4096
      });
      if(!validateR36SafeResponse(spec,result))
        throw Error('R36 staging semantic or private-route failure: '+spec.id);
      local.push({probe:spec.id,status:result.status,valid:true});
    }
    observations.push({observedAt,checks:local});
    return now.getTime();
  };
  firstAt=await runSample();
  await delay(30000);
  lastAt=await runSample();
  if(lastAt-firstAt<30000||lastAt-firstAt>600000)
    throw Error('Two staged samples not safely separated');
  if(!validateR36StageApproval(approval,{now:clock()}).valid)
    throw Error('Staging approval expired during canary');
  const data={schema:'osmanx.guest.r36.staging-semantic-proof.v1',
    pilotId:approval.pilotId,releaseSha:R35_PIN.sha,
    sourceTreeSha:approval.sourceTreeSha,
    approvalSha256:sha(approval),
    samples:observations,GETOnly:true,totalProbes:10,
    responseBodyStored:false,stagingExecuted:true,
    realDeployedCommitVerified:false,
    independentWitnessVerified:false,
    customerGo:false,productionAuthorized:false};
  return {...data,sha256:sha(data)};
}
