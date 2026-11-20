/**
 * R45: GET-only 31-PR SHA, independent review, source CI and main-divergence
 * inventory, with an optional REAL local git merge-tree result.
 * Never POST/PATCH GitHub; never issues merge/approval/deploy commands.
 */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR44FullReview} from './r44-review-full-chain.mjs';
import {
 R45_FIRST,verifyR45FirstComparison
} from '../src/guest-r45-compare-proof.mjs';
import {inspectR45CurrentShaChecks} from '../src/guest-r45-ci-provenance.mjs';
import {
 R45_ALL_STACK,R45_LAST,evaluateR45ManualHandoff,
 renderR45OperatorHandoff
} from '../src/guest-r45-manual-gate.mjs';
const REPO='osmanosmanov6880-bot/osmanx-world';
const API='https://api.github.com/repos/'+REPO;
export async function runR45ReadOnlyAudit({
 token=process.env.GITHUB_TOKEN,fetcher=fetch,mergePreview
}={}){
 let reads=0;
 const get=async(path)=>{
   const response=await fetcher(API+path,{method:'GET',redirect:'error',
     headers:{Accept:'application/vnd.github+json',
       'User-Agent':'osmanx-r45-readonly-independent-acceptance',
       ...(token?{Authorization:'Bearer '+token}:{})}});
   reads++;
   if(!response.ok)throw Error('R45 source GET failed '+response.status);
   return response.json();
 };
 // R44 already rechecks 30 currently pinned PRs, their latest reviews and
 // current main. Its optional-head compare false negative is corrected below.
 const earlier=await fetchR44FullReview({token,fetcher});
 const [pr90,review90,firstCommit,comparison]=await Promise.all([
   get('/pulls/'+R45_LAST.number),
   get('/pulls/'+R45_LAST.number+'/reviews?per_page=100'),
   get('/git/commits/'+R45_FIRST.sha),
   get('/compare/'+earlier.report.mainSha+'...'+R45_FIRST.sha)
 ]);
 if(!Array.isArray(review90)||review90.length>=100)
   throw Error('R45 PR90 independent review list incomplete');
 const ciByNumber={};
 for(let i=0;i<R45_ALL_STACK.length;i+=5){
   const batch=await Promise.all(R45_ALL_STACK.slice(i,i+5).map(
     async expected=>{
       const source=await get('/commits/'+expected.sha+'/check-runs?per_page=100');
       return inspectR45CurrentShaChecks({
         prNumber:expected.number,expectedSha:expected.sha,response:source
       });
     }));
   for(const record of batch)ciByNumber[record.prNumber]=record;
 }
 const mainAfter=await get('/git/ref/heads/main');
 const comparisonProof=verifyR45FirstComparison({
   mainBefore:{ref:'refs/heads/main',object:{sha:earlier.report.mainSha}},
   mainAfter,comparison,firstCommit
 });
 const report=evaluateR45ManualHandoff({
   r44Report:earlier.report,pr90,review90,ciByNumber,
   comparisonProof,mergePreview,
   mainAfterFinal:mainAfter?.object?.sha
 });
 return {
   schema:'osmanx.guest.r45.live-read-only-evidence.v1',
   githubReadOnlyCalls:reads,githubMutationCalls:0,
   sourcePrsEvaluated:R45_ALL_STACK.length,
   independentComparison:comparisonProof,
   report,productionAuthorized:false
 };
}
const direct=process.argv[1]&&
  resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
 try{
   if(process.argv.length!==4||
      !['--json','--markdown'].includes(process.argv[2]))
     throw Error('R45 --json|--markdown preview.json is required');
   const preview=JSON.parse(await readFile(process.argv[3],'utf8'));
   const r=await runR45ReadOnlyAudit({mergePreview:preview});
   process.stdout.write(process.argv[2]==='--markdown'?
     renderR45OperatorHandoff(r.report):JSON.stringify(r)+'\n');
   if(r.report.expectedSourcePrs!==31||
      r.report.verifiedSourcePrs!==31||
      r.githubMutationCalls!==0||
      r.report.decisions?.productionAuthorized!==false||
      !r.independentComparison.evidenceValid||
      !r.report.mergePreviewValid)
     process.exitCode=2;
 }catch(error){
   process.stderr.write('R45 read-only source receipt NO-GO: '+
     String(error?.message||error).replace(/[^a-zA-Z0-9._ :#-]/g,'').slice(0,140)+'\n');
   process.exitCode=2;
 }
}
