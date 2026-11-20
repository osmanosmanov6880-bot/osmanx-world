/**
 * R38 rendered Docker Compose policy. Validates actual config JSON, not source
 * YAML patterns. NO Docker calls. Used after R37 file checks, before up/plan.
 */
import {createHash} from 'node:crypto';
const hash=o=>createHash('sha256').update(JSON.stringify(o)).digest('hex');
const entries=o=>o&&typeof o==='object'&&!Array.isArray(o);
const allowed=['db','provision','migrate','bootstrap','api'];
const CONFIG='osmanx.guest.r38.rendered-compose.v1';
export function inspectR38RenderedCompose(config){
  const failures=[];
  if(!entries(config)||!entries(config.services)||
    config.name!=='osmanx-guest-r14-canary'||
    Object.keys(config.services).sort().join('|')!==
      allowed.slice().sort().join('|'))
    failures.push('COMPOSE_PROJECT_OR_SERVICES_DRIFT');
  const services=entries(config?.services)?config.services:{};
  const api=services.api||{};
  if(!Array.isArray(api.ports)||api.ports.length!==1||
    Number(api.ports[0]?.published)!==3150||
    Number(api.ports[0]?.target)!==3047||
    api.ports[0]?.host_ip!=='127.0.0.1'||
    api.ports[0]?.protocol!=='tcp')
    failures.push('CANARY_EXPOSED_OR_DUPLICATE_PORT');
  for(const [name,service] of Object.entries(services)){
    if(!entries(service))continue;
    if(name!=='api'&&Array.isArray(service.ports)&&service.ports.length)
      failures.push('NON_API_EXPOSED_PORT');
    if(service.privileged===true||
      ['host','none'].includes(service.network_mode)||
      service.pid==='host'||service.ipc==='host'||
      service.read_only===false&&name==='api')
      failures.push('DANGEROUS_CONTAINER_PRIVILEGE');
    const networks=service.networks;
    if(!entries(networks)||
      Object.keys(networks).length!==1||
      !Object.hasOwn(networks,'r14_private'))
      failures.push('SERVICE_NETWORK_ESCAPE');
  }
  if(!entries(config?.networks)||!entries(config.networks.r14_private)||
    Object.keys(config.networks).length!==1||
    config.networks.r14_private.driver!=='bridge')
    failures.push('NON_PRIVATE_NETWORK');
  if(!entries(api.environment)||
    api.environment.GUEST_WRITES_ENABLED!=='false'||
    api.environment.NODE_ENV!=='production'||
    api.environment.PORT!=='3047'||
    !api.read_only||
    api.security_opt?.includes('no-new-privileges:true')!==true)
    failures.push('API_WRITE_OR_PRIVILEGE_DRIFT');
  const appDb=services.db;
  if(!entries(appDb)||!entries(appDb.volumes) && !Array.isArray(appDb.volumes)||
    !Array.isArray(appDb.volumes)||appDb.volumes.length!==1||
    appDb.volumes[0]?.type!=='volume'||
    !['guest_r14_data','osmanx-guest-r14-canary_guest_r14_data']
      .includes(appDb.volumes[0].source))
    failures.push('PERSISTENCE_VOLUME_DRIFT');
  // Do not return rendered config; it may contain resolved secret values.
  return {schema:CONFIG,valid:failures.length===0,
    blockers:[...new Set(failures)],configReturned:false,
    secretsReturned:false,dockerMutationsPerformed:false,
    topologyDigest:hash({
      serviceNames:Object.keys(services).sort(),
      apiPort:api?.ports?.map(p=>[p.host_ip,p.published,p.target]),
      apiGuestWrites:api?.environment?.GUEST_WRITES_ENABLED,
      networkNames:Object.keys(config?.networks||{}).sort()
    }),productionAuthorized:false};
}
