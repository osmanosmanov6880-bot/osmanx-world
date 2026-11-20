/**
 * R43 exact pinned R42 CI lock. Nothing may resolve from a moving registry tag
 * during operator builds. This is source integrity, not a substitute for npm
 * advisory audit, independent review or signing of a container image.
 */
import {createHash} from 'node:crypto';
export const R43_LOCK_SCHEMA='osmanx.guest.r43.committed-lock.v1';
export const R43_PINNED_LOCK_SHA256='d0453f56f370d9d5822ccb2116148e56f07acaccff66deb01d5fc280cbc4321a';
const PKGS=Object.freeze({'@fastify/cookie':'11.1.5',fastify:'5.12.8',pg:'8.23.1'});
const isObj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const HASH=s=>createHash('sha256').update(s).digest('hex');
const PACKAGE=/^node_modules\/(?:@[-a-z0-9._]+\/)?[-a-z0-9._]+(?:\/node_modules\/(?:@[-a-z0-9._]+\/)?[-a-z0-9._]+)*$/;
function nameFromPath(p){
 const q=p.split('/'),last=q.at(-1);
 return q.length>=3&&q.at(-2)?.startsWith('@')?q.at(-2)+'/'+last:last;
}
export function verifyR43Lock({packageJson,lock,rawLock}={}){
 const blockers=[];
 const actual=typeof rawLock==='string'?HASH(rawLock):null;
 if(actual!==R43_PINNED_LOCK_SHA256)
   blockers.push('COMMITTED_LOCKFILE_BYTES_DIFFER_FROM_R42_VERIFIED_SOURCE');
 if(!isObj(packageJson)||packageJson.name!=='@osmanx/industry-api'||
   packageJson.private!==true||packageJson.type!=='module'||
   packageJson.engines?.node!=='>=22'||
   !isObj(packageJson.dependencies)||
   Object.keys(packageJson.dependencies).sort().join('|')!==
     Object.keys(PKGS).sort().join('|')||
   Object.entries(PKGS).some(([n,v])=>packageJson.dependencies[n]!==v))
   blockers.push('DIRECT_PACKAGE_VERSIONS_OR_PACKAGE_JSON_DRIFT');
 const entries=isObj(lock?.packages)?Object.entries(lock.packages):[];
 if(lock?.name!=='@osmanx/industry-api'||lock?.lockfileVersion!==3||
   !isObj(lock?.packages?.[''])||entries.length!==64||
   lock.packages[''].name!==packageJson?.name||
   Object.entries(PKGS).some(([n,v])=>
     lock.packages['']?.dependencies?.[n]!==v))
   blockers.push('LOCKFILE_V3_ROOT_OR_COUNT_DRIFT');
 let packages=0,scripted=0;
 const identities=[];
 for(const [path,meta] of entries){
   if(path==='')continue;
   packages++;
   if(!PACKAGE.test(path)||!isObj(meta)||
     typeof meta.version!=='string'||
     !/^\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i.test(meta.version)||
     typeof meta.integrity!=='string'||
     !/^sha512-[A-Za-z0-9+/=]{64,}$/.test(meta.integrity)||
     typeof meta.resolved!=='string'||
     !meta.resolved.startsWith('https://registry.npmjs.org/')||
     /[\s\\]|(?:\.\.)/.test(meta.resolved))
     blockers.push('TRANSITIVE_REGISTRY_OR_INTEGRITY_DRIFT');
   if(meta?.hasInstallScript===true)scripted++;
   identities.push({path,name:nameFromPath(path),version:meta?.version||null,
     integrity:meta?.integrity||null});
 }
 if(scripted!==0)blockers.push('UNAPPROVED_PACKAGE_INSTALL_SCRIPTS');
 for(const [name,version] of Object.entries(PKGS))
   if(lock?.packages?.['node_modules/'+name]?.version!==version)
     blockers.push('TOP_LEVEL_RESOLUTION_CHANGED');
 const bom=identities.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 const bomSha=HASH(JSON.stringify(bom));
 return {schema:R43_LOCK_SCHEMA,valid:blockers.length===0,
   committedLockfile:true,verifiedR42ArtifactSha:actual===R43_PINNED_LOCK_SHA256,
   lockSha256:actual,packages:packages,expectedPackages:63,
   directDependencies:3,installScriptsFound:scripted,
   registryIntegrityVerified:blockers.length===0,
   sbomSchema:'osmanx.guest.r43.npm-package-inventory.v1',
   sbomSha256:bomSha,sbomPackages:bom,
   auditVulnerabilitiesNotDetermined:true,
   runtimeContainerImageNotIndependentlySigned:true,
   customerGo:false,productionAuthorized:false,
   blockers:[...new Set(blockers)]};
}
