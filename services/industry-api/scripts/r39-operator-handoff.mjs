/**
 * Bounded offline-only operator report: accepts no token, archive, key,
 * path or raw PII in output. Evidence JSON is NOT itself a trusted signature.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildR39OperatorHandoff}
  from '../src/guest-r39-operator-handoff.mjs';
async function readBoundedStdin(max=131072){
  let size=0,buffers=[];
  for await(const chunk of process.stdin){
    size+=chunk.length;
    if(size>max)throw Error('Evidence input exceeds 128 KiB');
    buffers.push(chunk);
  }
  return JSON.parse(Buffer.concat(buffers).toString('utf8'));
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--stdin')
      throw Error('Use --stdin only');
    const input=await readBoundedStdin();
    const result=buildR39OperatorHandoff(input);
    process.stdout.write(JSON.stringify(result)+'\n');
    if(result.productionAuthorized!==false)process.exitCode=2;
  }catch{
    process.stderr.write('R39 operator NO-GO: invalid offline evidence input\n');
    process.exitCode=2;
  }
}
