/**
 * R44 current-read-only GitHub source and human-review handoff.
 * One bounded API client, no mutation methods, never merges or deploys.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {R44_PINNED_STACK,evaluateR44FullChain,renderR44ReviewerMarkdown}
  from '../src/guest-r44-full-chain.mjs';
const REPO='osmanosmanov6880-bot/osmanx-world';
const API='https://api.github.com/repos/'+REPO;
const sleep=()=>Promise.resolve();
export async function fetchR44FullReview({
  token=process.env.GITHUB_TOKEN,fetcher=fetch
}={}){
 let getCount=0;
 const get=async(path,{allowProtectionDenial=false}={})=>{
   const response=await fetcher(API+path,{
     method:'GET',redirect:'error',headers:{
       Accept:'application/vnd.github+json',
       'User-Agent':'osmanx-r44-source-review-readonly',
       ...(token?{Authorization:'Bearer '+token}:{})
     }});
   getCount++;
   if(allowProtectionDenial&&[403,404].includes(response.status))
     return {status:response.status,data:null};
   if(!response.ok)throw Error('R44 GitHub GET failed: '+response.status);
   return response.json();
 };
 // Batches bounded to avoid API burst and review API partial inventory.
 const prs=[],reviewsByNumber={};
 for(let start=0;start<R44_PINNED_STACK.length;start+=5){
   const batch=R44_PINNED_STACK.slice(start,start+5);
   const values=await Promise.all(batch.map(async p=>{
     const [pr,reviews]=await Promise.all([
       get('/pulls/'+p.number),get('/pulls/'+p.number+'/reviews?per_page=100')
     ]);
     if(!Array.isArray(reviews)||reviews.length>=100)
       throw Error('R44 review pagination not proven for PR '+p.number);
     return {pr,reviews,number:p.number};
   }));
   for(const row of values){
     prs.push(row.pr);
     reviewsByNumber[row.number]=row.reviews;
   }
   await sleep();
 }
 const mainBefore=await get('/git/ref/heads/main');
 if(mainBefore?.ref!=='refs/heads/main')
   throw Error('R44 current main not independently read');
 const [compare,protection,mainAfter]=await Promise.all([
   get('/compare/'+mainBefore.object.sha+'...'+R44_PINNED_STACK[0].sha),
   get('/branches/main/protection',{allowProtectionDenial:true})
     .then(data=>data?.status?data:{status:200,data}),
   get('/git/ref/heads/main')
 ]);
 const result=evaluateR44FullChain({
   prs,reviewsByNumber,mainBefore,mainAfter,compare,protection
 });
 return {schema:'osmanx.guest.r44.live-readonly-report.v1',
   report:result,githubRequests:getCount,githubMutationCalls:0,
   firstBlockingPr:result.firstManualBlockerPr,
   allSourceHashesVerified:result.verifiedSourcePrs===30,
   mainCiAfterMergeVerified:false,
   productionAuthorized:false};
}
const direct=process.argv[1]&&
  resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
 try{
   if(process.argv.length!==3||!['--json','--markdown'].includes(process.argv[2]))
     throw Error('R44 --json or --markdown');
   const r=await fetchR44FullReview();
   process.stdout.write(process.argv[2]==='--markdown'?
     renderR44ReviewerMarkdown(r.report):JSON.stringify(r)+'\n');
   if(!r.allSourceHashesVerified||r.githubMutationCalls!==0||
      r.report.decisions?.productionAuthorized!==false)
     process.exitCode=2;
 }catch(error){
   process.stderr.write('R44 complete PR source inventory NO-GO: '+
     String(error?.message||error).replace(/[^\w .:#-]/g,'').slice(0,160)+'\n');
   process.exitCode=2;
 }
}
