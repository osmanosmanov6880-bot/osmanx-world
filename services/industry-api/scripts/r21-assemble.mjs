/**
 * Assemble separately prepared R21 operator reports from private inputs.
 * The filesystem paths are supplied only by an authorized operator.
 * No cloud upload or production deployment; no raw private documents are
 * included in the generated output.
 */
import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeR21Bundle,verifyR21Bundle,writeR21Bundle}
  from './r21-evidence-bundle.mjs';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
async function readExternal(path){
  if(typeof path!=='string'||!path.startsWith('/')||resolve(path)!==path||
     path===ROOT||path.startsWith(ROOT+sep))throw Error('Private path required outside source');
  if(await realpath(dirname(path))!==dirname(path))throw Error('Symlinked input directory');
  const st=await lstat(path);
  if(!st.isFile()||st.isSymbolicLink()||st.size>100000||
     (st.mode&0o077)!==0)throw Error('Unsafe evidence source file');
  return JSON.parse(await readFile(path,'utf8'));
}
export async function assembleR21({
  tenantId,pilotId,releaseCommit,scopeDigest,inputPaths,output,
  now=new Date(),reader=readExternal,writer=writeR21Bundle
}={}){
  if(!UUID.test(tenantId||'')||!UUID.test(pilotId||'')||
     !COMMIT.test(releaseCommit||'')||!SHA.test(scopeDigest||'')||
     !inputPaths||typeof inputPaths!=='object'||
     Object.keys(inputPaths).sort().join(',')!==
       ['chain','database','host','restore','ticket'].sort().join(','))
    throw Error('Five separate R21 evidence reports required');
  const reports={};
  for(const key of ['chain','host','database','restore','ticket'])
    reports[key]=await reader(inputPaths[key]);
  const bundle=makeR21Bundle({
    tenantId,pilotId,releaseCommit,scopeDigest,reports,now
  });
  const verified=verifyR21Bundle(bundle,{
    now,releaseCommit,tenantId,pilotId,scopeDigest
  });
  if(!verified.valid)throw Error('R21 canonical evidence failed');
  // Export even an explicit NO-GO: it is valuable forensic evidence, not a
  // green-light capability. Offsite WORM transfer remains a human task.
  const saved=await writer(output,bundle);
  return {schema:'osmanx.guest.r21.assembly-receipt.v1',
    manifestDigest:bundle.manifestDigest,readinessBlockers:bundle.blockers,
    saved:saved.written===true,proofIntegrityVerified:verified.valid,
    offsiteUploadPerformed:false,legalGo:false,
    customerGo:false,productionChanged:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    const [tenantId,pilotId,releaseCommit,scopeDigest,
      chainPath,hostPath,dbPath,restorePath,ticketPath,output,...extra]=
      process.argv.slice(2);
    if(extra.length||!output)throw Error('Missing R21 evidence paths');
    const report=await assembleR21({tenantId,pilotId,releaseCommit,
      scopeDigest,inputPaths:{
        chain:chainPath,host:hostPath,database:dbPath,
        restore:restorePath,ticket:ticketPath},output});
    process.stdout.write(JSON.stringify(report)+'\n');
  }catch{
    process.stderr.write('R21 bundle assembly refused. Private reports not published, production unchanged.\n');
    process.exitCode=2;
  }
}
