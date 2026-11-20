/**
 * Read-only local Docker context endpoint policy, not a remote docker call.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateR38LocalDockerEndpoint}
  from '../src/guest-r38-compose.mjs';
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  const context=process.argv[2],endpoint=process.argv[3];
  const result=evaluateR38LocalDockerEndpoint({
    context,endpoint,uid:process.getuid?.()});
  if(!result.valid){
    process.stderr.write('R38 Docker endpoint refused (nonlocal)\n');
    process.exitCode=2;
  }
}
