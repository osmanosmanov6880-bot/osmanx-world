/**
 * Fail-closed operator CLI, no live DB interaction or credential output.
 * The caller snapshots bytes into an operator-only directory before calling.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyR40Archive}
  from '../src/guest-r40-archive-integrity.mjs';
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==4)throw Error('R40 requires archive and AGE identity');
    const report=await verifyR40Archive({
      archive:process.argv[2],identityFile:process.argv[3]});
    process.stdout.write(JSON.stringify(report)+'\n');
  }catch{
    process.stderr.write('R40 archive integrity: NO-GO\n');
    process.exitCode=2;
  }
}
