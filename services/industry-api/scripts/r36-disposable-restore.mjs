/**
 * Real command gated by operator acknowledgement + local database allowlist.
 * Uses existing ops/restore-dr.sh and never includes DB credentials in stdout.
 * CI tests injected adapters, not external databases or identities.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lstat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {hashR35RegularFile}
  from '../src/guest-r35-byte-proof.mjs';
import {R35_PIN} from '../src/guest-r36-source.mjs';
import {R36_RESTORE_SCHEMA,runR36DisposableRestore}
  from '../src/guest-r36-disposable-restore.mjs';
const exec=promisify(execFile);
async function checkIdentity(path){
  const s=await lstat(path);
  if(!s.isFile()||s.isSymbolicLink()||s.size<16||
    s.size>65536||(s.mode&0o077)!==0)
    throw Error('AGE identity must be a small operator-only private file');
}
async function restoreCommand({script,archive,identityFile,dbUrl}){
  const projectRoot=resolve(fileURLToPath(new URL('../',import.meta.url)));
  const absoluteScript=resolve(projectRoot,script);
  if(absoluteScript!==resolve(projectRoot,'ops/restore-dr.sh'))
    throw Error('Unexpected restore program');
  const {stdout}=await exec('sh',[absoluteScript,archive],{
    cwd:projectRoot,timeout:120000,killSignal:'SIGKILL',
    maxBuffer:16*1024,
    env:{...process.env,DR_RESTORE_DB_URL:dbUrl,
      AGE_IDENTITY_FILE:identityFile}
  });
  return {exitCode:0,verifiedEmptyTarget:
    /Disaster-recovery restore verified in isolated database: industry_dr_r36_/.test(stdout)};
}
export async function runApprovedR36LocalRestore({plan,dbUrl,approved=false,
  clock,hashArchive=hashR35RegularFile,
  identityCheck=checkIdentity,command=restoreCommand}={}){
  return runR36DisposableRestore({
    plan,dbUrl,approved,hashArchive,checkIdentity:identityCheck,
    restoreCommand:command,...(clock?{clock}:{})
  });
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==7||
      process.argv[2]!=='--approved-local-restore'||
      process.env.GUEST_R36_RESTORE_ACK!=='RESTORE_DISPOSABLE_LOOPBACK_ONLY')
      throw Error('R36 needs explicit approval and 4 restore arguments');
    const [pilotId,sourceTreeSha,archivePath,archiveSha256]=
      process.argv.slice(3);
    const identityFile=process.env.AGE_IDENTITY_FILE,
      dbUrl=process.env.DR_RESTORE_DB_URL;
    const now=new Date(),parsed=new URL(dbUrl);
    const plan={schema:R36_RESTORE_SCHEMA,pilotId,
      releaseSha:R35_PIN.sha,sourceTreeSha,
      archivePath,archiveSha256,identityFile,
      issuedAt:now.toISOString(),
      expiresAt:new Date(now.getTime()+300000).toISOString(),
      nonce:randomBytes(16).toString('hex'),
      allowedTargetDb:decodeURIComponent(parsed.pathname.slice(1))
    };
    const result=await runApprovedR36LocalRestore({
      plan,dbUrl,approved:true});
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(error){
    process.stderr.write('R36 restore NO-GO: '+error.message+'\n');
    process.exitCode=2;
  }
}
