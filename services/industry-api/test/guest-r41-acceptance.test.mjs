import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,chmod,readFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {r41PublicKeyFingerprint,verifyR41KeyPins}
  from '../src/guest-r41-key-pins.mjs';
import {ADMISSION_SCHEMA,REQUIRED_EVIDENCE,evidenceDigest,attestationMessage}
  from '../scripts/r14-admission.mjs';
import {snapshotR41Age} from '../src/guest-r41-age-snapshot.mjs';
import {verifyR40Archive} from '../src/guest-r40-archive-integrity.mjs';
import {checkR38Compose} from '../scripts/r38-check-compose.mjs';
import {verifyR41FirstPrTree} from '../src/guest-r41-git-tree.mjs';
import {evaluateR41ReviewGate,renderR41ReviewerGuide}
  from '../src/guest-r41-review-gate.mjs';
const HEAD='840bb083e606058a9a32450f3b3a3e881a34891e';
const BASE='85e9fe290e354d113fd62787f5e8db90406f0961';
const SHA='a'.repeat(40);
const PRIVATE=async(p,s)=>{await writeFile(p,s,{mode:0o600});await chmod(p,0o600)};
function keys(){
  const a=generateKeyPairSync('ed25519'),b=generateKeyPairSync('ed25519');
  const owner=a.publicKey.export({type:'spki',format:'pem'});
  const manager=b.publicKey.export({type:'spki',format:'pem'});
  return {a,b,owner,manager,ownerPin:r41PublicKeyFingerprint(owner),
    managerPin:r41PublicKeyFingerprint(manager)};
}
function fixture(){
  const k=keys(),now=Date.now();
  const when=offset=>new Date(now+offset).toISOString();
  const record={schema:ADMISSION_SCHEMA,releaseCommit:SHA,
    evidence:Object.fromEntries(REQUIRED_EVIDENCE.map(name=>[name,{
      ok:true,sha256:'b'.repeat(64),observedAt:when(-120000)
    }]))};
  const digest=evidenceDigest(record);
  record.attestations=['owner','manager'].map((role,i)=>{
    const entry={role,actorId:role+'-human',releaseCommit:SHA,
      evidenceDigest:digest,acceptedAt:when(-60000),expiresAt:when(86400000)};
    return {...entry,signature:sign(null,Buffer.from(attestationMessage(entry)),
      i===0?k.a.privateKey:k.b.privateKey).toString('base64')};
  });
  return {...k,record};
}
function compose(){
  const services={};
  for(const name of ['db','provision','migrate','bootstrap','api'])
    services[name]={networks:{r14_private:{}},ports:[],
      security_opt:['no-new-privileges:true']};
  services.db.volumes=[{type:'volume',target:'/var/lib/postgresql/data',
    source:'osmanx-guest-r14-canary_guest_r14_data'}];
  services.provision.volumes=[{type:'bind',
    source:fileURLToPath(new URL('../ops/provision-roles.sh',import.meta.url)),
    target:'/ops/provision-roles.sh',read_only:true}];
  for(const name of ['migrate','bootstrap']){
    services[name].read_only=true;services[name].profiles=['setup'];
  }
  services.api.ports=[{host_ip:'127.0.0.1',published:3150,
    target:3047,protocol:'tcp'}];
  services.api.environment={GUEST_WRITES_ENABLED:'false',
    NODE_ENV:'production',PORT:'3047'};
  services.api.read_only=true;services.api.init=true;services.api.tmpfs=['/tmp'];
  return {name:'osmanx-guest-r14-canary',services,
    networks:{r14_private:{driver:'bridge'}},
    volumes:{guest_r14_data:{}}};
}
const paths=[
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
];
const sha=i=>String(i+1).padStart(40,'a');
function reviewFixture(){
  const files=paths.map((filename,i)=>({
    filename,sha:sha(i),status:'added',
    additions:1,deletions:0,changes:1,
    patch:'@@ -0,0 +1 @@\n+safe'
  }));
  const pr={number:47,state:'open',merged:false,draft:true,
    changed_files:10,head:{sha:HEAD},base:{ref:'main'},
    mergeable:false,mergeable_state:'unknown'};
  const commit={sha:HEAD,tree:{sha:'b'.repeat(40)}};
  const tree={sha:commit.tree.sha,truncated:false,
    tree:files.map(x=>({path:x.filename,type:'blob',sha:x.sha}))};
  const packet={schema:'osmanx.guest.r39.first-pr-review-packet.v1',
    pr:47,headSha:HEAD,fileCount:10,blockers:[],
    inventory:files.map(x=>({path:x.filename,allHunksVerified:true})),
    reviewSignal:{reviewSignalComplete:false},
    reviewChecklist:[{scope:'compose',path:paths[3],
      task:'Review loopback and disabled guest writes'}]};
  const mainRef={ref:'refs/heads/main',object:{sha:BASE}};
  return {files,pr,commit,tree,packet,mainRef};
}
test('R41 Ed25519 trust pins reject swapped keys, owner substitution and missing pins',()=>{
  const k=keys();
  assert.equal(verifyR41KeyPins(k).valid,true);
  assert.equal(verifyR41KeyPins({...k,ownerPin:k.managerPin}).valid,false);
  assert.equal(verifyR41KeyPins({...k,owner:'not PEM'}).valid,false);
  assert.equal(verifyR41KeyPins({...k,manager:k.owner}).valid,false);
  assert.equal(verifyR41KeyPins({owner:k.owner,manager:k.manager}).valid,false);
  const output=verifyR41KeyPins(k);
  assert.equal(output.operatorGo,false);
  assert.equal(output.fingerprintsReturned,false);
  assert.equal(JSON.stringify(output).includes(k.ownerPin),false);
});
test('R41 direct real R14 CLI requires pinned independent keys before operator GO',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'r41-keypin-'));
  try{
    const k=fixture(),record=join(folder,'record.json'),
      owner=join(folder,'owner.pem'),manager=join(folder,'manager.pem');
    await Promise.all([PRIVATE(record,JSON.stringify(k.record)),
      PRIVATE(owner,k.owner),PRIVATE(manager,k.manager)]);
    const script=fileURLToPath(new URL('../scripts/r14-admission.mjs',import.meta.url));
    const run=extra=>spawnSync(process.execPath,[script,record,owner,manager,'--require-go'],{
      encoding:'utf8',timeout:12000,env:{...process.env,
        GUEST_OWNER_PUBLIC_KEY_SHA256:extra.owner||'',
        GUEST_MANAGER_PUBLIC_KEY_SHA256:extra.manager||''}
    });
    const ok=run({owner:k.ownerPin,manager:k.managerPin});
    assert.equal(ok.status,0,ok.stdout+' '+ok.stderr);
    assert.equal(JSON.parse(ok.stdout).operatorGo,true);
    assert.equal(JSON.parse(ok.stdout).trustAnchorsPinned,true);
    const missing=run({});
    assert.equal(missing.status,2);
    assert.equal(JSON.parse(missing.stdout).operatorGo,false);
    const swapped=run({owner:k.managerPin,manager:k.ownerPin});
    assert.equal(swapped.status,2);
    assert.equal(JSON.parse(swapped.stdout).operatorGo,false);
    assert.equal((ok.stdout+missing.stdout+swapped.stdout).includes(k.ownerPin),false);
  }finally{await rm(folder,{recursive:true,force:true})}
});
test('R41 fd-bound AGE snapshot verifies bytes and decrypt-only private copy',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'r41-age-'));
  const dest=await mkdtemp(join(tmpdir(),'r41-dest-'));
  try{
    const filename='industry-20261120T010101Z-123.dump.age',
      archive=join(folder,filename),key=join(folder,'identity.txt'),
      ciphertext=Buffer.from('synthetic ciphertext: no real customer records');
    const digest=createHash('sha256').update(ciphertext).digest('hex');
    await PRIVATE(archive,ciphertext);
    await PRIVATE(archive+'.sha256',digest+'  '+filename+'\n');
    await PRIVATE(key,'AGE-SECRET-KEY-synthetic-only');
    const report=await snapshotR41Age({
      archive,identityFile:key,destinationDir:dest
    });
    assert.equal(report.fdBound,true);
    assert.equal(report.sha256,digest);
    assert.equal(report.externalCustodyIndependentlyVerified,false);
    assert.equal((await readFile(join(dest,filename))).toString(),
      ciphertext.toString());
    const verification=await verifyR40Archive({
      archive:join(dest,filename),identityFile:key
    });
    assert.equal(verification.digest,digest);
    await assert.rejects(snapshotR41Age({
      archive,identityFile:key,destinationDir:dest
    }));
    await PRIVATE(archive,Buffer.from('unexpected bytes'));
    await assert.rejects(snapshotR41Age({
      archive,identityFile:key,
      destinationDir:await mkdtemp(join(tmpdir(),'r41-reject-'))
    }),/SHA-256 verification failed/);
  }finally{
    await rm(folder,{recursive:true,force:true});
    await rm(dest,{recursive:true,force:true});
  }
});
test('R41 fd snapshot rejects symlink archive before opening or copying',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'r41-source-'));
  const dest=await mkdtemp(join(tmpdir(),'r41-private-'));
  try{
    const name='industry-20261120T010101Z-456.dump.age',
      src=join(folder,name),key=join(folder,'identity.key');
    await PRIVATE(src,'synthetic');
    await PRIVATE(key,'synthetic-age-identity');
    const linkName='industry-20261120T010101Z-457.dump.age',
      alias=join(folder,linkName);
    await symlink(src,alias);
    await PRIVATE(alias+'.sha256','a'.repeat(64)+'  '+linkName+'\n');
    await assert.rejects(snapshotR41Age({
      archive:alias,identityFile:key,destinationDir:dest
    }),/symlink/);
    await chmod(dest,0o755);
    await assert.rejects(snapshotR41Age({
      archive:src,identityFile:key,destinationDir:dest
    }),/private destination/);
  }finally{await rm(folder,{recursive:true,force:true});
    await rm(dest,{recursive:true,force:true})}
});
test('R41 direct rendered Compose checks private env permissions before calling Docker',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'r41-compose-'));
  try{
    const env=join(folder,'operator.env');
    await PRIVATE(env,'SAFE_KEY=synthetic-only\n');
    let dockerCalls=0;
    const runner=async()=>{dockerCalls++;return JSON.stringify(compose())};
    const good=await checkR38Compose({envFile:env,runner});
    assert.equal(good.valid,true);
    assert.equal(good.r39SandboxVerified,true);
    assert.equal(dockerCalls,1);
    await chmod(env,0o644);
    await assert.rejects(checkR38Compose({envFile:env,runner}),
      /permission/);
    assert.equal(dockerCalls,1);
    await chmod(env,0o600);
    const alias=join(folder,'operator-alias');
    await symlink(env,alias);
    await assert.rejects(checkR38Compose({envFile:alias,runner}),
      /symlink/);
    assert.equal(dockerCalls,1);
  }finally{await rm(folder,{recursive:true,force:true})}
});
test('R41 exact tree proof refuses truncated tree, mismatched blob and incomplete changed files',()=>{
  const f=reviewFixture();
  const good=verifyR41FirstPrTree({...f,filesComplete:true});
  assert.equal(good.valid,true,good.blockers.join(','));
  assert.equal(good.verifiedFiles,10);
  assert.equal(good.githubWriteCalls,0);
  assert.equal(verifyR41FirstPrTree({...f,filesComplete:true,
    tree:{...f.tree,truncated:true}}).valid,false);
  assert.equal(verifyR41FirstPrTree({...f,filesComplete:true,
    files:[{...f.files[0],sha:'d'.repeat(40)},...f.files.slice(1)]}).valid,false);
  assert.equal(verifyR41FirstPrTree({...f,filesComplete:false}).valid,false);
  assert.equal(verifyR41FirstPrTree({...f,filesComplete:true,
    tree:{...f.tree,tree:f.tree.tree.slice(1)}}).valid,false);
});
test('R41 reviewer handoff reports accurate technical evidence, never approves or merges',()=>{
  const f=reviewFixture(),treeProof=verifyR41FirstPrTree({
    ...f,filesComplete:true});
  const result=evaluateR41ReviewGate({...f,treeProof});
  assert.equal(result.technicallyAuditable,true);
  assert.equal(result.tenBlobsMatchPinnedTree,true);
  assert.equal(result.currentHumanApprovalObserved,false);
  assert.equal(result.productionAuthorized,false);
  assert.equal(result.automaticMergeAllowed,false);
  assert.equal(result.githubWriteCalls,0);
  assert.ok(result.blockers.includes('PR47_STILL_DRAFT'));
  assert.ok(result.blockers.includes('NO_INDEPENDENT_REVIEW_ON_CURRENT_HEAD'));
  const guide=renderR41ReviewerGuide(result);
  assert.match(guide,/PR #47 independent review/);
  assert.match(guide,/NO-GO/);
  assert.match(guide,/independent/i);
  assert.equal(evaluateR41ReviewGate({...f,
    treeProof:{...treeProof,valid:false}}).technicallyAuditable,false);
});
test('R41 actual shell restores only fd-snapshotted AGE ciphertext',async()=>{
  const shell=await readFile(new URL('../ops/restore-dr.sh',import.meta.url),'utf8');
  assert.match(shell,/r41-snapshot-age\.mjs/);
  assert.match(shell,/r40-archive-check\.mjs/);
  assert.match(shell,/age -d -i "\$AGE_IDENTITY_FILE" -o "\$tmp\/industry\.dump" "\$tmp\/\$name"/);
  assert.doesNotMatch(shell,/cp -P -- "\$archive"/);
  assert.match(shell,/pg_restore --single-transaction --exit-on-error/);
});
