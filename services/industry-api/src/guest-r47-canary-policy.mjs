/**
 * R47 resolved Docker Compose review: check the effective, interpolated
 * topology, not merely grepped YAML. Synthetic CI secrets only.
 */
export const R47_CANARY_SCHEMA='osmanx.guest.r47.resolved-canary-security.v1';
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const keys=x=>obj(x)?Object.keys(x):[];
const has=x=>Array.isArray(x)?x:[];
const netKeys=x=>Array.isArray(x)?x:keys(x);
const blockedService=x=>x?.privileged===true||
   x?.network_mode==='host'||x?.pid==='host'||x?.ipc==='host'||
   x?.userns_mode==='host'||x?.ports?.some?.(p=>p?.host_ip!=='127.0.0.1');
export function assessR47ResolvedCanary(config){
 const blockers=[],services=config?.services;
 const expected=['api','db','provision','migrate','bootstrap'];
 if(!obj(config)||!obj(services)||
   keys(services).sort().join('|')!==expected.slice().sort().join('|'))
   blockers.push('UNEXPECTED_CANARY_SERVICE_INVENTORY');
 const api=services?.api||{},db=services?.db||{};
 if(config?.name!=='osmanx-guest-r14-canary')
   blockers.push('UNEXPECTED_DOCKER_COMPOSE_PROJECT');
 if(keys(config?.networks).sort().join('|')!=='r14_private'||
   config.networks?.r14_private?.external===true||
   config.networks?.r14_private?.driver!=='bridge')
   blockers.push('EXTERNAL_OR_UNEXPECTED_NETWORK');
 if(keys(config?.volumes).sort().join('|')!=='guest_r14_data'||
   config.volumes?.guest_r14_data?.external===true)
   blockers.push('EXTERNAL_OR_UNEXPECTED_DB_VOLUME');
 for(const name of expected){
   const svc=services?.[name];
   if(!obj(svc)){
     blockers.push('MISSING_EXPECTED_SERVICE_'+name);
     continue;
   }
   if(blockedService(svc)||netKeys(svc.networks).join('|')!=='r14_private'||
      svc.devices?.length||svc.cap_add?.length||svc.extra_hosts?.length)
     blockers.push('PRIVILEGED_PUBLIC_OR_UNEXPECTED_SERVICE_'+name);
   if(name!=='api'&&has(svc.ports).length)
     blockers.push('NON_API_SERVICE_EXPOSES_A_PORT_'+name);
   if(!has(svc.security_opt).includes('no-new-privileges:true'))
     blockers.push('NO_NEW_PRIVILEGES_MISSING_'+name);
 }
 const ports=has(api.ports);
 if(ports.length!==1||ports[0]?.host_ip!=='127.0.0.1'||
   String(ports[0]?.published)!=='3150'||ports[0]?.target!==3047||
   (ports[0]?.protocol||'tcp')!=='tcp')
   blockers.push('API_MUST_ONLY_BIND_127_0_0_1_3150');
 if(api.environment?.GUEST_WRITES_ENABLED!=='false'||
   api.environment?.NODE_ENV!=='production')
   blockers.push('GUEST_WRITES_NOT_LITERAL_FALSE');
 if(api.read_only!==true||!has(api.tmpfs).some(x=>
   x==='/tmp'||obj(x)&&x.target==='/tmp')||
   api.depends_on?.db?.condition!=='service_healthy')
   blockers.push('API_READ_ONLY_OR_DB_HEALTH_DEPENDENCY_MISSING');
 if(!has(db.volumes).some(x=>x?.type==='volume'&&
   x.source==='guest_r14_data'&&
   x.target==='/var/lib/postgresql/data'))
   blockers.push('DB_MUST_ONLY_USE_PRIVATE_NAMED_VOLUME');
 if(!String(db.image||'').startsWith('postgres:16'))
   blockers.push('UNEXPECTED_POSTGRES_CANARY_IMAGE');
 for(const name of ['provision','migrate','bootstrap']){
   if(!has(services?.[name]?.profiles).includes('setup')||
     services[name]?.restart!=='no')
     blockers.push('SETUP_SERVICE_MUST_BE_NON_RESTARTING_'+name);
 }
 const report={schema:R47_CANARY_SCHEMA,
   effectiveComposeChecked:!!config,
   canaryTopologySafe: blockers.length===0,
   loopbackOnly:ports.length===1&&ports[0]?.host_ip==='127.0.0.1',
   sourceCodeIsolatedFromRuntime:false,
   guestWritesEnabled:false,
   authorizedCustomerData:false,
   canaryIsNotProduction:true,productionAuthorized:false,
   blockers:[...new Set(blockers)]};
 return report;
}
