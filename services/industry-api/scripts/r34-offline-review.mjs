/** Operator-only, no-network acceptance packet. 4 independently pinned keys. */
import {lstat,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {evaluateR34Acceptance}
  from '../src/guest-r34-acceptance.mjs';
const ROLES=['authorized_client','data_protection_reviewer',
  'independent_recovery_auditor','offsite_custodian'];
const LIMIT=256*1024;
export async function runR34OfflineReview({stream=process.stdin,
  trustFile=process.env.R34_TRUSTED_PUBLIC_KEYS_FILE,
  now=new Date()}={}){
  if(typeof trustFile!=='string'||!trustFile.startsWith('/')||
    trustFile.length>512)throw Error('Absolute operator keys path required');
  const stat=await lstat(trustFile);
  if(!stat.isFile()||stat.size<1||stat.size>32768||
    (stat.mode&0o022)!==0)
    throw Error('Pinned keys must be a safe, regular read-only operator file');
  const keys=JSON.parse(await readFile(trustFile,'utf8'));
  if(!keys||typeof keys!=='object'||Array.isArray(keys)||
    Object.keys(keys).sort().join('|')!==ROLES.join('|'))
    throw Error('Exactly four external role public keys required');
  let bytes=0;const parts=[];
  for await(const chunk of stream){
    const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    bytes+=buffer.length;
    if(bytes>LIMIT)throw Error('R34 evidence exceeds 256KiB');
    parts.push(buffer);
  }
  if(bytes<2)throw Error('Empty R34 evidence');
  const evidence=JSON.parse(Buffer.concat(parts).toString('utf8'));
  const decision=evaluateR34Acceptance({evidence,trustedKeys:keys,now});
  return {schema:decision.schema,sha256:decision.sha256,
    canSubmitToHumanAudit:decision.canSubmitToHumanAudit,
    blockers:decision.blockers,productionAuthorized:false,
    customerGo:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--offline')
      throw Error('Use --offline, JSON evidence via stdin');
    const result=await runR34OfflineReview();
    process.stdout.write(JSON.stringify(result)+'\n');
    if(!result.canSubmitToHumanAudit)process.exitCode=2;
  }catch(error){
    process.stderr.write('R34 independent review blocked: '+error.message+'\n');
    process.exitCode=2;
  }
}
