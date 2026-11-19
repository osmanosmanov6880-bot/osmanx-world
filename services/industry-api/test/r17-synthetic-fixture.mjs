// Throwaway synthetic operator keys, R16 registry and R17 hash-chain / witnesses.
// Test-only: nothing from these fixtures is usable for a real customer.
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syntheticR16Registry} from './r16-synthetic-fixture.mjs';
import {JOURNAL_SCHEMA,GENESIS,eventDigest} from '../src/guest-r17-witness.mjs';
import {buildWitnessPlan,signWitnessPlan} from '../scripts/r17-witness-signer.mjs';

async function privateWrite(path,text){
  await writeFile(path,text,{mode:0o600});
}
export async function syntheticR17(tenantIds,{now=new Date()}={}){
  const fx=await syntheticR16Registry(tenantIds,{now});
  const root=await mkdtemp(join(tmpdir(),'osmanx-r17-ci-'));
  const keys={owner:generateKeyPairSync('ed25519'),
    manager:generateKeyPairSync('ed25519')};
  const privateDirs={owner:join(root,'operator-owner'),
    manager:join(root,'operator-manager'),journal:join(root,'journal-store')};
  await Promise.all(Object.values(privateDirs).map(p=>mkdir(p,{mode:0o700})));
  const journalFile=join(privateDirs.journal,'journal.json');
  const ownerFile=join(privateDirs.owner,'witness.json');
  const managerFile=join(privateDirs.manager,'witness.json');
  const keyFiles={owner:join(privateDirs.owner,'public.pem'),
    manager:join(privateDirs.manager,'public.pem')};
  for(const role of ['owner','manager'])
    await privateWrite(keyFiles[role],keys[role].publicKey.export({type:'spki',format:'pem'}));
  const events=[];
  const stamp=fx.registry.issuedAt;
  function append(event,tenantId,reasonCode,revision,occurredAt){
    const record={sequence:events.length+1,revision,event,tenantId,
      reasonCode,occurredAt,
      previousDigest:events.at(-1)?.digest||GENESIS};
    const complete={...record,digest:eventDigest(record)};
    events.push(complete);
    return complete;
  }
  for(const entry of fx.registry.tenants)
    append('enrolled',entry.tenantId,null,1,stamp);
  append('published',null,null,1,stamp);
  let journal={schema:JOURNAL_SCHEMA,entries:[...events]};
  let lastPlan;
  let fileCount=0;
  const atomic=async(path,value)=>{
    const temp=path+'.'+(++fileCount)+'.tmp';
    await privateWrite(temp,JSON.stringify(value));
    await rename(temp,path);
  };
  async function publishWitness(at=now){
    journal={schema:JOURNAL_SCHEMA,entries:[...events]};
    await atomic(journalFile,journal);
    const plan=buildWitnessPlan(fx.registry,journal,{now:at,expiresInMinutes:90});
    const parts={};
    for(const role of ['owner','manager']){
      parts[role]=signWitnessPlan(plan,{role,
        actorId:'r17-independent-'+role,
        privatePem:keys[role].privateKey.export({type:'pkcs8',format:'pem'})},at);
      await atomic(role==='owner'?ownerFile:managerFile,parts[role]);
    }
    lastPlan=plan;return {plan,parts};
  }
  await publishWitness();
  const env={...fx.env,
    GUEST_R17_JOURNAL_FILE:journalFile,
    GUEST_R17_OWNER_WITNESS_FILE:ownerFile,
    GUEST_R17_MANAGER_WITNESS_FILE:managerFile,
    GUEST_R17_OWNER_PUBLIC_KEY:keyFiles.owner,
    GUEST_R17_MANAGER_PUBLIC_KEY:keyFiles.manager,
    GUEST_R17_MIN_REVISION:'1',
    GUEST_R17_MIN_SEQUENCE:'1'
  };
  async function revoke(tenantId,reasonCode='security_incident',{at=now}={}){
    const revokedAt=new Date(at.getTime()-1000).toISOString();
    const next=[...fx.registry.revoked,{tenantId,reasonCode,revokedAt}]
      .sort((a,b)=>a.tenantId.localeCompare(b.tenantId));
    const rev=fx.registry.revision+1;
    await fx.update({revoked:next});
    append('revoked',tenantId,reasonCode,rev,revokedAt);
    append('published',null,null,rev,revokedAt);
    await publishWitness(at);
    return {revision:rev,sequence:events.length};
  }
  return {
    env,root,fx,now,keys,journalFile,ownerFile,managerFile,
    get journal(){return journal;},
    get plan(){return lastPlan;},
    publishWitness,revoke,
    cleanup:async()=>{await rm(root,{recursive:true,force:true});await fx.cleanup();}
  };
}
