/**
 * R28 offline operator entrypoint: verify FOUR Ed25519 evidence receipts using
 * independently pinned PUBLIC keys. Never reads private keys, env secrets,
 * client records, live host or GitHub and never uploads any source documents.
 * Inputs MUST be regular local files OUTSIDE the application checkout.
 *
 * node scripts/r28-verify-evidence.mjs --verify \
 *   /secure/receipts.json /secure/public-keys.json /secure/identity.json
 */
import {lstat,readFile,realpath} from 'node:fs/promises';
import {resolve,sep,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyR28IndependentReceipts,ROLES}
  from '../src/guest-r28-attestations.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
async function boundedLocalJson(value,maxBytes){
  if(typeof value!=='string'||!value.startsWith('/')||value.includes('\0'))
    throw new Error('Absolute local file required');
  const named=resolve(value),stat=await lstat(named);
  if(!stat.isFile()||stat.size<1||stat.size>maxBytes||
     (stat.mode&0o022)!==0)
    throw new Error('Only bounded non-writable regular files accepted');
  const actual=await realpath(named);
  if(actual===root||actual.startsWith(root+sep))
    throw new Error('App source tree cannot be operator evidence storage');
  const text=await readFile(actual,'utf8');
  return JSON.parse(text);
}
export async function runR28OfflineEvidenceCli(argv=process.argv.slice(2)){
  if(!Array.isArray(argv)||argv.length!==4||argv[0]!=='--verify')
    throw new Error('Usage: --verify receipts.json keys.json identity.json');
  const [packet,publicKeys,identity]=await Promise.all([
    boundedLocalJson(argv[1],32768),boundedLocalJson(argv[2],32768),
    boundedLocalJson(argv[3],4096)
  ]);
  if(!publicKeys||typeof publicKeys!=='object'||
     Array.isArray(publicKeys)||Object.keys(publicKeys).sort().join('|')!==
     [...ROLES].sort().join('|')||
     !ROLES.every(role=>typeof publicKeys[role]==='string'&&
       publicKeys[role].startsWith('-----BEGIN PUBLIC KEY-----')&&
       publicKeys[role].length<2048))
    throw new Error('Four independently pinned public PEM keys required');
  return verifyR28IndependentReceipts({
    packet,publicKeys,identity,now:new Date()
  });
}
const direct=process.argv[1]&&
  resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    const answer=await runR28OfflineEvidenceCli();
    process.stdout.write(JSON.stringify(answer)+'\n');
    if(!answer.cryptographicReceiptsVerified)process.exitCode=2;
  }catch{
    process.stdout.write(JSON.stringify({
      schema:'osmanx.guest.r28.offline-verification.v1',
      cryptographicReceiptsVerified:false,
      blockers:['INVALID_OR_UNREADABLE_INDEPENDENT_RECEIPTS'],
      permissionToDeploy:false,customerGo:false
    })+'\n');
    process.exitCode=2;
  }
}
