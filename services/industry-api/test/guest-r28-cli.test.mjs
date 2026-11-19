import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {runR28OfflineEvidenceCli} from '../scripts/r28-verify-evidence.mjs';
import {
  R28_EVIDENCE_SCHEMA,ROLES,r28SigningBytes
} from '../src/guest-r28-attestations.mjs';
test('R28 operator CLI verifies four real public PEM files with no network or private keys',async()=>{
  const root=await mkdtemp(join(tmpdir(),'osmanx-r28-'));
  const files=['receipts.json','public-keys.json','identity.json']
    .map(name=>join(root,name));
  try{
    const now=Date.now(),identity={
      tenantId:randomUUID(),pilotId:randomUUID(),
      releaseSha:'a'.repeat(40),r27HandoffSha:'b'.repeat(64),
      expiresAt:new Date(now+10*60000).toISOString()
    };
    const publicKeys={},receipts=[];
    for(const [index,role] of ROLES.entries()){
      const key=generateKeyPairSync('ed25519');
      publicKeys[role]=key.publicKey.export({type:'spki',format:'pem'});
      const record={role,decision:'reviewed',
        evidenceSha:String(index+1).repeat(64),
        observedAt:new Date(now-1000).toISOString()};
      receipts.push({...record,signature:sign(null,
        r28SigningBytes(record,identity),key.privateKey).toString('base64')});
    }
    const packet={schema:R28_EVIDENCE_SCHEMA,receipts};
    for(const [file,value] of [
      [files[0],packet],[files[1],publicKeys],[files[2],identity]
    ])await writeFile(file,JSON.stringify(value),{mode:0o600});
    const answer=await runR28OfflineEvidenceCli(['--verify',...files]);
    assert.equal(answer.cryptographicReceiptsVerified,true,
      JSON.stringify(answer.blockers));
    assert.equal(answer.customerGo,false);
    assert.equal(answer.permissionToDeploy,false);
    await writeFile(files[0],JSON.stringify({...packet,receipts:[
      {...receipts[0],evidenceSha:'f'.repeat(64)},...receipts.slice(1)
    ]}),{mode:0o600});
    const changed=await runR28OfflineEvidenceCli(['--verify',...files]);
    assert.equal(changed.cryptographicReceiptsVerified,false);
    const link=join(root,'symlink.json');
    await symlink(files[2],link);
    await assert.rejects(
      runR28OfflineEvidenceCli(['--verify',files[0],files[1],link]));
    await assert.rejects(runR28OfflineEvidenceCli([
      '--verify',files[0],files[1],'/etc/passwd'
    ]));
  }finally{await rm(root,{recursive:true,force:true});}
});
