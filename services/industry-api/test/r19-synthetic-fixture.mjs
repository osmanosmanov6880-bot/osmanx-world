// Ephemeral private signing station and R18 evidence for R19 acceptance.
// All UUIDs, keys, protocol metadata and evidence hashes are synthetic.
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syntheticR18} from './r18-synthetic-fixture.mjs';
import {signR19Scope} from '../scripts/r19-operator.mjs';
import {SCOPE_SCHEMA,protocolDigest} from '../src/guest-r19-scope.mjs';

const sha=text=>createHash('sha256').update(text).digest('hex');
async function privateWrite(path,text){await writeFile(path,text,{mode:0o600});}
export async function syntheticR19(tenantIds,pilotId,protocol,{
  now=new Date(),maxDailyWrites=3,retentionDays=30
}={}){
  const r18=await syntheticR18(tenantIds,{now});
  const root=await mkdtemp(join(tmpdir(),'osmanx-r19-ci-'));
  const scopeDir=join(root,'scoped-pilot');
  const trustDir=join(root,'operator-trust');
  await Promise.all([scopeDir,trustDir].map(path=>mkdir(path,{mode:0o700})));
  const file=join(scopeDir,'scope.json'),stop=join(scopeDir,'STOP'),
    publicFile=join(trustDir,'operator.pub.pem');
  const operator=generateKeyPairSync('ed25519');
  await privateWrite(publicFile,operator.publicKey.export({type:'spki',format:'pem'}));
  const env={...r18.env,GUEST_R19_SCOPE_FILE:file,
    GUEST_R19_OPERATOR_PUBLIC_KEY:publicFile,GUEST_R19_STOP_FILE:stop,
    GUEST_R19_MIN_SEQUENCE:String(r18.anchor.journalSequence),
    GUEST_R19_ROLLOUT_ENABLED:'true'};
  let signed=null;
  let ordinal=0;
  async function publishScope(at=now){
    const r18Anchor=await (await import('../src/guest-r18-anchor.mjs'))
      .loadR18Anchor(env,null,at);
    const unsigned={schema:SCOPE_SCHEMA,tenantId:tenantIds[0],pilotId,
      releaseCommit:env.GUEST_RELEASE_COMMIT,
      checkpointDigest:r18Anchor.checkpointDigest,
      journalSequence:r18Anchor.sequence,
      protocolDigest:protocolDigest(protocol),
      policy:{purpose:'repeat_visit_aggregate_only',maxDailyWrites,retentionDays,
        contractEvidenceSha:sha('r19-synthetic-contract'),
        privacyEvidenceSha:sha('r19-synthetic-privacy'),
        consentEvidenceSha:sha('r19-synthetic-consent')},
      actorId:'r19-independent-reviewer',
      issuedAt:at.toISOString(),
      expiresAt:new Date(at.getTime()+24*3600000).toISOString()};
    signed=signR19Scope(unsigned,
      operator.privateKey.export({type:'pkcs8',format:'pem'}),{
        anchor:r18Anchor,env,now:at,
        externalPublicPem:r18.custodian.publicKey.export({type:'spki',format:'pem'}),
        externalActor:'external-auditor'
      });
    const temporary=file+'.'+(++ordinal)+'.tmp';
    await privateWrite(temporary,JSON.stringify(signed));
    await rename(temporary,file);
    return signed;
  }
  await publishScope();
  return {r18,root,operator,env,file,stop,now,
    get signed(){return signed;},
    publishScope,
    cleanup:async()=>{
      await rm(root,{recursive:true,force:true});await r18.cleanup();
    }
  };
}
