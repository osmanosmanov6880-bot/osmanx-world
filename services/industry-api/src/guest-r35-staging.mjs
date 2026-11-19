/**
 * Strongly pinned, operator-approved R35 staging probe.
 * Never resolves an arbitrary hostname or substitutes production for staging.
 * Requires the operator to supply an independently checked public IP and
 * certificate fingerprint BEFORE doing network I/O. CI uses fake adapters.
 */
import {createHash} from 'node:crypto';
import {PROBES} from '../scripts/r14-monitor.mjs';
import {publicIpv4,observeR34Staging}
  from './guest-r34-host-evidence.mjs';
import {R34_PIN} from './guest-r35-source.mjs';
export const R35_STAGING_SCHEMA='osmanx.guest.r35.pinned-staging-operator.v1';
const HOST='staging.osmanx.world';
const SHA=/^[a-f0-9]{64}$/;
const TREE=/^[a-f0-9]{40}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEYS=['schema','environment','origin','releaseSha','sourceTreeSha',
  'pilotId','approvedIpv4','approvedCertSha256','operatorNonce',
  'issuedAt','expiresAt','allowWrites'];
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===k.slice().sort().join('|');
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&
  new Date(Date.parse(v)).toISOString()===v;
export function verifyR35StagingProfile(profile,{now=new Date()}={}){
  const blockers=[];
  if(!exact(profile,KEYS)||profile?.schema!==R35_STAGING_SCHEMA||
    profile?.environment!=='staging'||
    profile?.origin!=='https://'+HOST||
    profile?.releaseSha!==R34_PIN.sha||
    !TREE.test(profile?.sourceTreeSha||'')||
    !UUID.test(profile?.pilotId||'')||
    !publicIpv4(profile?.approvedIpv4)||
    !SHA.test(profile?.approvedCertSha256||'')||
    !/^[a-f0-9]{32}$/.test(profile?.operatorNonce||'')||
    profile?.allowWrites!==false||
    !time(profile?.issuedAt)||!time(profile?.expiresAt))
    blockers.push('INVALID_PINNED_PROFILE');
  const start=Date.parse(profile?.issuedAt),
    end=Date.parse(profile?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(start)||!Number.isFinite(end)||
    start>now.getTime()||now.getTime()>=end||end<=start||
    end-start>10*60000)
    blockers.push('PINNED_PROFILE_EXPIRED');
  return {valid:blockers.length===0,blockers:[...new Set(blockers)]};
}
export async function runR35PinnedStaging({profile,approved=false,
  resolveIpv4,inspectTls,fetchStatus,clock=()=>new Date(),
  delay=()=>Promise.reject(Error('Real delay required'))}={}){
  // Zero adapter invocations before validating the complete profile.
  if(approved!==true||
    !verifyR35StagingProfile(profile,{now:clock()}).valid)
    throw Error('Explicit staging approval and current IP/cert pin required');
  if(typeof resolveIpv4!=='function'||typeof inspectTls!=='function'||
    typeof fetchStatus!=='function'||typeof delay!=='function')
    throw TypeError('Network adapters must be supplied explicitly');
  const safeResolve=async host=>{
    if(host!==HOST)throw Error('Unexpected staging hostname');
    const ips=await resolveIpv4(host);
    if(!Array.isArray(ips)||ips.length!==1||
      ips[0]!==profile.approvedIpv4||
      !publicIpv4(ips[0]))
      throw Error('DNS does not match sole operator-approved public IPv4');
    return ips;
  };
  const safeTls=async ({host,ip})=>{
    if(host!==HOST||ip!==profile.approvedIpv4)
      throw Error('TLS host or pinned address mismatch');
    const cert=await inspectTls({host,ip});
    if(cert?.authorized!==true||cert?.serverName!==HOST||
      cert?.sha256!==profile.approvedCertSha256)
      throw Error('Staging cert changed or is not trusted');
    return cert;
  };
  const allowed=new Set(PROBES.map(x=>x.path));
  const safeStatus=async ({host,ip,path,method})=>{
    if(host!==HOST||ip!==profile.approvedIpv4||method!=='GET'||
      !allowed.has(path))
      throw Error('Unapproved staging network request');
    return fetchStatus({host,ip,path,method});
  };
  const result=await observeR34Staging({
    approved:true,pilotId:profile.pilotId,
    sourceTreeSha:profile.sourceTreeSha,
    resolveIpv4:safeResolve,inspectTls:safeTls,
    fetchStatus:safeStatus,clock,delay
  });
  if(!verifyR35StagingProfile(profile,{now:clock()}).valid)
    throw Error('Approval expired during observation');
  if(!result.review.locallyObservedHealthy)
    throw Error('Staging status or privacy parity failed');
  return {schema:'osmanx.guest.r35.pinned-staging-review.v1',
    profileSha256:hash(profile),observationSha256:result.record.sha256,
    issuedAt:profile.issuedAt,expiresAt:profile.expiresAt,
    observations:10,pilotId:profile.pilotId,
    releaseSha:R34_PIN.sha,sourceTreeSha:profile.sourceTreeSha,
    operatorExecuted:true,independentWitnessVerified:false,
    dnsAndTlsPinned:true,realHostOwnershipIndependentlyVerified:false,
    productionAuthorized:false,customerGo:false,stopLifted:false};
}
