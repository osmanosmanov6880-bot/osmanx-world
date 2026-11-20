import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {verifyR43Lock,R43_PINNED_LOCK_SHA256}
  from '../src/guest-r43-lock.mjs';
import {inspectR43Audit}
  from '../src/guest-r43-audit-policy.mjs';
import {R43_SELECTED_STACK,evaluateR43ReviewChain,r43ReviewMarkdown}
  from '../src/guest-r43-review-chain.mjs';
import {verifyR43ImageConfig}
  from '../src/guest-r43-image-policy.mjs';
const SHA='a'.repeat(40);
const read=(p)=>readFile(new URL(p,import.meta.url),'utf8');
const mockAudit=()=>({auditReportVersion:2,metadata:{
  vulnerabilities:{info:0,low:0,moderate:0,high:0,critical:0,total:0}
},vulnerabilities:{}});
function chain(){
 const prs=R43_SELECTED_STACK.map(x=>({
   number:x.number,state:'open',merged:false,draft:true,
   head:{ref:x.head,sha:x.sha||'f'.repeat(40)},
   base:{ref:x.base},user:{login:'author'}
 }));
 const mainFirst={ref:'refs/heads/main',object:{sha:SHA}};
 return {prs,mainFirst,mainLast:mainFirst,reviews:[],
   compare:{status:'diverged',base_commit:{sha:SHA},
     behind_by:3,ahead_by:4,total_commits:4}};
}
function image(){
 return {Id:'sha256:'+'c'.repeat(64),Config:{
   User:'node',WorkingDir:'/app',Cmd:['node','src/server.mjs'],
   Labels:{'org.opencontainers.image.revision':SHA,
     'io.osmanx.guest.lock-sha256':R43_PINNED_LOCK_SHA256,
     'io.osmanx.guest.writes-default':'false'},
   Env:['NODE_ENV=production'],ExposedPorts:{'3047/tcp':{}},
   Healthcheck:{Test:['CMD-SHELL',
     'node -e "fetch(http://127.0.0.1:3047/api/industry/v1/health/ready)"']}
 }};
}
test('R43 exact lock is committed byte for byte from reviewed R42 candidate',async()=>{
 const rawLock=await read('../package-lock.json');
 const packageBytes=await read('../package.json');
 const r=verifyR43Lock({packageJson:JSON.parse(packageBytes),
   lock:JSON.parse(rawLock),rawLock});
 assert.equal(createHash('sha256').update(rawLock).digest('hex'),
   R43_PINNED_LOCK_SHA256);
 assert.equal(r.valid,true,JSON.stringify(r.blockers));
 assert.equal(r.committedLockfile,true);
 assert.equal(r.lockSha256,R43_PINNED_LOCK_SHA256);
 assert.equal(r.packages,63);
 assert.equal(r.directDependencies,3);
 assert.equal(r.sbomPackages.length,63);
 assert.equal(r.auditVulnerabilitiesNotDetermined,true);
 assert.equal(r.productionAuthorized,false);
});
test('R43 lock refuses moving direct, transitive, SRI or copied bytes',async()=>{
 const rawLock=await read('../package-lock.json');
 const pkg=JSON.parse(await read('../package.json'));
 const original=JSON.parse(rawLock);
 const alt=structuredClone(original);
 alt.packages['node_modules/pg'].version='9.0.0';
 assert.equal(verifyR43Lock({packageJson:pkg,lock:alt,rawLock}).valid,false);
 const altered=JSON.stringify(original);
 assert.equal(verifyR43Lock({packageJson:pkg,lock:original,
   rawLock:altered}).valid,false);
 const missing=structuredClone(original);
 delete missing.packages['node_modules/fastify'];
 assert.equal(verifyR43Lock({packageJson:pkg,lock:missing,rawLock}).valid,false);
 const insecure=structuredClone(original);
 insecure.packages['node_modules/pg'].resolved='http://example.invalid/pg.tgz';
 assert.equal(verifyR43Lock({packageJson:pkg,lock:insecure,rawLock}).valid,false);
});
test('R43 npm audit fails closed on high CVEs, data errors and registry outages',()=>{
 const ok=inspectR43Audit(mockAudit());
 assert.equal(ok.reportChecked,true);
 assert.equal(ok.highCriticalPolicyPassed,true);
 assert.equal(ok.productionAuthorized,false);
 const bad=mockAudit();
 bad.metadata.vulnerabilities.high=1;
 bad.vulnerabilities.fastify={severity:'high'};
 assert.equal(inspectR43Audit(bad).highCriticalPolicyPassed,false);
 assert.equal(inspectR43Audit({error:{code:'E403'}}).reportChecked,false);
 assert.equal(inspectR43Audit({}).highCriticalPolicyPassed,false);
 const warnings=mockAudit();
 warnings.metadata.vulnerabilities.moderate=1;
 assert.equal(inspectR43Audit(warnings).manualReviewForNonHighFindings,true);
});
test('R43 exact selected PR chain verified but manual review & merge blocked',()=>{
 const fixture=chain();
 const r=evaluateR43ReviewChain(fixture);
 assert.equal(r.selectedPrsVerified,7,JSON.stringify(r.blockers));
 assert.equal(r.firstManualReviewPr,47);
 assert.equal(r.behindMain,3);
 assert.equal(r.fullPredecessorChainVerified,false);
 assert.equal(r.githubWrites,0);
 assert.equal(r.automaticMergeAllowed,false);
 assert.equal(r.productionAuthorized,false);
 assert.ok(r.blockers.includes('PR47_REMAINS_DRAFT'));
 assert.ok(r.blockers.includes('NO_INDEPENDENT_REVIEW_OF_CURRENT_PR47_SHA'));
 assert.match(r43ReviewMarkdown(r),/NO MERGE/);
});
test('R43 PR review inventory detects swapped source, wrong base and moving main',()=>{
 const fixture=chain();
 fixture.prs[2].head.sha='f'.repeat(40);
 assert.equal(evaluateR43ReviewChain(fixture).selectedPrsVerified,6);
 const b=chain();
 b.prs[6].base.ref='main';
 assert.equal(evaluateR43ReviewChain(b).selectedPrsVerified,6);
 const c=chain();
 c.mainLast={ref:'refs/heads/main',object:{sha:'b'.repeat(40)}};
 assert.ok(evaluateR43ReviewChain(c).blockers.includes('MAIN_MOVED_OR_NOT_VERIFIED'));
 const d=chain();
 d.reviews=[{state:'APPROVED',commit_id:d.prs[0].head.sha,
   user:{login:'author'}}];
 assert.equal(evaluateR43ReviewChain(d).independentApprovalOnCurrentFirstPr,false);
});
test('R43 built image policy checks nonroot, source SHA, lock pin and no credentials',()=>{
 const valid=verifyR43ImageConfig({inspect:image(),sourceSha:SHA});
 assert.equal(valid.valid,true,JSON.stringify(valid.blockers));
 assert.equal(valid.imageRunsAsNonroot,true);
 assert.equal(valid.runtimeContainerImageNotIndependentlySigned,undefined);
 assert.equal(valid.independentlySigned,false);
 assert.equal(valid.baseImageDigestIndependentlyPinned,false);
 assert.equal(valid.productionAuthorized,false);
 const root=structuredClone(image());root.Config.User='root';
 assert.equal(verifyR43ImageConfig({inspect:root,sourceSha:SHA}).valid,false);
 const leaked=structuredClone(image());
 leaked.Config.Env.push('DATABASE_URL=postgres://not-allowed');
 assert.equal(verifyR43ImageConfig({inspect:leaked,sourceSha:SHA}).valid,false);
 const hash=structuredClone(image());
 hash.Config.Labels['io.osmanx.guest.lock-sha256']='0'.repeat(64);
 assert.equal(verifyR43ImageConfig({inspect:hash,sourceSha:SHA}).valid,false);
});
test('R43 source release and Dockerfile use locked npm ci and include lockfile',async()=>{
 const [docker,pack,verify,ignore]=await Promise.all([
   read('../Dockerfile'),read('../ops/build-release.sh'),
   read('../ops/verify-release.sh'),read('../.dockerignore')
 ]);
 assert.match(docker,/COPY --chown=node:node package\.json package-lock\.json/);
 assert.match(docker,/RUN npm ci --omit=dev --ignore-scripts/);
 assert.doesNotMatch(docker,/RUN npm install/);
 assert.match(docker,/USER node/);
 assert.match(pack,/Dockerfile compose\.yml package\.json package-lock\.json/);
 assert.match(pack,/committedDependencyLockAndImageSmokeR43/);
 assert.match(verify,/R43 committed npm lock identity mismatch/);
 assert.match(ignore,/\*\*\/\.env/);
 assert.match(ignore,/\*\*\/\*\.pem/);
});
