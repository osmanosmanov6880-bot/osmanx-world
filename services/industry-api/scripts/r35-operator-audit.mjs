/**
 * Offline bounded operator package. Reads local signed files/AGE archive bytes,
 * never decrypts, never contacts host, never uploads docs or PII.
 */
import {lstat,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditR35ArchiveBytes}
  from '../src/guest-r35-archive-bytes.mjs';
import {auditR35LegalDocumentBytes}
  from '../src/guest-r35-document-bytes.mjs';
import {evaluateR35OperatorHandoff}
  from '../src/guest-r35-handoff.mjs';
const LIMIT=256*1024;
const roles=['authorized_client','data_protection_reviewer',
  'independent_recovery_auditor','offsite_custodian'];
const inputKeys=['source','review','staging','custody','custodyStatements',
  'client','clientStatements','archiveFiles','documentFiles'];
export async function runR35OperatorAudit({
  stream=process.stdin,
  trustFile=process.env.R35_TRUSTED_PUBLIC_KEYS_FILE,
  now=new Date()}={}){
  if(typeof trustFile!=='string'||!trustFile.startsWith('/')||
    trustFile.length>512)throw Error('Absolute pinned public key file needed');
  const stat=await lstat(trustFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||
    stat.size>32768||(stat.mode&0o022)!==0)
    throw Error('Invalid operator trust file permissions');
  const trustedKeys=JSON.parse(await readFile(trustFile,'utf8'));
  if(!trustedKeys||typeof trustedKeys!=='object'||
    Array.isArray(trustedKeys)||
    Object.keys(trustedKeys).sort().join('|')!==roles.join('|'))
    throw Error('Four independent pinned signer public keys required');
  let size=0;const chunks=[];
  for await(const part of stream){
    const bytes=Buffer.isBuffer(part)?part:Buffer.from(part);
    size+=bytes.length;
    if(size>LIMIT)throw Error('R35 evidence larger than 256KiB');
    chunks.push(bytes);
  }
  if(size<2)throw Error('Empty R35 evidence');
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!input||typeof input!=='object'||Array.isArray(input)||
    Object.keys(input).sort().join('|')!==inputKeys.slice().sort().join('|'))
    throw Error('Unexpected R35 input fields');
  const archive=await auditR35ArchiveBytes({
    custody:input.custody,statements:input.custodyStatements,
    trustedKeys,archiveFiles:input.archiveFiles,now
  });
  const documents=await auditR35LegalDocumentBytes({
    client:input.client,statements:input.clientStatements,
    trustedKeys,documentFiles:input.documentFiles,now
  });
  const result=evaluateR35OperatorHandoff({
    ...input,archive,documents,now});
  return {schema:result.schema,sha256:result.sha256,
    firstPendingPr:result.firstPendingPr,
    manualNextAction:result.manualNextAction,
    eligibleForIndependentHumanReview:
      result.eligibleForIndependentHumanReview,
    customerGo:false,productionAuthorized:false,
    blockers:result.blockers};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--offline')
      throw Error('Use --offline with redacted evidence JSON on stdin');
    const out=await runR35OperatorAudit();
    process.stdout.write(JSON.stringify(out)+'\n');
    if(!out.eligibleForIndependentHumanReview)process.exitCode=2;
  }catch(error){
    process.stderr.write('R35 operator audit NO-GO: '+error.message+'\n');
    process.exitCode=2;
  }
}
