/**
 * Live GitHub GET-only review inventory. No POST, PATCH, approvals, merges or
 * branch edits. Does not infer protection rules from absent API permission.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {R43_SELECTED_STACK,evaluateR43ReviewChain,r43ReviewMarkdown}
  from '../src/guest-r43-review-chain.mjs';
const REPO='osmanosmanov6880-bot/osmanx-world';
const FIRST='840bb083e606058a9a32450f3b3a3e881a34891e';
export async function fetchR43HumanReview({
  repository=REPO,token=process.env.GITHUB_TOKEN,fetcher=fetch
}={}){
 if(repository!==REPO)throw Error('R43 repository pinned');
 const get=async path=>{
   const url='https://api.github.com/repos/'+REPO+path;
   const r=await fetcher(url,{method:'GET',redirect:'error',
     headers:{Accept:'application/vnd.github+json',
       'User-Agent':'osmanx-r43-readonly-human-review',
       ...(token?{Authorization:'Bearer '+token}:{})}});
   if(!r.ok)throw Error('R43 github source GET refused '+r.status);
   return r.json();
 };
 const [prs,mainFirst,reviews]=await Promise.all([
   Promise.all(R43_SELECTED_STACK.map(x=>get('/pulls/'+x.number))),
   get('/git/ref/heads/main'),
   get('/pulls/47/reviews?per_page=100')
 ]);
 const [compare,mainLast]=await Promise.all([
   get('/compare/'+mainFirst.object.sha+'...'+FIRST),
   get('/git/ref/heads/main')
 ]);
 // GitHub compare can omit head_commit. Verify a complete commit listing.
 const complete=Array.isArray(compare?.commits)&&
   compare.commits.length===compare.total_commits&&
   compare.commits.length>0&&compare.commits.length<=250;
 const comparedHead=compare?.head_commit?.sha||
   (complete?compare.commits.at(-1)?.sha:null);
 if(comparedHead!==FIRST)
   throw Error('R43 first PR comparison head not independently verified');
 const report=evaluateR43ReviewChain({
   prs,mainFirst,mainLast,reviews,compare
 });
 return {schema:'osmanx.guest.r43.github-read-only-review.v1',
   report,githubWriteCalls:0,productionAuthorized:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
 try{
   if(process.argv.length!==3||!['--github','--markdown'].includes(process.argv[2]))
     throw Error('Read-only --github or --markdown required');
   const result=await fetchR43HumanReview();
   process.stdout.write(process.argv[2]==='--markdown'?
     r43ReviewMarkdown(result.report):JSON.stringify(result)+'\n');
   if(result.report.selectedPrsVerified!==R43_SELECTED_STACK.length||
     result.githubWriteCalls!==0||result.productionAuthorized!==false)
     process.exitCode=2;
 }catch{
   process.stderr.write('R43 human-review source inventory NO-GO\n');
   process.exitCode=2;
 }
}
