/**
 * R46 precise review surface: true Git merge-base, source patch allowlist and
 * overlap between intervening main changes and PR #47. No source content is
 * exported, only validated repository paths and SHA-256 metadata.
 */
import {createHash} from 'node:crypto';
import {R46_PINNED_STACK} from './guest-r46-source-graph.mjs';
export const R46_DRIFT_SCHEMA='osmanx.guest.r46.first-pr-review-surface.v1';
export const R46_R14_FILES=Object.freeze([
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
]);
const SHA=/^[a-f0-9]{40}$/;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validPath=p=>typeof p==='string'&&p.length>0&&p.length<=1024&&
 !p.startsWith('/')&&!p.includes('\\')&&!/[\x00-\x1f\x7f\ufffd]/.test(p)&&
 p.split('/').every(x=>x&&x!=='.'&&x!=='..');
const strings=x=>Array.isArray(x)&&x.length<=20000&&
 x.every(validPath)&&x.length===new Set(x).size;
const domain=p=>p.startsWith('services/industry-api/ops/')?'OPERATOR_RELEASE':
 p.startsWith('services/industry-api/scripts/')?'SAFETY_ENTRYPOINT':
 p.startsWith('services/industry-api/test/')?'REGRESSION':
 p.startsWith('.github/workflows/')?'CI_WORKFLOW':
 p.startsWith('docs/')?'RUNBOOK':'OTHER';
export function assessR46FirstDrift({
 mergeBaseSha,mainSha,sourceSha=R46_PINNED_STACK[0].sha,
 mainChangedPaths,sourceChangedPaths
}={}){
 const blockers=[];
 if(!SHA.test(mergeBaseSha||'')||!SHA.test(mainSha||'')||
   sourceSha!==R46_PINNED_STACK[0].sha)
   blockers.push('INVALID_OR_UNPINNED_GIT_REVISION');
 if(!strings(mainChangedPaths)||!strings(sourceChangedPaths))
   blockers.push('UNTRUSTED_GIT_PATH_INVENTORY');
 const main=Array.isArray(mainChangedPaths)?mainChangedPaths:[];
 const source=Array.isArray(sourceChangedPaths)?sourceChangedPaths:[];
 const expected=R46_R14_FILES;
 if(source.length!==expected.length||
   expected.some(p=>!source.includes(p)))
   blockers.push('PR47_PATCH_FILES_CHANGED_FROM_REVIEWED_TEN_FILE_ALLOWLIST');
 const touched=new Set(main);
 const overlap=source.filter(p=>touched.has(p)).sort();
 const byDomain=Object.fromEntries(
   [...new Set(expected.map(domain))].sort().map(d=>[d,expected.filter(x=>domain(x)===d).length])
 );
 const r={schema:R46_DRIFT_SCHEMA,
   valid:blockers.length===0,mainSha:SHA.test(mainSha||'')?mainSha:null,
   mergeBaseSha:SHA.test(mergeBaseSha||'')?mergeBaseSha:null,
   firstPrNumber:47,firstPrSha:R46_PINNED_STACK[0].sha,
   sourceFilesVerified:source.length,
   changedMainFileCount:main.length,
   overlapCount:overlap.length,overlappingFiles:overlap,
   sourceFileDomains:byDomain,
   patchFileAllowlistVerified:blockers.length===0,
   contentReviewStillRequired:true,
   noOverlapDoesNotProveMergeSafety:true,
   branchRefsChanged:false,githubWrites:0,
   productionAuthorized:false,blockers};
 return {...r,sha256:digest(r)};
}
