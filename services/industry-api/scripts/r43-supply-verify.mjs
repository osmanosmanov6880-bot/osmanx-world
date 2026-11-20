/** R43 offline committed-lock and optionally live npm advisory JSON gate. */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyR43Lock} from '../src/guest-r43-lock.mjs';
import {inspectR43Audit} from '../src/guest-r43-audit-policy.mjs';
const ROOT=resolve(fileURLToPath(new URL('../',import.meta.url)));
export async function readR43Supply({auditFile}={}){
 const [packageBytes,lockBytes]=await Promise.all([
   readFile(ROOT+'/package.json','utf8'),
   readFile(ROOT+'/package-lock.json','utf8')]);
 const lock=verifyR43Lock({packageJson:JSON.parse(packageBytes),
   lock:JSON.parse(lockBytes),rawLock:lockBytes});
 const audit=auditFile?inspectR43Audit(JSON.parse(
   await readFile(auditFile,'utf8'))):null;
 return {schema:'osmanx.guest.r43.locked-source-advisory.v1',
   lock,audit,sourceInstallMode:'npm ci --ignore-scripts',
   reproducibleDependencyGraph:lock.valid,
   advisoryPolicyPassed:audit?.highCriticalPolicyPassed??false,
   sourceProvenanceIndependentlySigned:false,
   productionAuthorized:false,customerGo:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
 try{
   if(process.argv.length<3||process.argv.length>4||
     !['--lock','--sbom','--audit'].includes(process.argv[2])||
     (process.argv[2]==='--audit'&&process.argv.length!==4))
     throw Error('R43 --lock | --sbom | --audit AUDIT_JSON');
   const mode=process.argv[2];
   const result=await readR43Supply({
     auditFile:mode==='--audit'?process.argv[3]:null});
   const output=mode==='--sbom'?{
     schema:result.lock.sbomSchema,
     packages:result.lock.sbomPackages,
     packageCount:result.lock.packages,
     sourceLockSha256:result.lock.lockSha256,
     sourceLockPinned:result.lock.valid,
     productionAuthorized:false
   }:result;
   process.stdout.write(JSON.stringify(output)+'\n');
   if(!result.lock.valid||
     mode==='--audit'&&!result.advisoryPolicyPassed)
     process.exitCode=2;
 }catch{
   process.stderr.write('R43 locked dependency source or advisory NO-GO\n');
   process.exitCode=2;
 }
}
