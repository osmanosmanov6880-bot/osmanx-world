// R16 synthetic multi-company evidence: private, throwaway Ed25519 keys and JSON.
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {evidenceDigest,attestationMessage,REQUIRED_EVIDENCE,ADMISSION_SCHEMA}
  from '../scripts/r14-admission.mjs';
import {permitMessage,PERMIT_SCHEMA}
  from '../src/guest-tenant-authorization.mjs';
import {R16_SCHEMA,registryMessage} from '../src/guest-r16-registry.mjs';

const commit='a'.repeat(40);
const keys=()=>({owner:generateKeyPairSync('ed25519'),
  manager:generateKeyPairSync('ed25519')});
const pem=k=>k.publicKey.export({type:'spki',format:'pem'});
const signature=(key,message)=>sign(null,Buffer.from(message,'utf8'),key.privateKey).toString('base64');
const sorted=xs=>xs.sort((a,b)=>a.tenantId.localeCompare(b.tenantId));
async function privateWrite(path,value){
  await writeFile(path,value,{mode:0o600});
}
export async function syntheticR16Registry(tenantIds,{now=new Date()}={}){
  const root=await mkdtemp(join(tmpdir(),'osmanx-r16-ci-'));
  const operators=keys();
  const issuedAt=new Date(now.getTime()-60000).toISOString();
  const expiresAt=new Date(now.getTime()+2*3600000).toISOString();
  const tenants=sorted(tenantIds.map(tenantId=>({tenantId})));
  const registryFile=join(root,'registry.json');
  await privateWrite(join(root,'platform-owner.pub.pem'),pem(operators.owner));
  await privateWrite(join(root,'platform-manager.pub.pem'),pem(operators.manager));
  for(const {tenantId} of tenants){
    const dir=join(root,'tenants',tenantId);
    await mkdir(dir,{recursive:true,mode:0o700});
    const pair=keys();
    const evidence=Object.fromEntries(REQUIRED_EVIDENCE.map(x=>[x,
      {ok:true,sha256:'b'.repeat(64),observedAt:issuedAt}]));
    const admission={schema:ADMISSION_SCHEMA,releaseCommit:commit,evidence};
    const sha=evidenceDigest(admission);
    admission.attestations=['owner','manager'].map(role=>{
      const p={role,actorId:role+'-tenant-'+tenantId.slice(0,8),
        releaseCommit:commit,evidenceDigest:sha,acceptedAt:issuedAt,expiresAt};
      return {...p,signature:signature(pair[role],attestationMessage(p))};
    });
    const permit={schema:PERMIT_SCHEMA,tenantId,releaseCommit:commit,
      admissionDigest:sha,issuedAt,expiresAt};
    permit.attestations=['owner','manager'].map(role=>{
      const p={role,actorId:role+'-tenant-'+tenantId.slice(0,8)};
      return {...p,signature:signature(pair[role],permitMessage(permit,p))};
    });
    await Promise.all([
      privateWrite(join(dir,'admission.json'),JSON.stringify(admission)),
      privateWrite(join(dir,'permit.json'),JSON.stringify(permit)),
      privateWrite(join(dir,'owner.pub.pem'),pem(pair.owner)),
      privateWrite(join(dir,'manager.pub.pem'),pem(pair.manager))
    ]);
  }
  const unsigned={schema:R16_SCHEMA,releaseCommit:commit,revision:1,
    issuedAt,expiresAt,tenants,revoked:[]};
  const signRecord=value=>({
    ...value,attestations:['owner','manager'].map(role=>{
      const p={role,actorId:'r16-platform-'+role};
      return {...p,signature:signature(operators[role],registryMessage(value,p))};
    })
  });
  let current=signRecord(unsigned),index=0;
  async function publish(record){
    const temporary=join(root,'registry.'+(++index)+'.tmp');
    await privateWrite(temporary,JSON.stringify(record));
    await rename(temporary,registryFile);
    current=record;return current;
  }
  await publish(current);
  const env={
    NODE_ENV:'production',GUEST_WRITES_ENABLED:'true',GUEST_RELEASE_COMMIT:commit,
    GUEST_R16_REGISTRY_FILE:registryFile,
    GUEST_R16_OWNER_PUBLIC_KEY:join(root,'platform-owner.pub.pem'),
    GUEST_R16_MANAGER_PUBLIC_KEY:join(root,'platform-manager.pub.pem'),
    GUEST_R16_MIN_REVISION:'1'
  };
  return {
    root,env,now,operators,
    get registry(){return current;},
    signRecord,publish,
    update:async change=>{
      const revision=current.revision+1;
      return publish(signRecord({...current,...change,revision,
        attestations:undefined}));
    },
    cleanup:async()=>rm(root,{recursive:true,force:true})
  };
}
