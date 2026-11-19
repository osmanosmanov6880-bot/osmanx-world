// R18 synthetic, independent external-custodian evidence. All keys/files are
// ephemeral and located OUTSIDE the checkout, never used for a real pilot.
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syntheticR17} from './r17-synthetic-fixture.mjs';
import {loadR17Witness} from '../src/guest-r17-witness.mjs';
import {anchorPlan} from '../src/guest-r18-anchor.mjs';
import {signExternalAnchor} from '../scripts/r18-anchor-signer.mjs';

async function privateWrite(path,value){
  await writeFile(path,value,{mode:0o600});
}
export async function syntheticR18(tenantIds,{now=new Date()}={}){
  const r17=await syntheticR17(tenantIds,{now});
  const root=await mkdtemp(join(tmpdir(),'osmanx-r18-ci-'));
  const custodianDir=join(root,'external-custodian');
  const trustDir=join(root,'pinned-trust');
  await Promise.all([custodianDir,trustDir].map(path=>mkdir(path,{mode:0o700})));
  const anchorFile=join(custodianDir,'anchor.json');
  const publicFile=join(trustDir,'custodian.pub.pem');
  const custodian=generateKeyPairSync('ed25519');
  await privateWrite(publicFile,custodian.publicKey.export({type:'spki',format:'pem'}));
  const env={...r17.env,
    GUEST_R18_ANCHOR_FILE:anchorFile,
    GUEST_R18_CUSTODIAN_PUBLIC_KEY:publicFile,
    GUEST_R18_MIN_REVISION:'1',GUEST_R18_MIN_SEQUENCE:'1'
  };
  let value=null,index=0;
  async function publishAnchor(at=now){
    const witness=await loadR17Witness(env,at);
    const plan=anchorPlan({...witness,releaseCommit:env.GUEST_RELEASE_COMMIT},{
      now:at,minutes:90,actorId:'external-auditor'
    });
    const receipt=signExternalAnchor(plan,
      custodian.privateKey.export({type:'pkcs8',format:'pem'}));
    const temporary=anchorFile+'.'+(++index)+'.tmp';
    await privateWrite(temporary,JSON.stringify(receipt));
    await rename(temporary,anchorFile);
    value=receipt;
    return receipt;
  }
  await publishAnchor(now);
  return {r17,root,now,env,custodian,anchorFile,publicFile,
    get anchor(){return value;},
    publishAnchor,
    revoke:async tenantId=>{
      const revoked=await r17.revoke(tenantId,'security_incident',{at:now});
      await publishAnchor(now);
      return revoked;
    },
    cleanup:async()=>{
      await rm(root,{recursive:true,force:true});
      await r17.cleanup();
    }
  };
}
