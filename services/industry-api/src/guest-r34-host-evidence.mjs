/**
 * R34 operator-run staging observer and fail-closed evidence verifier.
 * This data is locally observed, not independently attested. No user tokens,
 * customer data, remote writes, redirects or production hostname.
 */
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {PROBES} from '../scripts/r14-monitor.mjs';
import {R33_PIN} from './guest-r34-source.mjs';
export const R34_HOST_SCHEMA='osmanx.guest.r34.operator-staging-observation.v1';
export const R34_HOST='staging.osmanx.world';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const SHA40=/^[a-f0-9]{40}$/;
const fields=['schema','pilotId','releaseSha','sourceTreeSha','origin','source',
  'dnsDigest','tlsCertSha256','samples','issuedAt','expiresAt',
  'requestHadCredentials','responseBodiesStored','productionTouched'];
const sampleFields=['observedAt','observations'];
const obsFields=['probe','status','method'];
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===k.slice().sort().join('|');
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&
  new Date(Date.parse(v)).toISOString()===v;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function publicIpv4(ip){
  if(isIP(ip)!==4)return false;
  const [a,b,c,d]=ip.split('.').map(Number);
  if(a===0||a===10||a===127||a>=224||a===169&&b===254||
    a===172&&b>=16&&b<=31||a===192&&b===168||
    a===100&&b>=64&&b<=127||a===198&&(b===18||b===19)||
    a===192&&b===0&&c===0||
    a===192&&b===0&&c===2||a===198&&b===51&&c===100||
    a===203&&b===0&&c===113||a===255||d>255)return false;
  return true;
}
export function reviewR34HostEvidence(record,{pilotId,sourceTreeSha,
  now=new Date()}={}){
  const errors=[];
  if(!exact(record,[...fields,'sha256'])||
    record?.schema!==R34_HOST_SCHEMA||
    !UUID.test(record?.pilotId||'')||
    record?.releaseSha!==R33_PIN.sha||
    !SHA40.test(record?.sourceTreeSha||'')||
    record?.origin!=='https://'+R34_HOST||
    record?.source!=='operator-executed-unwitnessed'||
    !SHA.test(record?.dnsDigest||'')||
    !SHA.test(record?.tlsCertSha256||'')||
    record?.requestHadCredentials!==false||
    record?.responseBodiesStored!==false||
    record?.productionTouched!==false||
    !time(record?.issuedAt)||!time(record?.expiresAt)||
    !SHA.test(record?.sha256||''))
    errors.push('INVALID_HOST_PACKET');
  if(pilotId!==undefined&&record?.pilotId!==pilotId)
    errors.push('WRONG_PILOT');
  if(sourceTreeSha!==undefined&&record?.sourceTreeSha!==sourceTreeSha)
    errors.push('WRONG_GIT_TREE');
  const issued=Date.parse(record?.issuedAt),expires=Date.parse(record?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(issued)||!Number.isFinite(expires)||
    issued>now.getTime()||now.getTime()>=expires||
    expires<=issued||expires-issued>10*60000)
    errors.push('EXPIRED_OR_INVALID_CLOCK');
  if(!Array.isArray(record?.samples)||record.samples.length!==2)
    errors.push('REQUIRE_TWO_OBSERVATIONS');
  const times=[];
  for(const sample of Array.isArray(record?.samples)?record.samples.slice(0,3):[]){
    if(!exact(sample,sampleFields)||!time(sample.observedAt)||
      !Array.isArray(sample.observations)||sample.observations.length!==5){
      errors.push('MALFORMED_STAGING_SAMPLE');continue;
    }
    const at=Date.parse(sample.observedAt);
    times.push(at);
    if(at<issued||at>now.getTime()||at>=expires)
      errors.push('SAMPLE_OUTSIDE_WINDOW');
    for(let i=0;i<PROBES.length;i++){
      const row=sample.observations[i],spec=PROBES[i];
      if(!exact(row,obsFields)||row.probe!==spec.id||
        row.method!=='GET'||row.status!==spec.status)
        errors.push('PRIVACY_OR_AVAILABILITY_REGRESSION');
    }
  }
  if(times.length!==2||times[1]-times[0]<30000||
    times[1]-times[0]>10*60000)
    errors.push('SAMPLE_SPACING_INVALID');
  if(exact(record,[...fields,'sha256'])){
    const {sha256,...body}=record;
    if(hash(body)!==sha256)errors.push('TAMPERED_HOST_EVIDENCE');
  }
  return {schema:'osmanx.guest.r34.host-verification.v1',
    locallyObservedHealthy:errors.length===0,
    independentHostWitnessVerified:false,
    independentCertChainWitnessVerified:false,
    productionAuthorized:false,customerGo:false,
    blockers:[...new Set(errors)]};
}
export async function observeR34Staging({
  approved=false,pilotId,sourceTreeSha,resolveIpv4,inspectTls,fetchStatus,
  clock=()=>new Date(),delay=()=>Promise.reject(Error('delay not supplied'))
}={}){
  if(approved!==true||!UUID.test(pilotId||'')||
    !SHA40.test(sourceTreeSha||'')||
    typeof resolveIpv4!=='function'||typeof inspectTls!=='function'||
    typeof fetchStatus!=='function'||typeof delay!=='function')
    throw new TypeError('Explicit staging approval and network adapters required');
  const ips=await resolveIpv4(R34_HOST);
  if(!Array.isArray(ips)||ips.length<1||ips.length>4||
    ips.some(ip=>!publicIpv4(ip))||
    new Set(ips).size!==ips.length)
    throw Error('Unsafe, private or unstable staging DNS response');
  const ip=ips[0],dnsDigest=hash(ips.slice().sort());
  const cert=await inspectTls({host:R34_HOST,ip});
  if(cert?.authorized!==true||cert?.serverName!==R34_HOST||
    !SHA.test(cert?.sha256||''))
    throw Error('Untrusted staging TLS certificate');
  const sample=async()=>{
    const observedAt=clock().toISOString(),observations=[];
    for(const spec of PROBES){
      let code=599;
      try{
        code=await fetchStatus({host:R34_HOST,ip,path:spec.path,
          method:'GET'});
      }catch{code=599;}
      observations.push({probe:spec.id,status:code,method:'GET'});
    }
    return {observedAt,observations};
  };
  const issuedAt=clock().toISOString(),first=await sample();
  await delay(30000);
  const secondDns=await resolveIpv4(R34_HOST);
  if(!Array.isArray(secondDns)||
    hash(secondDns.slice().sort())!==dnsDigest)
    throw Error('Staging DNS changed between samples');
  const secondCert=await inspectTls({host:R34_HOST,ip});
  if(secondCert?.authorized!==true||secondCert?.serverName!==R34_HOST||
    secondCert?.sha256!==cert.sha256)
    throw Error('Staging certificate changed between samples');
  const second=await sample();
  const body={schema:R34_HOST_SCHEMA,pilotId,releaseSha:R33_PIN.sha,
    sourceTreeSha,origin:'https://'+R34_HOST,
    source:'operator-executed-unwitnessed',
    dnsDigest,tlsCertSha256:cert.sha256,samples:[first,second],
    issuedAt,expiresAt:new Date(Date.parse(issuedAt)+600000).toISOString(),
    requestHadCredentials:false,responseBodiesStored:false,
    productionTouched:false};
  const record={...body,sha256:hash(body)};
  const review=reviewR34HostEvidence(record,{
    pilotId,sourceTreeSha,now:clock()});
  return {record,review,networkExecuted:true,
    independentlyWitnessed:false,productionAuthorized:false};
}
