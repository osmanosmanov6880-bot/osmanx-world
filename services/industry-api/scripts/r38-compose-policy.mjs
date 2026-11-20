/**
 * Called with "docker compose config --format json | node ... --stdin SHA".
 * Never prints parsed compose env/password values.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateR38ComposePolicy} from '../src/guest-r38-compose.mjs';
export async function inspectR38ComposeStdin({
  input=process.stdin,sha=process.argv[3]}={}){
  let total=0;const chunks=[];
  for await(const part of input){
    const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);
    total+=chunk.length;
    if(total>256*1024)throw Error('Resolved Docker config exceeds limit');
    chunks.push(chunk);
  }
  if(total<20)throw Error('Resolved config missing');
  let config;
  try{config=JSON.parse(Buffer.concat(chunks).toString('utf8'))}
  catch{throw Error('Resolved config is not valid JSON')}
  return evaluateR38ComposePolicy({config,expectedCommit:sha});
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==4||process.argv[2]!=='--stdin')
      throw Error('Usage: r38-compose-policy.mjs --stdin FULL_SOURCE_SHA');
    const out=await inspectR38ComposeStdin();
    process.stdout.write(JSON.stringify(out)+'\n');
    if(!out.valid)process.exitCode=2;
  }catch{
    // No user-supplied data from resolved Compose may enter logs.
    process.stderr.write('R38 resolved canary policy NO-GO\n');
    process.exitCode=2;
  }
}
