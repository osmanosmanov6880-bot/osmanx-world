/**
 * No-credential, read-only, bounded local build-id probe. Never follows
 * redirects, does not touch customer routes, never accepts missing SHA.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateR38BuildIdentity}
  from '../src/guest-r38-build.mjs';
const URL='http://127.0.0.1:3150/api/industry/v1/health/build';
export async function runR38LocalBuildProbe({expectedSha,fetcher=fetch}={}){
  const response=await fetcher(URL,{method:'GET',redirect:'error',
    cache:'no-store',headers:{Accept:'application/json'},
    signal:AbortSignal.timeout(4000)});
  const contentType=response.headers.get('content-type')||'';
  const buf=Buffer.from(await response.arrayBuffer());
  if(buf.length>1024)throw Error('Build health response exceeded limit');
  let json=null;
  try{json=JSON.parse(buf.toString('utf8'))}catch{}
  const result=evaluateR38BuildIdentity({
    expectedSha,status:response.status,contentType,json});
  if(!result.valid)throw Error('Canary build identity drift');
  return result;
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3)throw Error('Expected source commit required');
    const out=await runR38LocalBuildProbe({expectedSha:process.argv[2]});
    process.stdout.write(JSON.stringify(out)+'\n');
  }catch{
    process.stderr.write('R38 canary running build did not match source\n');
    process.exitCode=2;
  }
}
