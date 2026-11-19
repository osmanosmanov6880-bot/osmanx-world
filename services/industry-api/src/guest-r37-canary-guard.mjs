/**
 * R37: fail-closed R14 canary input and topology preflight. Reads only local
 * metadata and the source-owned compose definition. Never invokes Docker.
 */
import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
export const R37_CANARY_SCHEMA='osmanx.guest.r37.canary-static-preflight.v1';
const sha=x=>createHash('sha256').update(x).digest('hex');
export function inspectR37CanaryTopology(yaml){
  const failures=[];
  if(typeof yaml!=='string'||yaml.length<120||yaml.length>32768)
    return {valid:false,failures:['INVALID_COMPOSE_SIZE']};
  const exact=(r)=>r.test(yaml);
  if(!exact(/^name:\s+osmanx-guest-r14-canary\s*$/m))
    failures.push('PROJECT_NAME_CHANGED');
  if(!exact(/^\s{2}api:\s*$/m)||
    !exact(/^\s{2}db:\s*$/m)||
    !exact(/^\s{2}migrate:\s*$/m))
    failures.push('ISOLATED_SERVICES_MISSING');
  if(!exact(/^\s+GUEST_WRITES_ENABLED:\s*["']false["']\s*$/m))
    failures.push('GUEST_WRITES_NOT_EXPLICITLY_DISABLED');
  if(!exact(/^\s+ports:\s*\["127\.0\.0\.1:3150:3047"\]\s*$/m)||
    (yaml.match(/^\s+ports\s*:/gm)||[]).length!==1)
    failures.push('LOOPBACK_PORT_POLICY_CHANGED');
  if(!exact(/^\s{2}r14_private:\s*$/m)||
    !exact(/^\s{2}guest_r14_data:\s*$/m)||
    !exact(/^\s+networks:\s*\[r14_private\]\s*$/m))
    failures.push('ISOLATION_TOPOLOGY_CHANGED');
  if(/^\s{2}(?:worker|webhook|proxy|nginx):\s*$/m.test(yaml)||
    /^\s+(?:network_mode:\s*host|privileged:\s*true|pid:\s*host)\b/m.test(yaml)||
    /0\.0\.0\.0:3150|GUEST_WRITES_ENABLED:\s*["']?true/i.test(yaml))
    failures.push('FORBIDDEN_EXPOSURE_OR_WORKER');
  return {valid:failures.length===0,failures:[...new Set(failures)],
    topologySha256:sha(yaml),localPort:'127.0.0.1:3150',
    productionWritesAllowed:false,dockerCommandsExecuted:false};
}
export function inspectR37PrivateEnvironment({
  path,canonical,checkout,stats,currentUid
}={}){
  const failures=[];
  if(typeof path!=='string'||typeof canonical!=='string'||
    !isAbsolute(path)||!isAbsolute(canonical)||
    typeof checkout!=='string'||!isAbsolute(checkout)||
    path.includes('\0')||canonical.includes('\0')||
    path.length>1024||canonical.length>1024)
    failures.push('PRIVATE_FILE_PATH_INVALID');
  const root=typeof checkout==='string'?resolve(checkout):'';
  const file=typeof canonical==='string'?resolve(canonical):'';
  if(file===root||file.startsWith(root+sep))
    failures.push('SECRETS_INSIDE_CHECKOUT');
  if(!stats||!stats.isFile?.()||stats.isSymbolicLink?.()||
    !Number.isSafeInteger(stats.size)||stats.size<8||stats.size>32768)
    failures.push('PRIVATE_FILE_TYPE_OR_SIZE_INVALID');
  if(!Number.isInteger(stats?.mode)||(stats.mode&0o077)!==0)
    failures.push('PRIVATE_FILE_PERMISSIONS_TOO_OPEN');
  if(typeof currentUid==='number'&&stats?.uid!==currentUid)
    failures.push('PRIVATE_FILE_NOT_OWNED_BY_OPERATOR');
  return {valid:failures.length===0,failures:[...new Set(failures)],
    privateFileNotRead:true,privateFilePathReturned:false};
}
export async function checkR37CanaryPreflight({
  envPath,composePath,checkoutRoot,currentUid=process.getuid?.()
}={}){
  if(typeof envPath!=='string'||typeof composePath!=='string'||
    typeof checkoutRoot!=='string'||!isAbsolute(envPath)||
    !isAbsolute(composePath)||!isAbsolute(checkoutRoot))
    throw Error('Absolute operator paths required');
  const [envStat,canonical,composeStat]=await Promise.all([
    lstat(envPath),realpath(envPath),lstat(composePath)
  ]);
  if(!composeStat.isFile()||composeStat.isSymbolicLink()||
    composeStat.size>32768)
    throw Error('R37 compose source must be a regular small file');
  const [yaml,sourceRoot]=await Promise.all([
    readFile(composePath,'utf8'),realpath(checkoutRoot)
  ]);
  const env=inspectR37PrivateEnvironment({
    path:envPath,canonical,checkout:sourceRoot,
    stats:envStat,currentUid
  });
  const topology=inspectR37CanaryTopology(yaml);
  const valid=env.valid&&topology.valid;
  return {schema:R37_CANARY_SCHEMA,valid,
    errors:[...new Set([...env.failures,...topology.failures])],
    topologySha256:topology.topologySha256||null,
    environmentRead:false,environmentPrinted:false,
    dockerCommandsExecuted:false,productionAuthorized:false};
}
