/**
 * R46 full human handoff: only GitHub GET for the entire 32-PR stack.
 * No approvals, comments, status mutations, merges, branch updates or deploy.
 */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {
 R46_PINNED_STACK,assessR46SourceGraph
} from '../src/guest-r46-source-graph.mjs';
import {
 assessR46ManualQueue,renderR46ReviewerPacket
} from '../src/guest-r46-reviewer-gate.mjs';
const REPO='osmanosmanov6880-bot/osmanx-world';
const API='https://api.github.com/repos/'+REPO;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const hasProof=x=>{
 if(!x||typeof x!=='object'||typeof x.sha256!=='string')return false;
 const copy={...x};delete copy.sha256;
 return hash(copy)===x.sha256;
};
export async function collectR46Review({
 fetcher=fetch,token=process.env.GITHUB_TOKEN,
 trustedReviewers=[],drift,virtualMerge
}={}){
 let readCalls=0;
 const get=async(path,{allowUnreadableProtection=false}={})=>{
   const r=await fetcher(API+path,{method:'GET',redirect:'error',
     headers:{Accept:'application/vnd.github+json',
       'User-Agent':'osmanx-r46-readonly-human-handoff',
       ...(token?{Authorization:'Bearer '+token}:{})}});
   readCalls++;
   if(allowUnreadableProtection&&[403,404].includes(r.status))
     return {status:r.status,data:null};
   if(!r.ok)throw Error('R46 GitHub GET refused '+r.status);
   return r.json();
 };
 if(!hasProof(drift)||!hasProof(virtualMerge))
   throw Error('R46 local Git proof is not byte-consistent');
 const mainBefore=await get('/git/ref/heads/main');
 const prs=[],reviewsByPr={},checksByPr={};
 for(let i=0;i<R46_PINNED_STACK.length;i+=4){
   const batch=await Promise.all(R46_PINNED_STACK.slice(i,i+4).map(
     async expected=>{
       const [pr,reviews,checks]=await Promise.all([
         get('/pulls/'+expected.number),
         get('/pulls/'+expected.number+'/reviews?per_page=100'),
         get('/commits/'+expected.sha+'/check-runs?per_page=100')
       ]);
       return {expected,pr,reviews,checks};
     }));
   for(const {expected,pr,reviews,checks} of batch){
     if(!Array.isArray(reviews)||reviews.length>=100)
       throw Error('R46 review page incomplete for PR '+expected.number);
     prs.push(pr);
     reviewsByPr[expected.number]=reviews;
     checksByPr[expected.number]=checks;
   }
 }
 const protection=await get('/branches/main/protection',
   {allowUnreadableProtection:true});
 const protectionStatus=protection.status||200;
 const mainAfter=await get('/git/ref/heads/main');
 const graph=assessR46SourceGraph({prs,mainBefore,mainAfter});
 const report=assessR46ManualQueue({
   graph,prList:prs,reviewsByPr,checksByPr,trustedReviewers,drift,
   virtualMerge,protectionStatus,mainFinally:mainAfter?.object?.sha
 });
 if(!graph.mainSha||graph.mainSha!==drift.mainSha||
   graph.mainSha!==virtualMerge.mainSha)
   throw Error('R46 main changed since local Git proof; re-run in clean checkout');
 return {schema:'osmanx.guest.r46.live-independent-review-evidence.v1',
   graph,report,githubReadCalls:readCalls,githubMutationCalls:0,
   trustedReviewerPolicyConfigured:trustedReviewers.length>=2,
   productionAuthorized:false};
}
const direct=process.argv[1]&&
  resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
 try{
   if(process.argv.length!==5||
     !['--json','--markdown'].includes(process.argv[2]))
     throw Error('R46 --json|--markdown drift.json virtual.json required');
   const [drift,virtualMerge]=await Promise.all([
     readFile(process.argv[3],'utf8').then(JSON.parse),
     readFile(process.argv[4],'utf8').then(JSON.parse)
   ]);
   const trustedReviewers=(process.env.R46_TRUSTED_HUMANS||'')
     .split(',').map(x=>x.trim()).filter(Boolean);
   const data=await collectR46Review({drift,virtualMerge,trustedReviewers});
   process.stdout.write(process.argv[2]==='--markdown'?
     renderR46ReviewerPacket(data.report):JSON.stringify(data)+'\n');
   // Code source validation, not approval: human blockers intentionally
   // remain NO-GO and do not fail a truthful review-evidence CI task.
   if(data.graph.matchingSourceHeads!==32||
     data.githubMutationCalls!==0||data.report.actions.productionAuthorized!==false)
     process.exitCode=2;
 }catch(error){
   process.stderr.write('R46 review evidence NO-GO: '+
     String(error?.message||error).replace(/[^a-zA-Z0-9 .:_-]/g,'').slice(0,140)+'\n');
   process.exitCode=2;
 }
}
