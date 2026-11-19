/**
 * Offline review of signed, redacted evidence. No network and no uploads.
 * Trust anchors come exclusively from a separate operator-owned local file.
 * stdout is a compact NO-GO digest, not user-supplied raw evidence.
 */
import {readFile,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateR33ProofBundle}
  from '../src/guest-r33-proof-bundle.mjs';
const LIMIT=256*1024;
const ROLES=['client_representative','privacy_reviewer',
  'security_reviewer','staging_operator'];
async function readStdin(stream){
  let size=0;const chunks=[];
  for await(const part of stream){
    size+=part.length;
    if(size>LIMIT)throw Error('Evidence exceeds 256 KiB');
    chunks.push(part);
  }
  if(!size)throw Error('Evidence is empty');
  return Buffer.concat(chunks).toString('utf8');
}
export async function runR33OfflineReview({stream=process.stdin,
  trustFile=process.env.R33_TRUSTED_PUBLIC_KEYS_FILE,
  now=new Date()}={}){
  if(typeof trustFile!=='string'||!trustFile.startsWith('/')||
    trustFile.length>512)throw Error('Absolute trusted keys file required');
  const st=await lstat(trustFile);
  if(!st.isFile()||st.size>32768||st.size===0||
    (st.mode&0o022)!==0)
    throw Error('Trusted key file not an operator-owned regular file');
  const keys=JSON.parse(await readFile(trustFile,'utf8'));
  if(!keys||typeof keys!=='object'||Array.isArray(keys)||
    Object.keys(keys).sort().join('|')!==ROLES.join('|'))
    throw Error('Require exactly four independently pre-pinned public keys');
  const evidence=JSON.parse(await readStdin(stream));
  const result=evaluateR33ProofBundle({evidence,publicKeys:keys,now});
  return {schema:result.schema,sha256:result.sha256,
    humanReviewQueueEligible:result.humanReviewQueueEligible,
    customerGo:false,productionAuthorized:false,blockers:result.blockers};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--offline')
      throw Error('Use --offline with redacted JSON on stdin');
    const result=await runR33OfflineReview();
    process.stdout.write(JSON.stringify(result)+'\n');
    if(!result.humanReviewQueueEligible)process.exitCode=2;
  }catch(error){
    process.stderr.write('R33 review blocked: '+error.message+'\n');
    process.exitCode=2;
  }
}
