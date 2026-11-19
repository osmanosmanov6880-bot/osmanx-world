/**
 * R18 evidence export and independent offline integrity verification.
 * NO network upload and NO DB mutation. Operator must copy proof into their
 * separately administered encrypted and retention-locked storage.
 */
import {open,realpath} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readOutsideCheckout} from '../src/guest-tenant-authorization.mjs';
import {loadR17Witness} from '../src/guest-r17-witness.mjs';
import {loadR18Anchor} from '../src/guest-r18-anchor.mjs';
import {createPortableProof,verifyPortableProof} from '../src/guest-r18-proof.mjs';

const inputs={
  registry:'GUEST_R16_REGISTRY_FILE',
  journal:'GUEST_R17_JOURNAL_FILE',
  ownerWitness:'GUEST_R17_OWNER_WITNESS_FILE',
  managerWitness:'GUEST_R17_MANAGER_WITNESS_FILE',
  anchor:'GUEST_R18_ANCHOR_FILE'
};
const publicKeys={
  platformOwner:'GUEST_R16_OWNER_PUBLIC_KEY',
  platformManager:'GUEST_R16_MANAGER_PUBLIC_KEY',
  witnessOwner:'GUEST_R17_OWNER_PUBLIC_KEY',
  witnessManager:'GUEST_R17_MANAGER_PUBLIC_KEY',
  custodian:'GUEST_R18_CUSTODIAN_PUBLIC_KEY'
};
async function loadTrustedKeys(env){
  const result={};
  for(const [key,name] of Object.entries(publicKeys)){
    if(typeof env[name]!=='string')throw Error('Required independent public key unavailable');
    result[key]=await readOutsideCheckout(env[name]);
  }
  return result;
}
async function writeNew(path,text){
  if(typeof path!=='string'||!path.startsWith('/'))
    throw Error('Absolute external output file required');
  const full=resolve(path),parent=dirname(full),actual=await realpath(parent);
  const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
  if(actual!==parent||full===root||full.startsWith(root+sep))
    throw Error('Private proof cannot be stored inside checkout or symlinked directory');
  const handle=await open(full,'wx',0o600);
  try{await handle.writeFile(text);await handle.sync();}
  finally{await handle.close();}
}
export async function exportProof(env=process.env,now=new Date()){
  const witness=await loadR17Witness(env,now);
  await loadR18Anchor(env,witness,now);
  const records={};
  for(const [field,envName] of Object.entries(inputs))
    records[field]=JSON.parse(await readOutsideCheckout(env[envName],{privateFile:true}));
  const proof=createPortableProof(records,env.GUEST_RELEASE_COMMIT,now);
  const verified=verifyPortableProof(proof,await loadTrustedKeys(env),{
    now,releaseCommit:env.GUEST_RELEASE_COMMIT,
    minRevision:Math.max(Number(env.GUEST_R16_MIN_REVISION),
      Number(env.GUEST_R17_MIN_REVISION),Number(env.GUEST_R18_MIN_REVISION)),
    minSequence:Math.max(Number(env.GUEST_R17_MIN_SEQUENCE),
      Number(env.GUEST_R18_MIN_SEQUENCE))
  });
  if(!verified.valid)throw Error('Refusing invalid exported evidence');
  return {proof,report:verified};
}
export async function verifyProofFile(path,env=process.env,now=new Date()){
  const proof=JSON.parse(await readOutsideCheckout(path,{privateFile:true}));
  return verifyPortableProof(proof,await loadTrustedKeys(env),{
    now,releaseCommit:env.GUEST_RELEASE_COMMIT,
    minRevision:Math.max(Number(env.GUEST_R16_MIN_REVISION),
      Number(env.GUEST_R17_MIN_REVISION),Number(env.GUEST_R18_MIN_REVISION)),
    minSequence:Math.max(Number(env.GUEST_R17_MIN_SEQUENCE),
      Number(env.GUEST_R18_MIN_SEQUENCE))
  });
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    const [command,path,...rest]=process.argv.slice(2);
    if(rest.length||!path||!['export','verify'].includes(command))
      throw Error('Usage: export|verify /private/non-pii-proof.json');
    if(command==='export'){
      const {proof,report}=await exportProof();
      await writeNew(path,JSON.stringify(proof)+'\n');
      process.stdout.write(JSON.stringify({
        proofDigest:report.proofDigest,sequence:report.sequence,
        externalUploadCompleted:false,changedProduction:false
      })+'\n');
    }else{
      const result=await verifyProofFile(path);
      process.stdout.write(JSON.stringify(result)+'\n');
      if(!result.valid)process.exitCode=2;
    }
  }catch{
    process.stderr.write('R18 proof operation refused; verify private paths and independent trusted keys. No data changed.\n');
    process.exitCode=2;
  }
}
