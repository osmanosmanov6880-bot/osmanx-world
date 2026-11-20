import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign}
  from 'node:crypto';
import {mkdtemp,mkdir,writeFile,chmod,symlink,rm,readFile}
  from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {inspectR42Merge}
  from '../src/guest-r42-merge-drift.mjs';
import {r42MergeMarkdown}
  from '../scripts/r42-merge-audit.mjs';
import {inspectR42BackupSource,inspectR42BackupDirectory}
  from '../src/guest-r42-backup-guard.mjs';
import {preflightR42Backup}
  from '../scripts/r42-backup-preflight.mjs';
import {r41PublicKeyFingerprint}
  from '../src/guest-r41-key-pins.mjs';
import {r42CustodyMessage,verifyR42Custody,R42_CUSTODY_SCHEMA}
  from '../src/guest-r42-custody-proof.mjs';
import {auditR42Dependencies}
  from '../src/guest-r42-dependency-audit.mjs';
const HEAD='840bb083e606058a9a32450f3b3a3e881a34891e';
const MAIN='85e9fe290e354d113fd62787f5e8db90406f0961';
const PG_URL='postgres://postgres:synthetic@127.0.0.1:5432/industry_ci';
const PUB1='age1'+'a'.repeat(58),PUB2='age1'+'b'.repeat(58);
const ACK='CONFIRM_LOCAL_ENCRYPTED_BACKUP_NO_CUSTOMERS';
const sha64='c'.repeat(64);
const source=()=>({dbUrl:PG_URL,recipient1:PUB1,
  recipient2:PUB2,acknowledgment:ACK});
function merge(){
  const pr={number:47,head:{sha:HEAD},base:{ref:'main',
    sha:'7fab98a69db4f8b987e9bd88ea4888e4eef61edd'},state:'open',
    merged:false,draft:true,mergeable:true,mergeable_state:'clean'};
  const mainRef={ref:'refs/heads/main',object:{sha:MAIN}};
  const compare={status:'diverged',base_commit:{sha:MAIN},
    head_commit:{sha:HEAD},ahead_by:4,behind_by:2,total_commits:4};
  return {pr,mainRef,mainAfter:mainRef,compare,
    protection:{status:403,data:null}};
}
function custodian(){
  const pair=generateKeyPairSync('ed25519');
  const publicKeyPem=pair.publicKey.export({type:'spki',format:'pem'});
  const receipt={schema:R42_CUSTODY_SCHEMA,
    archiveName:'industry-20261120T010101Z-123.dump.age',
    archiveSha256:sha64,archiveBytes:128,
    custodianId:'independent-test-custodian',
    objectVersion:'immutable-test-version-1',
    storageClass:'independent-offsite',
    observedAt:new Date(Date.now()-60000).toISOString(),
    expiresAt:new Date(Date.now()+86400000).toISOString()};
  receipt.signature=sign(null,Buffer.from(r42CustodyMessage(receipt)),
    pair.privateKey).toString('base64');
  return {receipt,publicKeyPem,
    trustedKeySha:r41PublicKeyFingerprint(publicKeyPem),
    expectedSha:sha64,expectedName:receipt.archiveName,expectedBytes:128,
    now:new Date()};
}
function lock(){
  const dependencies={'@fastify/cookie':'11.1.5',fastify:'5.12.8',
    pg:'8.23.1'};
  const packages={'':{name:'@osmanx/industry-api',version:'0.6.0',
    dependencies}};
  for(const [name,version] of Object.entries(dependencies))
    packages['node_modules/'+name]={version,
      resolved:'https://registry.npmjs.org/'+name+'/-/artifact.tgz',
      integrity:'sha512-'+'A'.repeat(80)};
  return {pkg:{name:'@osmanx/industry-api',private:true,dependencies},
    lock:{name:'@osmanx/industry-api',lockfileVersion:3,
      packages}};
}
test('R42 current main divergence measured, not misrepresented as permission to merge',()=>{
  const f=merge(),r=inspectR42Merge(f);
  assert.equal(r.canHandOffToReviewer,true);
  assert.equal(r.firstPrBehindCommits,2);
  assert.equal(r.firstPrAheadCommits,4);
  assert.equal(r.githubMergeableObserved,true);
  // Real GitHub compare omits head_commit but returns a complete commits page.
  const noHead={...f.compare,head_commit:undefined,
    commits:[{sha:'1'.repeat(40)},{sha:'2'.repeat(40)},
      {sha:'3'.repeat(40)},{sha:HEAD}]};
  assert.equal(inspectR42Merge({...f,compare:noHead}).canHandOffToReviewer,true);
  assert.equal(inspectR42Merge({...f,compare:{
    ...noHead,commits:noHead.commits.slice(1)}}).canHandOffToReviewer,false);
  assert.equal(r.branchProtectionReadable,false);
  assert.equal(r.canMergeNow,false);
  assert.equal(r.productionAuthorized,false);
  assert.ok(r.blockers.includes('SOURCE_BRANCH_BEHIND_MAIN_MANUAL_UPDATE_REQUIRED'));
  assert.ok(r.blockers.includes('BRANCH_PROTECTION_NOT_INDEPENDENTLY_VERIFIED'));
  assert.equal(inspectR42Merge({...f,mainAfter:{object:{sha:'f'.repeat(40)}}})
    .canHandOffToReviewer,false);
  assert.equal(inspectR42Merge({...f,compare:{
    ...f.compare,base_commit:{sha:'f'.repeat(40)}}}).canHandOffToReviewer,false);
  const m=r42MergeMarkdown({schema:'osmanx.guest.r42.github-first-pr-readonly.v1',
    merge:r});
  assert.match(m,/Behind main: 2/);
  assert.match(m,/NO-GO/);
});
test('R42 backup source refuses remote databases, unapproved runs and repeated AGE keys',()=>{
  assert.equal(inspectR42BackupSource(source()).valid,true);
  const invalid=[
    {...source(),acknowledgment:''},
    {...source(),recipient2:PUB1},
    {...source(),recipient2:'garbage'},
    {...source(),dbUrl:PG_URL.replace('127.0.0.1','db.company.internal')},
    {...source(),dbUrl:PG_URL.replace('industry_ci','production')},
    {...source(),dbUrl:PG_URL+'?sslmode=disable'}
  ];
  for(const x of invalid)
    assert.equal(inspectR42BackupSource(x).valid,false,JSON.stringify(x));
});
test('R42 owner-private preexisting directory preflight rejects symlinks, chmod and checkout',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'r42-backup-'));
  try{
    const dest=join(folder,'safe');
    await mkdir(dest,{mode:0o700});
    const args={destination:dest,dbUrl:PG_URL,
      recipient1:PUB1,recipient2:PUB2,acknowledgment:ACK};
    const report=await preflightR42Backup(args);
    assert.equal(report.valid,true);
    assert.equal(report.productionAuthorized,false);
    assert.equal(report.sourceUrlReturned,false);
    assert.equal(JSON.stringify(report).includes('synthetic'),false);
    await chmod(dest,0o755);
    await assert.rejects(preflightR42Backup(args),/DESTINATION/);
    await chmod(dest,0o700);
    const alias=join(folder,'alias');
    await symlink(dest,alias,'dir');
    await assert.rejects(preflightR42Backup({...args,destination:alias}),
      /DESTINATION/);
    assert.equal(inspectR42BackupDirectory({
      path:'/repo/private',canonical:'/repo/private',
      checkout:'/repo',stat:{isDirectory:()=>true,
        isSymbolicLink:()=>false,mode:0o40700,uid:1000},
      currentUid:1000
    }).valid,false);
  }finally{await rm(folder,{recursive:true,force:true})}
});
test('R42 actual backup shell is no-overwrite and checks destination before pg_dump',async()=>{
  const script=await readFile(new URL('../ops/backup-encrypted.sh',import.meta.url),
    'utf8');
  const before=script.indexOf('r42-backup-preflight.mjs');
  const dump=script.indexOf('pg_dump --dbname');
  assert.ok(before>=0&&dump>before);
  assert.match(script,/ln "\$temp_dir\/\$name" "\$dest\/\$name"/);
  assert.match(script,/ln "\$temp_dir\/\$name.sha256" "\$dest\/\$name.sha256"/);
  assert.doesNotMatch(script,/mkdir -p "\$dest"|mv "\$name" "\$dest/);
});
test('R42 Ed25519 signed external custody claim is bound but not proof of real storage',()=>{
  const c=custodian(),report=verifyR42Custody(c);
  assert.equal(report.claimValid,true,report.blockers.join(','));
  assert.equal(report.signatureVerified,true);
  assert.equal(report.actualProviderObjectFetched,false);
  assert.equal(report.actualOffsiteRestoreWitnessed,false);
  assert.equal(report.proofOfExternalCustody,false);
  assert.equal(report.productionAuthorized,false);
  assert.equal(verifyR42Custody({...c,trustedKeySha:'f'.repeat(64)})
    .claimValid,false);
  assert.equal(verifyR42Custody({...c,expectedSha:'f'.repeat(64)})
    .claimValid,false);
  assert.equal(verifyR42Custody({...c,expectedBytes:127})
    .claimValid,false);
  assert.equal(verifyR42Custody({...c,now:new Date('2026-12-11T00:00:00.000Z')})
    .claimValid,false);
  assert.equal(verifyR42Custody({...c,
    receipt:{...c.receipt,productionAuthorized:true}}).claimValid,false);
  assert.equal(verifyR42Custody({...c,
    receipt:{...c.receipt,storageClass:'local-test'}}).claimValid,false);
});
test('R42 offline signed receipt CLI requires custodian pin and never logs receipt contents',async()=>{
  const c=custodian(),folder=await mkdtemp(join(tmpdir(),'r42-custody-'));
  try{
    const receipt=join(folder,'receipt.json'),publicKey=join(folder,'custodian.pem');
    await writeFile(receipt,JSON.stringify(c.receipt),{mode:0o600});
    await writeFile(publicKey,c.publicKeyPem,{mode:0o600});
    const script=fileURLToPath(new URL('../scripts/r42-verify-custody.mjs',
      import.meta.url));
    const run=(pin)=>spawnSync(process.execPath,[
      script,receipt,publicKey,sha64,c.receipt.archiveName],{
      encoding:'utf8',timeout:10000,env:{...process.env,
        GUEST_R42_CUSTODIAN_SPKI_SHA256:pin,
        GUEST_R42_EXPECTED_ARCHIVE_BYTES:'128'}
    });
    const good=run(c.trustedKeySha);
    assert.equal(good.status,0,good.stderr);
    assert.equal(JSON.parse(good.stdout).claimValid,true);
    assert.equal(run('f'.repeat(64)).status,2);
    assert.ok(!good.stdout.includes(c.trustedKeySha));
  }finally{await rm(folder,{recursive:true,force:true})}
});
test('R42 generated lockfile inventory detects registry tamper and missing pinned package',()=>{
  const a=lock(),raw=JSON.stringify(a.lock,null,2);
  const good=auditR42Dependencies({...a,rawLock:raw});
  assert.equal(good.integrityGraphValid,true,good.blockers.join(','));
  assert.equal(good.directPinned,3);
  assert.equal(good.sourceLockfileCommitted,false);
  assert.equal(good.generatedInCiNotReproducibleUntilCommitted,true);
  const mutated=structuredClone(a.lock);
  mutated.packages['node_modules/pg'].resolved='https://evil.example/pg.tgz';
  assert.equal(auditR42Dependencies({...a,lock:mutated,
    rawLock:JSON.stringify(mutated)}).integrityGraphValid,false);
  const noPkg=structuredClone(a.lock);
  delete noPkg.packages['node_modules/fastify'];
  assert.equal(auditR42Dependencies({...a,lock:noPkg,
    rawLock:JSON.stringify(noPkg)}).integrityGraphValid,false);
  const script=structuredClone(a.lock);
  script.packages['node_modules/pg'].hasInstallScript=true;
  assert.equal(auditR42Dependencies({...a,lock:script,
    rawLock:JSON.stringify(script)}).integrityGraphValid,false);
});
