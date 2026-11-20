/** Bounded offline custodian signature verification. No external network. */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readR40Regular}
  from '../src/guest-r40-secure-files.mjs';
import {verifyR42Custody}
  from '../src/guest-r42-custody-proof.mjs';
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==6)
      throw Error('R42 requires private receipt, public key, hash and filename');
    const receipt=JSON.parse(await readR40Regular(process.argv[2],{
      privateFile:true,maxBytes:8192}));
    const pem=await readR40Regular(process.argv[3],{maxBytes:8192});
    const report=verifyR42Custody({
      receipt,publicKeyPem:pem,
      trustedKeySha:process.env.GUEST_R42_CUSTODIAN_SPKI_SHA256,
      expectedSha:process.argv[4],
      expectedName:process.argv[5],
      expectedBytes:Number(process.env.GUEST_R42_EXPECTED_ARCHIVE_BYTES)
    });
    process.stdout.write(JSON.stringify(report)+'\n');
    if(!report.claimValid)process.exitCode=2;
  }catch{
    process.stderr.write('R42 offline signed custody claim: NO-GO\n');
    process.exitCode=2;
  }
}
