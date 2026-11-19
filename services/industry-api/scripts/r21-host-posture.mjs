/**
 * R21 local-host posture review (READ-ONLY). It never connects to or changes
 * any remote VPS: the approved operator must run --local ON that host.
 * Output excludes paths, secrets, env values other than safe fixed allowlist,
 * Docker config, key contents and credentials.
 */
import {lstat,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {platform,release} from 'node:os';

export const HOST_SCHEMA='osmanx.guest.r21.host-posture.v1';
const PRIVATE_KEYS=[
  'GUEST_R16_REGISTRY_FILE','GUEST_R17_JOURNAL_FILE',
  'GUEST_R17_OWNER_WITNESS_FILE','GUEST_R17_MANAGER_WITNESS_FILE',
  'GUEST_R18_ANCHOR_FILE','GUEST_R19_SCOPE_FILE',
  'GUEST_R19_STOP_FILE'
];
const PUBLIC_KEYS=[
  'GUEST_R17_OWNER_PUBLIC_KEY','GUEST_R17_MANAGER_PUBLIC_KEY',
  'GUEST_R18_CUSTODIAN_PUBLIC_KEY','GUEST_R19_OPERATOR_PUBLIC_KEY'
];
const safe=(value)=>typeof value==='string'&&value.length>0;
const pathOk=p=>safe(p)&&isAbsolute(p)&&resolve(p)===p;
export function evaluateHostPosture(snapshot){
  const blockers=[],checks={
    linuxHost:snapshot?.os==='linux',
    nodeSupported:typeof snapshot?.nodeMajor==='number'&&snapshot.nodeMajor>=22,
    expectedOrigin:snapshot?.allowedOriginIsExact===true,
    guestWritesDisabled:snapshot?.writesEnabled===false,
    independentCustodyConfigured:snapshot?.custodyConfigured===true,
    secretsOutOfCheckout:snapshot?.pathsOutsideCheckout===true,
    secureFileModes:snapshot?.privateFilesSafe===true,
    pinnedPublicKeysReadable:snapshot?.publicKeysSafe===true,
    localCanaryOnly:snapshot?.canaryListener==='loopback',
    noPublicPostgres:snapshot?.postgresExposed===false,
    operatorWitnessPresent:snapshot?.independentOperatorConfirmed===true
  };
  for(const [key,value] of Object.entries(checks))
    if(value!==true)blockers.push('host_'+key);
  return {schema:HOST_SCHEMA,checks,blockers,
    safeIsolatedRehearsal:blockers.length===0,
    liveHostInspected:snapshot?.gatheredOnHost===true,
    environmentMode:snapshot?.environmentMode==='production'?'production':'non-production-or-unknown',
    productionActivationPermitted:false,customerGo:false,
    changesMade:false,secretsIncluded:false};
}
function listenerState(text,port){
  if(typeof text!=='string')return 'unknown';
  const lines=text.split('\n').filter(x=>new RegExp(':'+port+'\\s').test(x+' '));
  if(lines.length===0)return 'absent';
  if(lines.some(l=>new RegExp('(?:0\\.0\\.0\\.0|\\*|\\[::\\]|:::):'+port+'(?:\\s|$)').test(l)))
    return 'public';
  if(lines.every(l=>new RegExp('(?:127\\.0\\.0\\.1|\\[::1\\]|::1):'+port+'(?:\\s|$)').test(l)))
    return 'loopback';
  return 'unknown';
}
export function classifyPortListeners(ssOutput){
  return {canary:listenerState(ssOutput,'3150'),
    postgres:listenerState(ssOutput,'5432')};
}
async function statSource(path,{privateFile,optional=false,uid}={}){
  if(!pathOk(path))return false;
  try{
    const folder=dirname(path),parent=await realpath(folder);
    if(parent!==folder)return false;
    const s=await lstat(path);
    if(!s.isFile()||s.isSymbolicLink())return false;
    if(typeof uid==='number'&&uid!==0&&s.uid!==uid&&s.uid!==0)return false;
    if(privateFile&&(s.mode&0o077)!==0)return false;
    if(!privateFile&&(s.mode&0o022)!==0)return false;
    return true;
  }catch(e){
    return optional&&e?.code==='ENOENT';
  }
}
export async function collectHostSnapshot({
  env=process.env,uid=typeof process.getuid==='function'?process.getuid():null,
  pathInspector=statSource,ssReader=()=>execFileSync('ss',['-ltnH'],
    {encoding:'utf8',timeout:3000,stdio:['ignore','pipe','ignore']})
}={}){
  const checkout=resolve(fileURLToPath(new URL('..',import.meta.url)));
  const configured=[...PRIVATE_KEYS,...PUBLIC_KEYS].every(k=>pathOk(env[k]));
  const pathsOutsideCheckout=configured&&[...PRIVATE_KEYS,...PUBLIC_KEYS].every(k=>
    !env[k].startsWith(checkout+sep)&&env[k]!==checkout);
  let privateFilesSafe=false,publicKeysSafe=false;
  if(pathsOutsideCheckout){
    privateFilesSafe=(await Promise.all(PRIVATE_KEYS.map(name=>
      pathInspector(env[name],{privateFile:true,optional:name==='GUEST_R19_STOP_FILE',uid})))).every(Boolean);
    publicKeysSafe=(await Promise.all(PUBLIC_KEYS.map(name=>
      pathInspector(env[name],{privateFile:false,uid})))).every(Boolean);
  }
  let ports={canary:'unknown',postgres:'unknown'};
  try{ports=classifyPortListeners(ssReader());}catch{/* OS introspection unavailable = NO-GO */}
  return {os:platform(),kernelFamily:release().split('-')[0],
    nodeMajor:Number(process.versions.node.split('.')[0]),
    environmentMode:env.NODE_ENV==='production'?'production':'unknown',
    allowedOriginIsExact:env.ALLOWED_ORIGIN==='https://osmanx.world',
    writesEnabled:env.GUEST_WRITES_ENABLED==='true',
    custodyConfigured:configured&&env.GUEST_R19_ROLLOUT_ENABLED==='true',
    pathsOutsideCheckout,privateFilesSafe,publicKeysSafe,
    canaryListener:ports.canary,postgresExposed:ports.postgres==='public'?
      true:ports.postgres==='unknown'?null:false,
    independentOperatorConfirmed:false,
    gatheredOnHost:true};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--local')
      throw Error('Use --local on the approved operator host');
    const report=evaluateHostPosture(await collectHostSnapshot());
    process.stdout.write(JSON.stringify(report)+'\n');
    if(!report.safeIsolatedRehearsal)process.exitCode=2;
  }catch{
    process.stdout.write(JSON.stringify({schema:HOST_SCHEMA,
      safeIsolatedRehearsal:false,liveHostInspected:false,
      customerGo:false,productionActivationPermitted:false,
      blockers:['host_inspection_unavailable'],changesMade:false})+'\n');
    process.exitCode=2;
  }
}
