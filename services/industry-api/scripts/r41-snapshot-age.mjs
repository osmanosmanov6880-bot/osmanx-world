/**
 * Local-only operator CLI: accepts paths as arguments, never logs them.
 * Invoked by restore-dr.sh with a private mktemp -d destination.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshotR41Age} from '../src/guest-r41-age-snapshot.mjs';
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==5)
      throw Error('R41 archive, identity and private destination required');
    const result=await snapshotR41Age({
      archive:process.argv[2],identityFile:process.argv[3],
      destinationDir:process.argv[4]
    });
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch{
    process.stderr.write('R41 encrypted snapshot NO-GO\n');
    process.exitCode=2;
  }
}
