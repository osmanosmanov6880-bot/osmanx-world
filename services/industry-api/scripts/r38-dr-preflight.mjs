/**
 * No DB call, ciphertext read or credential logging. Shell must call this
 * before any psql, age or pg_restore invocation.
 */
import {lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateR38RestoreTarget}
  from '../src/guest-r38-dr-preflight.mjs';
export async function preflightR38DirectRestore({dbUrl,key,archive}={}){
  const paths=[archive,key,
    typeof archive==='string'?archive+'.sha256':null];
  const stats=await Promise.all(paths.map(p=>{
    if(typeof p!=='string'||!p.startsWith('/'))
      throw Error('All archive/key paths must be absolute');
    return lstat(p);
  }));
  return evaluateR38RestoreTarget({
    dbUrl,key,archive,archiveStat:stats[0],
    keyStat:stats[1],checksumStat:stats[2]
  });
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3)throw Error('Expected absolute archive path');
    const checked=await preflightR38DirectRestore({
      dbUrl:process.env.DR_RESTORE_DB_URL,
      key:process.env.AGE_IDENTITY_FILE,archive:process.argv[2]});
    if(!checked.valid)throw Error('Refused non-disposable DR target');
    process.stdout.write('R38 direct restore preflight accepted local disposable scope\n');
  }catch{
    process.stderr.write('R38 direct restore NO-GO: untrusted local target or files\n');
    process.exitCode=2;
  }
}
