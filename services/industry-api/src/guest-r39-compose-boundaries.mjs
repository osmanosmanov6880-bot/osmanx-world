/**
 * R39 rendered Compose threat model: inherited service mounts, devices,
 * capabilities and escalation. Operates on resolved config (not raw YAML).
 * Never return the config: Compose includes interpolated passwords.
 */
export const R39_COMPOSE_SCHEMA='osmanx.guest.r39.resolved-sandbox-policy.v1';
const SERVICES=['db','provision','migrate','bootstrap','api'];
const own=x=>x&&typeof x==='object'&&!Array.isArray(x);
const nonempty=v=>v!=null&&(
  Array.isArray(v)?v.length>0:
  own(v)?Object.keys(v).length>0:true
);
export function inspectR39ComposePrivileges(config,{
  expectedProvisionPath
}={}){
  const blockers=[];
  if(typeof expectedProvisionPath!=='string'||
    !expectedProvisionPath.startsWith('/')||
    expectedProvisionPath.includes('..'))
    blockers.push('TRUSTED_PROVISION_SOURCE_NOT_PINNED');
  const services=config?.services;
  if(!own(services)||Object.keys(services).sort().join(',')!==
      SERVICES.slice().sort().join(','))
    blockers.push('UNEXPECTED_COMPOSE_SERVICE_SET');
  for(const name of SERVICES){
    const svc=services?.[name];
    if(!own(svc)){blockers.push('MISSING_'+name.toUpperCase());continue}
    if(svc.privileged===true||
      nonempty(svc.cap_add)||nonempty(svc.devices)||
      nonempty(svc.volumes_from)||nonempty(svc.extra_hosts)||
      nonempty(svc.sysctls)||nonempty(svc.external_links)||
      nonempty(svc.links)||nonempty(svc.dns)||
      svc.container_name!=null||
      !Array.isArray(svc.security_opt)||
      !svc.security_opt.includes('no-new-privileges:true')||
      svc.pid==='host'||svc.ipc==='host'||
      svc.network_mode==='host'||svc.cgroup==='host'||
      svc.userns_mode==='host'||svc.uts==='host'||
      svc.security_opt.some(x=>typeof x!=='string'||
        /seccomp:unconfined|apparmor:unconfined/i.test(x))||
      svc.deploy?.mode==='global')
      blockers.push('ESCALATION_OR_HOST_ACCESS_'+name);
    // No arbitrary bind mounts; the only permitted one is the readonly
    // provision script in the one-time setup container.
    const mounts=svc.volumes||[];
    if(!Array.isArray(mounts))blockers.push('UNSAFE_VOLUME_SHAPE_'+name);
    else for(const m of mounts){
      if(!own(m)){blockers.push('UNSAFE_VOLUME_SHAPE_'+name);continue}
      if(name==='db'){
        if(m.type!=='volume'||m.target!=='/var/lib/postgresql/data'||
          !/^((osmanx-guest-r14-canary_)?guest_r14_data)$/.test(m.source||''))
          blockers.push('DB_VOLUME_OUTSIDE_DISPOSABLE_SCOPE');
      }else if(name==='provision'){
        if(m.type!=='bind'||m.target!=='/ops/provision-roles.sh'||
          m.read_only!==true||typeof m.source!=='string'||
          m.source!==expectedProvisionPath)
          blockers.push('UNEXPECTED_PROVISION_MOUNT');
      }else{
        blockers.push('UNEXPECTED_RUNTIME_BIND_OR_VOLUME_'+name);
      }
    }
    if(name==='api'){
      if(svc.read_only!==true||svc.init!==true||
        !Array.isArray(svc.tmpfs)||!svc.tmpfs.some(x=>
          (typeof x==='string'?x:x?.target)==='/tmp'))
        blockers.push('API_WRITABLE_FILESYSTEM_OR_NO_INIT');
    }
    if(name==='migrate'||name==='bootstrap'){
      if(svc.read_only!==true||
        !Array.isArray(svc.profiles)||
        !svc.profiles.includes('setup'))
        blockers.push('SETUP_PROFILE_ESCAPE_'+name);
    }
  }
  if(own(config?.volumes)&&
    Object.keys(config.volumes).some(name=>name!=='guest_r14_data'))
    blockers.push('UNEXPECTED_TOP_LEVEL_VOLUME');
  if(own(config?.secrets)&&Object.keys(config.secrets).length)
    blockers.push('UNEXPECTED_COMPOSE_SECRETS');
  if(own(config?.configs)&&Object.keys(config.configs).length)
    blockers.push('UNEXPECTED_COMPOSE_CONFIGS');
  return {schema:R39_COMPOSE_SCHEMA,
    valid:blockers.length===0,blockers:[...new Set(blockers)],
    configReturned:false,credentialValuesReturned:false,
    dockerMutations:0,productionAuthorized:false};
}
