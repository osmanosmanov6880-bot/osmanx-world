/**
 * R14 canary operator guard, read-only. No secrets in output; run BEFORE Docker.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkR37CanaryPreflight} from '../src/guest-r37-canary-guard.mjs';
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==4)throw Error('Use absolute private env and compose paths');
    const result=await checkR37CanaryPreflight({
      envPath:process.argv[2],composePath:process.argv[3],
      checkoutRoot:root});
    process.stdout.write(JSON.stringify(result)+'\n');
    if(!result.valid)process.exitCode=2;
  }catch(e){
    process.stderr.write('R37 canary preflight NO-GO: '+e.message+'\n');
    process.exitCode=2;
  }
}
