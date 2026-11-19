// Synthetic-only fixture for the real HTTP R7/R10/R15 acceptance suites.
// Uses private temporary paths, ephemeral signing keys, never real customer data.
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {evidenceDigest,attestationMessage,REQUIRED_EVIDENCE,ADMISSION_SCHEMA}
  from '../scripts/r14-admission.mjs';
import {permitMessage,PERMIT_SCHEMA}
  from '../src/guest-tenant-authorization.mjs';

const ENV=['GUEST_RELEASE_COMMIT','GUEST_R15_ADMISSION_FILE','GUEST_R15_PERMIT_FILE',
  'GUEST_R15_OWNER_PUBLIC_KEY','GUEST_R15_MANAGER_PUBLIC_KEY'];
export async function syntheticPermit(tenantId,now=new Date()){
  const dir=await mkdtemp(join(tmpdir(),'guest-r15-ci-'));
  const before=Object.fromEntries(ENV.map(key=>[key,process.env[key]]));
  const keys={owner:generateKeyPairSync('ed25519'),manager:generateKeyPairSync('ed25519')};
  const commit='a'.repeat(40);
  const time=new Date(now.getTime()-60000).toISOString();
  const later=new Date(now.getTime()+HOURS(2)).toISOString();
  const evidence=Object.fromEntries(REQUIRED_EVIDENCE.map(key=>[key,
    {ok:true,sha256:'b'.repeat(64),observedAt:time}]));
  const admission={schema:ADMISSION_SCHEMA,releaseCommit:commit,evidence};
  const evidenceSha=evidenceDigest(admission);
  admission.attestations=['owner','manager'].map(role=>{
    const a={role,actorId:role+'-ci-human',releaseCommit:commit,evidenceDigest:evidenceSha,
      acceptedAt:time,expiresAt:later};
    return {...a,signature:sign(null,Buffer.from(attestationMessage(a)),
      keys[role].privateKey).toString('base64')};
  });
  const permit={schema:PERMIT_SCHEMA,tenantId,releaseCommit:commit,
    admissionDigest:evidenceSha,issuedAt:time,expiresAt:later};
  permit.attestations=['owner','manager'].map(role=>{
    const a={role,actorId:role+'-ci-human'};
    return {...a,signature:sign(null,Buffer.from(permitMessage(permit,a)),
      keys[role].privateKey).toString('base64')};
  });
  const files={
    GUEST_R15_ADMISSION_FILE:join(dir,'admission.json'),
    GUEST_R15_PERMIT_FILE:join(dir,'permit.json'),
    GUEST_R15_OWNER_PUBLIC_KEY:join(dir,'owner.pub.pem'),
    GUEST_R15_MANAGER_PUBLIC_KEY:join(dir,'manager.pub.pem')
  };
  await Promise.all([
    writeFile(files.GUEST_R15_ADMISSION_FILE,JSON.stringify(admission),{mode:0o600}),
    writeFile(files.GUEST_R15_PERMIT_FILE,JSON.stringify(permit),{mode:0o600}),
    writeFile(files.GUEST_R15_OWNER_PUBLIC_KEY,keys.owner.publicKey.export({type:'spki',format:'pem'}),{mode:0o600}),
    writeFile(files.GUEST_R15_MANAGER_PUBLIC_KEY,keys.manager.publicKey.export({type:'spki',format:'pem'}),{mode:0o600})
  ]);
  Object.assign(process.env,files,{GUEST_RELEASE_COMMIT:commit});
  return {
    permit,admission,keys,files,
    cleanup:async()=>{
      for(const key of ENV){
        if(before[key]===undefined)delete process.env[key];
        else process.env[key]=before[key];
      }
      await rm(dir,{recursive:true,force:true});
    }
  };
}
function HOURS(n){return n*3600000;}
