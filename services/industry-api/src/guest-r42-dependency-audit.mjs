/**
 * R42 deterministic offline inspection of npm's generated package-lock v3.
 * The project had NO committed lockfile through R41. A CI-generated lock is
 * evidence to review, not a pinned/reproducible dependency source tree.
 */
import {createHash} from 'node:crypto';
export const R42_DEPS_SCHEMA='osmanx.guest.r42.generated-lock-inventory.v1';
const EXPECTED={
  '@fastify/cookie':'11.1.5',fastify:'5.12.8',pg:'8.23.1'
};
const HASH=x=>createHash('sha256').update(x).digest('hex');
const own=x=>x&&typeof x==='object'&&!Array.isArray(x);
export function auditR42Dependencies({pkg,lock,rawLock}={}){
  const blockers=[];
  const expectedNames=Object.keys(EXPECTED).sort().join('|');
  if(!own(pkg)||pkg.name!=='@osmanx/industry-api'||
    pkg.private!==true||
    !own(pkg.dependencies)||
    Object.keys(pkg.dependencies).sort().join('|')!==expectedNames||
    Object.entries(EXPECTED).some(([k,v])=>pkg.dependencies[k]!==v)||
    own(pkg.devDependencies)&&Object.keys(pkg.devDependencies).length>0)
    blockers.push('DIRECT_DEPENDENCY_ALLOWLIST_OR_VERSION_DRIFT');
  if(!own(lock)||lock.lockfileVersion!==3||
    !own(lock.packages)||
    Object.keys(lock.packages).length<4||
    Object.keys(lock.packages).length>1024||
    lock.packages['']?.name!==pkg?.name||
    Object.entries(EXPECTED).some(([k,v])=>
      lock.packages['']?.dependencies?.[k]!==v))
    blockers.push('LOCKFILE_V3_OR_ROOT_INCONSISTENT');
  const all=own(lock?.packages)?Object.entries(lock.packages):[];
  let checked=0,scripted=0;
  for(const [name,meta] of all){
    if(!name)continue;
    if(!/^node_modules\/(?:@[-a-z0-9._]+\/)?[-a-z0-9._]+(?:\/node_modules\/(?:@[-a-z0-9._]+\/)?[-a-z0-9._]+)*$/.test(name)||
      !own(meta)||typeof meta.version!=='string'||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(meta.version)||
      typeof meta.resolved!=='string'||
      !meta.resolved.startsWith('https://registry.npmjs.org/')||
      typeof meta.integrity!=='string'||
      !/^sha512-[A-Za-z0-9+/=]{40,}$/.test(meta.integrity))
      blockers.push('UNTRUSTED_OR_NONINTEGRITY_PACKAGE_ENTRY');
    if(meta?.hasInstallScript===true)scripted++;
    checked++;
  }
  for(const [name,version] of Object.entries(EXPECTED))
    if(lock?.packages?.['node_modules/'+name]?.version!==version)
      blockers.push('TOP_LEVEL_PACKAGE_RESOLUTION_CHANGED');
  if(scripted>0)blockers.push('TRANSITIVE_INSTALL_SCRIPTS_REQUIRE_REVIEW');
  if(typeof rawLock!=='string'||rawLock.length<500||
    rawLock.length>3000000)
    blockers.push('LOCKFILE_BYTES_UNAVAILABLE');
  const body={schema:R42_DEPS_SCHEMA,
    directPinned:Object.keys(EXPECTED).length,
    inspectedPackageEntries:checked,
    packagesWithInstallScripts:scripted,
    generatedLockSha256:typeof rawLock==='string'?HASH(rawLock):null,
    sourceLockfileCommitted:false,
    generatedInCiNotReproducibleUntilCommitted:true,
    integrityGraphValid:blockers.length===0,
    thirdPartyAuditVerified:false,
    customerGo:false,productionAuthorized:false,
    blockers:[...new Set(blockers)]};
  return body;
}
