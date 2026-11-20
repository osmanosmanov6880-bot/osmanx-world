import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,chmod,symlink,link,rm,readFile}
  from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readR40Regular,openR40Regular}
  from '../src/guest-r40-secure-files.mjs';
import {canonicalR40Utc,validateR40ApprovalTimeline}
  from '../src/guest-r40-admission-timeline.mjs';
import {evaluateAdmission,evidenceDigest,attestationMessage,
  ADMISSION_SCHEMA,REQUIRED_EVIDENCE}
  from '../scripts/r14-admission.mjs';
import {inspectR40Sidecar,verifyR40Archive}
  from '../src/guest-r40-archive-integrity.mjs';
import {inspectR40UnifiedPatch}
  from '../src/guest-r40-patch-integrity.mjs';
import {inspectR39ComposePrivileges}
  from '../src/guest-r39-compose-boundaries.mjs';
import {buildR39FirstPrPacket}
  from '../src/guest-r39-review-packet.mjs';
const NOW=new Date('2026-11-20T12:00:00.000Z');
const SOURCE='840bb083e606058a9a32450f3b3a3e881a34891e';
const createTmp=()=>mkdtemp(join(tmpdir(),'osmanx-r40-'));
async function write600(p,data){
  await writeFile(p,data,{mode:0o600});await chmod(p,0o600);
}
function signedRecord(){
  const owner=generateKeyPairSync('ed25519');
  const manager=generateKeyPairSync('ed25519');
  const record={schema:ADMISSION_SCHEMA,releaseCommit:'a'.repeat(40),
    evidence:Object.fromEntries(REQUIRED_EVIDENCE.map(name=>[
      name,{ok:true,sha256:'b'.repeat(64),
        observedAt:'2026-11-20T09:00:00.000Z'}]))};
  const keys={owner:owner.publicKey.export({type:'spki',format:'pem'}),
    manager:manager.publicKey.export({type:'spki',format:'pem'})};
  function resign(){
    const hash=evidenceDigest(record);
    record.attestations=['owner','manager'].map((role,index)=>{
      const entry={role,actorId:role+'-human',
        releaseCommit:record.releaseCommit,evidenceDigest:hash,
        acceptedAt:'2026-11-20T10:00:00.000Z',
        expiresAt:'2026-11-21T10:00:00.000Z'};
      return {...entry,signature:sign(null,
        Buffer.from(attestationMessage(entry)),
        index===0?owner.privateKey:manager.privateKey).toString('base64')};
    });
  }
  resign();return {record,keys,resign};
}
test('R40 secure operator files reject symlinks, chmod errors, hardlinks, oversized bytes',async()=>{
  const base=await createTmp();
  try{
    const file=join(base,'decision.json');
    await write600(file,'{"schema":"synthetic"}');
    assert.equal(await readR40Regular(file,{privateFile:true}),
      '{"schema":"synthetic"}');
    const fd=await openR40Regular(file,{privateFile:true});
    assert.ok((await fd.stat()).isFile());await fd.close();
    const symlinkFile=join(base,'link.json');
    await symlink(file,symlinkFile);
    await assert.rejects(readR40Regular(symlinkFile,{privateFile:true}),
      /symlink/);
    const symlinkDir=join(base,'alias');
    const nested=join(base,'nested');await mkdir(nested);
    await write600(join(nested,'token.txt'),'private');
    await symlink(nested,symlinkDir,'dir');
    await assert.rejects(readR40Regular(join(symlinkDir,'token.txt'),
      {privateFile:true}),/symlink/);
    await chmod(file,0o644);
    await assert.rejects(readR40Regular(file,{privateFile:true}),
      /permission/);
    await write600(file,'x'.repeat(100));
    await assert.rejects(readR40Regular(file,{
      privateFile:true,maxBytes:32}),/size/);
    const alias=join(base,'hardlink');
    await link(file,alias);
    await assert.rejects(readR40Regular(file,{privateFile:true}),
      /identity/);
  }finally{await rm(base,{recursive:true,force:true})}
});
test('R40 signer chronology rejects invalid dates and evidence after signed approvals',()=>{
  assert.equal(canonicalR40Utc('2026-02-30T10:00:00Z'),false);
  assert.equal(canonicalR40Utc('2026-11-20T10:00:00Z'),true);
  const {record,keys,resign}=signedRecord();
  assert.equal(evaluateAdmission(record,keys,NOW).operatorGo,true);
  assert.equal(validateR40ApprovalTimeline(record,{now:NOW}).valid,true);
  record.evidence.lawfulBasis.observedAt='2026-11-20T11:00:00.000Z';
  resign();
  assert.equal(evaluateAdmission(record,keys,NOW).operatorGo,false);
  assert.ok(validateR40ApprovalTimeline(record,{now:NOW}).blockers.includes(
    'EVIDENCE_CREATED_AFTER_APPROVAL'));
  record.evidence.lawfulBasis.observedAt='2026-11-20T09:00:00.000Z';
  resign();
  record.attestations[0].unsignedUiGrant=true;
  assert.equal(evaluateAdmission(record,keys,NOW).operatorGo,false);
  assert.ok(validateR40ApprovalTimeline(record,{now:NOW}).blockers.includes(
    'UNSIGNED_OR_MISSING_ATTESTATION_FIELDS'));
});
test('R40 checksum binds AGE ciphertext basename and refuses arbitrary sidecars',()=>{
  const name='industry-20261120T010101Z-123.dump.age';
  const digest='f'.repeat(64);
  assert.equal(inspectR40Sidecar({
    filename:name,text:digest+'  '+name+'\n'}).valid,true);
  for(const bad of [
    digest+'  ../'+name+'\n',
    digest+'  other.dump.age\n',
    digest+'  '+name+'\n'+digest+'  '+name+'\n',
    '0'.repeat(64)+' *'+name+'\n',
    'not a digest',
  ])assert.equal(inspectR40Sidecar({filename:name,text:bad}).valid,false);
});
test('R40 AGE local snapshot hash verifies real bytes, refuses tamper/key permissions',async()=>{
  const base=await createTmp();
  try{
    const filename='industry-20261120T010101Z-123.dump.age';
    const archive=join(base,filename),key=join(base,'operator.key');
    const data=Buffer.from('synthetic ciphertext bytes, not real customer data');
    const digest=createHash('sha256').update(data).digest('hex');
    await write600(archive,data);
    await write600(archive+'.sha256',digest+'  '+filename+'\n');
    await write600(key,'synthetic-only-identity-not-a-real-age-key');
    const report=await verifyR40Archive({archive,identityFile:key});
    assert.equal(report.digest,digest);
    assert.equal(report.productionAuthorized,false);
    assert.equal(report.offsiteOriginAuthenticated,false);
    assert.ok(!JSON.stringify(report).includes(key));
    await write600(archive,Buffer.from('tampered ciphertext'));
    await assert.rejects(verifyR40Archive({archive,identityFile:key}),
      /corrupted/);
    await write600(archive,data);
    await chmod(key,0o644);
    await assert.rejects(verifyR40Archive({archive,identityFile:key}),
      /permission/);
    await chmod(key,0o600);
    await write600(archive+'.sha256',digest+'  unrelated.dump.age\n');
    await assert.rejects(verifyR40Archive({archive,identityFile:key}),
      /filename mismatch/);
  }finally{await rm(base,{recursive:true,force:true})}
});
test('R40 Compose script source requires exact trusted path and rejects object-shaped host routes',()=>{
  const allowed='/trusted/checkout/ops/provision-roles.sh';
  const services={};
  for(const name of ['db','provision','migrate','bootstrap','api'])
    services[name]={security_opt:['no-new-privileges:true'],volumes:[]};
  services.db.volumes=[{type:'volume',source:'guest_r14_data',
    target:'/var/lib/postgresql/data'}];
  services.provision.volumes=[{type:'bind',source:allowed,
    target:'/ops/provision-roles.sh',read_only:true}];
  for(const name of ['migrate','bootstrap']){
    services[name].read_only=true;services[name].profiles=['setup'];
  }
  services.api.read_only=true;services.api.init=true;services.api.tmpfs=['/tmp'];
  const config={services,volumes:{guest_r14_data:{}}};
  assert.equal(inspectR39ComposePrivileges(config,{
    expectedProvisionPath:allowed}).valid,true);
  assert.equal(inspectR39ComposePrivileges(config).valid,false);
  services.provision.volumes[0].source='/attacker/ops/provision-roles.sh';
  assert.equal(inspectR39ComposePrivileges(config,{
    expectedProvisionPath:allowed}).valid,false);
  services.provision.volumes[0].source=allowed;
  services.api.extra_hosts={'db':'192.0.2.1'};
  assert.equal(inspectR39ComposePrivileges(config,{
    expectedProvisionPath:allowed}).valid,false);
});
test('R40 unified patch requires complete hunks and exact GitHub changed lines',()=>{
  const full='@@ -10,3 +10,4 @@\n hello\n-old\n+new\n+plus\n world';
  const good=inspectR40UnifiedPatch(full,{additions:2,deletions:1});
  assert.equal(good.valid,true,JSON.stringify(good.blockers));
  assert.equal(good.hunks,1);
  assert.equal(inspectR40UnifiedPatch(full.slice(0,-7),{
    additions:2,deletions:1}).valid,false);
  assert.equal(inspectR40UnifiedPatch(full,{
    additions:3,deletions:1}).valid,false);
  assert.equal(inspectR40UnifiedPatch('@@ -0,0 +1,2 @@\n+first\n+second',{
    additions:2,deletions:0}).valid,true);
  assert.equal(inspectR40UnifiedPatch('@@ -0,0 +1,2 @@\n+first',{
    additions:2,deletions:0}).valid,false);
});
test('R40 PR47 packet refuses truncated patch even when list has exactly ten files',()=>{
  const files=[
    '.github/workflows/guest-r14-operations.yml',
    'docs/GUEST_INTELLIGENCE_R14.md',
    'services/industry-api/ops/build-release.sh',
    'services/industry-api/ops/compose.r14.yml',
    'services/industry-api/ops/r14-canary.sh',
    'services/industry-api/ops/verify-release.sh',
    'services/industry-api/scripts/r14-admission.mjs',
    'services/industry-api/scripts/r14-incident.mjs',
    'services/industry-api/scripts/r14-monitor.mjs',
    'services/industry-api/test/guest-r14.test.mjs'
  ].map(filename=>({filename,patch:'@@ -0,0 +1 @@\n+safe',
    additions:1,deletions:0,changes:1,status:'added'}));
  const fixture={pr:{number:47,state:'open',merged:false,
    head:{sha:SOURCE},base:{ref:'main'},changed_files:10},
    commit:{sha:SOURCE,tree:{sha:'a'.repeat(40)}},
    filesComplete:true,files};
  const good=buildR39FirstPrPacket(fixture);
  assert.equal(good.blockers.length,0,JSON.stringify(good.blockers));
  assert.equal(good.inventory.every(x=>x.allHunksVerified),true);
  const corrupted=[...files];
  corrupted[2]={...corrupted[2],patch:'@@ -0,0 +1,2 @@\n+safe'};
  const bad=buildR39FirstPrPacket({...fixture,files:corrupted});
  assert.ok(bad.blockers.includes('TRUNCATED_OR_INCONSISTENT_GITHUB_PATCH'));
  assert.equal(bad.automaticMergeAllowed,false);
});
test('R40 restore always verifies snapshotted ciphertext, not unchecked original path',async()=>{
  const script=await readFile(new URL('../ops/restore-dr.sh',import.meta.url),'utf8');
  assert.match(script,/r41-snapshot-age\.mjs/);
  assert.match(script,/r40-archive-check\.mjs/);
  assert.match(script,/age -d -i "\$AGE_IDENTITY_FILE" -o "\$tmp\/industry\.dump" "\$tmp\/\$name"/);
  assert.match(script,/pg_restore --single-transaction --exit-on-error/);
  assert.doesNotMatch(script,/sha256sum -c/);
});
