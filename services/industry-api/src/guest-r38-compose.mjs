/**
 * R38 verifies the RESOLVED docker compose JSON, not only source YAML.
 * Secrets may exist in input; no input/secret values in output/errors.
 */
import {createHash} from 'node:crypto';
export const R38_COMPOSE_SCHEMA='osmanx.guest.r38.resolved-canary-policy.v1';
const SHA=/^[a-f0-9]{40}$/;
const SERVICES=['api','db','provision','migrate','bootstrap'];
const sha=x=>createHash('sha256').update(x).digest('hex');
const names=o=>o&&typeof o==='object'&&!Array.isArray(o)?Object.keys(o).sort():[];
const oneNetwork=(service)=>{const n=names(service?.networks);return n.length===1&&n[0]==='r14_private'};
function portsOff(s){const ports=s?.ports;return ports===undefined||Array.isArray(ports)&&ports.length===0}
function forbiddenSecurity(s){
  return s?.privileged===true||s?.network_mode==='host'||
    s?.pid==='host'||s?.ipc==='host'||
    Boolean(s?.devices?.length)||Boolean(s?.cap_add?.length)||
    s?.userns_mode==='host'||s?.cgroup==='host';
}
export function evaluateR38ComposePolicy({config,expectedCommit}={}){
  const issues=[];
  if(!SHA.test(expectedCommit||''))issues.push('SOURCE_SHA_NOT_PINNED');
  if(!config||typeof config!=='object'||Array.isArray(config)||
    config.name!=='osmanx-guest-r14-canary')
    issues.push('PROJECT_NAME_MISMATCH');
  const services=config?.services;
  if(names(services).join('|')!==[...SERVICES].sort().join('|'))
    issues.push('EXTRA_OR_MISSING_SERVICES');
  for(const serviceName of SERVICES){
    const s=services?.[serviceName];
    if(!s||typeof s!=='object'||Array.isArray(s)){
      issues.push('MISSING_SERVICE_'+serviceName);continue;
    }
    if(!oneNetwork(s)||forbiddenSecurity(s))
      issues.push('UNSAFE_SERVICE_ISOLATION_'+serviceName);
    if(serviceName!=='api'&&!portsOff(s))
      issues.push('UNEXPECTED_PORT_'+serviceName);
    if(!Array.isArray(s.security_opt)||
      !s.security_opt.some(v=>v==='no-new-privileges:true'))
      issues.push('NO_NEW_PRIVILEGES_MISSING_'+serviceName);
    if(['migrate','bootstrap'].includes(serviceName)&&
      !(s.read_only===true&&Array.isArray(s.profiles)&&
        s.profiles.includes('setup')))
      issues.push('MIGRATION_BOOTSTRAP_NOT_EPHEMERAL_'+serviceName);
    if(['migrate','bootstrap','provision'].includes(serviceName)&&
      !(Array.isArray(s.profiles)&&s.profiles.includes('setup')))
      issues.push('SETUP_PROFILE_MISSING_'+serviceName);
  }
  const api=services?.api, db=services?.db;
  const port=Array.isArray(api?.ports)?api.ports:[];
  if(port.length!==1||
    Number(port[0]?.target)!==3047||
    String(port[0]?.published)!=='3150'||
    port[0]?.host_ip!=='127.0.0.1'||
    (port[0]?.protocol||'tcp')!=='tcp')
    issues.push('API_PUBLIC_OR_UNEXPECTED_PORT');
  if(api?.environment?.GUEST_WRITES_ENABLED!=='false'||
    api?.environment?.OSMANX_SOURCE_SHA!==expectedCommit)
    issues.push('GUEST_WRITE_OR_COMMIT_ENV_MISMATCH');
  if(api?.build?.args?.OSMANX_SOURCE_SHA!==expectedCommit)
    issues.push('SOURCE_BUILD_ARG_MISMATCH');
  if(api?.read_only!==true||
    api?.init!==true||
    !Array.isArray(api?.tmpfs)||!api.tmpfs.some(t=>
      typeof t==='string'&&t.startsWith('/tmp')))
    issues.push('API_FILESYSTEM_NOT_READONLY');
  if(db?.environment?.POSTGRES_DB!=='guest_r14_canary'||
    db?.image!=='postgres:16')
    issues.push('DATABASE_IDENTITY_MISMATCH');
  if(!Array.isArray(db?.volumes)||db.volumes.length!==1||
    db.volumes[0]?.target!=='/var/lib/postgresql/data'||
    db.volumes[0]?.type!=='volume')
    issues.push('DATABASE_VOLUME_CHANGED');
  const network=config?.networks?.r14_private;
  if(names(config?.networks).join('|')!=='r14_private'||
    network?.driver!=='bridge'||network?.external===true)
    issues.push('NETWORK_NOT_PRIVATE_BRIDGE');
  const vols=config?.volumes;
  if(names(vols).join('|')!=='guest_r14_data'||
    vols?.guest_r14_data?.external===true)
    issues.push('CANARY_VOLUME_UNSAFE');
  const result={schema:R38_COMPOSE_SCHEMA,
    valid:issues.length===0,
    blockers:[...new Set(issues)],
    projectName:'osmanx-guest-r14-canary',
    sourceCommit:SHA.test(expectedCommit||'')?expectedCommit:null,
    serviceCount:names(services).length,
    loopbackApiPortExpected:'127.0.0.1:3150:3047',
    resolvedSecretsReturned:false,
    guestWritesAllowed:false,
    dockerMutationPerformed:false};
  return {...result,sha256:sha(JSON.stringify(result))};
}
export function evaluateR38LocalDockerEndpoint({context,endpoint,uid}={}){
  const okay=context==='default'&&typeof endpoint==='string'&&
    (endpoint==='unix:///var/run/docker.sock'||
      endpoint==='unix:///run/docker.sock'||
      Number.isSafeInteger(uid)&&endpoint===
        'unix:///run/user/'+uid+'/docker.sock');
  return {valid:Boolean(okay),reason:okay?null:'REMOTE_OR_UNTRUSTED_DOCKER_DAEMON',
    remoteDockerAllowed:false};
}
