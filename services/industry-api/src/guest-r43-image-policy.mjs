/**
 * R43 inspect the actually built image config, then exercise it offline with
 * Docker's runtime flags. Image labels are self assertions, NOT signatures.
 */
import {R43_PINNED_LOCK_SHA256} from './guest-r43-lock.mjs';
export const R43_IMAGE_SCHEMA='osmanx.guest.r43.local-container-image-policy.v1';
const SHA=/^[a-f0-9]{40}$/;
export function verifyR43ImageConfig({inspect,sourceSha}={}){
 const blockers=[];
 const v=Array.isArray(inspect)?inspect[0]:inspect;
 const cfg=v?.Config||{},labels=cfg.Labels||{};
 if(!SHA.test(sourceSha||''))blockers.push('SOURCE_COMMIT_SHA_REQUIRED');
 if(typeof v?.Id!=='string'||!/^sha256:[a-f0-9]{64}$/.test(v.Id))
   blockers.push('UNKNOWN_CONTAINER_IMAGE_DIGEST');
 if(cfg.User!=='node'||cfg.WorkingDir!=='/app'||
   !Array.isArray(cfg.Cmd)||cfg.Cmd.join(' ')!=='node src/server.mjs')
   blockers.push('ROOT_OR_UNEXPECTED_CONTAINER_ENTRYPOINT');
 if(labels['org.opencontainers.image.revision']!==sourceSha||
   labels['io.osmanx.guest.lock-sha256']!==R43_PINNED_LOCK_SHA256||
   labels['io.osmanx.guest.writes-default']!=='false')
   blockers.push('WRONG_SOURCE_OR_WRITE_LOCK_LABELS');
 const exposed=Object.keys(cfg.ExposedPorts||{});
 if(exposed.length!==1||exposed[0]!=='3047/tcp')
   blockers.push('EXPOSED_UNEXPECTED_CONTAINER_PORT');
 const env=Array.isArray(cfg.Env)?cfg.Env:[];
 if(env.some(v=>typeof v!=='string'||/^(DATABASE_URL|POSTGRES_ADMIN_PASSWORD|AGE_|GUEST_WRITES_ENABLED)=/i.test(v))||
   !env.includes('NODE_ENV=production'))
   blockers.push('EMBEDDED_RUNTIME_DATABASE_SECRETS_OR_WRITES');
 const health=JSON.stringify(cfg.Healthcheck||{});
 if(!/127\.0\.0\.1:3047/.test(health)||!/health\/ready/.test(health))
   blockers.push('NO_LOCAL_READINESS_HEALTHCHECK');
 return {schema:R43_IMAGE_SCHEMA,valid:blockers.length===0,
   imageId:/^sha256:[a-f0-9]{64}$/.test(v?.Id||'')?v.Id:null,
   localImageMatchesSource:labels['org.opencontainers.image.revision']===sourceSha,
   pinnedLockMatchesSource:labels['io.osmanx.guest.lock-sha256']===
     R43_PINNED_LOCK_SHA256,
   imageRunsAsNonroot:cfg.User==='node',
   guestWritesDefault:false,
   independentlySigned:false,
   baseImageDigestIndependentlyPinned:false,
   remoteStagingDeployed:false,
   customerGo:false,productionAuthorized:false,
   blockers:[...new Set(blockers)]};
}
