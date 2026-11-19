/**
 * Offline CLI reading bounded redacted evidence from stdin and pre-pinned
 * trusted public keys from a distinct, operator-owned local file. NO network.
 * No private keys, tokens, backups, plaintext PII or evidence upload.
 * Exit code 0 denotes metadata eligible for human audit, NOT production GO.
 */
import {readFile,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateR32Preflight} from '../src/guest-r32-preflight.mjs';
const MAX_BYTES=512*1024;
async function readBoundedStdin(stream=process.stdin){
  let bytes=0,parts=[];
  for await(const chunk of stream){
    bytes+=chunk.length;
    if(bytes>MAX_BYTES)throw Error('Evidence packet exceeds 512KiB');
    parts.push(chunk);
  }
  if(bytes===0)throw Error('Empty evidence packet');
  return Buffer.concat(parts).toString('utf8');
}
export async function runR32OfflineCli({stdin=process.stdin,
  trustedKeysFile=process.env.R32_TRUSTED_PUBLIC_KEYS_FILE,
  now=new Date()}={}){
  if(typeof trustedKeysFile!=='string'||!trustedKeysFile||
    !trustedKeysFile.startsWith('/')||trustedKeysFile.length>512)
    throw Error('Absolute operator-owned trusted public keys file required');
  const stat=await lstat(trustedKeysFile);
  if(!stat.isFile()||stat.size>32768||
    (stat.mode&0o022)!==0)
    throw Error('Trusted keys file must be regular and not group/world writable');
  const trusted=JSON.parse(await readFile(trustedKeysFile,'utf8'));
  if(!trusted||typeof trusted!=='object'||Array.isArray(trusted)||
    Object.keys(trusted).sort().join('|')!=='recovery_lead|release_manager')
    throw Error('Trusted keys must be independently pinned for exactly two roles');
  const doc=JSON.parse(await readBoundedStdin(stdin));
  if(!doc||typeof doc!=='object'||Array.isArray(doc)||
    Object.keys(doc).sort().join('|')!==
      'dr|first|plan|recovery|second|signatures|source')
    throw Error('Unexpected offline evidence fields');
  const out=evaluateR32Preflight({...doc,publicKeys:trusted,now});
  // Avoid dumping original evidence or host responses to stdout.
  return {schema:out.schema,sha256:out.sha256,
    eligibleForHumanAudit:out.eligibleForHumanAudit,
    customerGo:false,productionAuthorized:false,blockers:out.blockers};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--offline')
      throw Error('Use --offline with evidence JSON on stdin');
    const out=await runR32OfflineCli();
    process.stdout.write(JSON.stringify(out)+'\n');
    if(!out.eligibleForHumanAudit)process.exitCode=2;
  }catch(error){
    process.stderr.write('R32 preflight blocked: '+error.message+'\n');
    process.exitCode=2;
  }
}
