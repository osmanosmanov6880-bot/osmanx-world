/**
 * R47 source-local Git / Compose + GitHub GET-only human handoff.
 * Does NOT run docker up, migrations, git merge, rebase, push or approvals.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
 R47_FIRST_PR,R47_SOURCE_FILES,assessR47SourcePins
} from '../src/guest-r47-source-pins.mjs';
import {assessR47ResolvedCanary}
  from '../src/guest-r47-canary-policy.mjs';
import {assessR47FirstChecks}
  from '../src/guest-r47-first-checks.mjs';
import {
 assessR47FirstHandoff,renderR47HumanPacket
} from '../src/guest-r47-review-packet.mjs';
import {verifyR45FirstComparison}
  from '../src/guest-r45-compare-proof.mjs';
import {runR45GitPreview} from './r45-merge-preview.mjs';
const API='https://api.github.com/repos/osmanosmanov6880-bot/osmanx-world';
const ROOT=resolve(fileURLToPath(new URL('../',import.meta.url)));
const SHA=/^[0-9a-f]{40}$/;
function local(command,args,{cwd=ROOT,binary=false}={}){
 const r=spawnSync(command,args,{cwd,encoding:binary?null:'utf8',
   timeout:60000,maxBuffer:3*1024*1024,
   env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
 if(r.error||r.status!==0)throw Error('R47 local audit could not run '+command);
 return r.stdout;
}
function refSnapshot(){
 return createHash('sha256').update(local('git',[
   'for-each-ref','--format=%(refname) %(objectname)',
   'refs/heads','refs/remotes'
 ])).digest('hex');
}
function exactPaths(base,head){
 const output=local('git',['diff','--name-only','-z',base,head],
   {binary:true});
 const parts=output.toString('utf8').split('\0');
 if(parts.pop()!==''||parts.some(p=>p.length<1))
   throw Error('R47 malformed path stream');
 return parts;
}
export function readR47LocalEvidence(){
 const before=refSnapshot();
 const main=local('git',['rev-parse','--verify','refs/remotes/origin/main']).trim();
 if(!SHA.test(main))throw Error('R47 main SHA unavailable');
 local('git',['cat-file','-e',R47_FIRST_PR.sha+'^{commit}']);
 const mergeBase=local('git',['merge-base',main,R47_FIRST_PR.sha]).trim();
 if(!SHA.test(mergeBase))throw Error('R47 Git merge base missing');
 const blobs={};
 for(const path of Object.keys(R47_SOURCE_FILES)){
   blobs[path]=local('git',['rev-parse','--verify',
     R47_FIRST_PR.sha+':'+path]).trim();
 }
 const sourcePins=assessR47SourcePins({commitSha:R47_FIRST_PR.sha,
   blobShaByPath:blobs,changedPaths:exactPaths(mergeBase,R47_FIRST_PR.sha)});
 if(!sourcePins.exactHistoricalBytesVerified)
   throw Error('R47 pinned source bytes no longer match first PR');
 // Docker Compose is run with synthetic env values, without starting Docker.
 // Require current branch's R14 YAML to match its *historical* reviewed blob.
 const composeBlob=local('git',['hash-object','ops/compose.r14.yml']).trim();
 if(composeBlob!==R47_SOURCE_FILES['services/industry-api/ops/compose.r14.yml'])
   throw Error('R47 running Compose file is not historical PR47 version');
 const json=local('docker',['compose','--profile','setup',
   '-f','ops/compose.r14.yml','config','--format','json']);
 const canary=assessR47ResolvedCanary(JSON.parse(json));
 if(!canary.canaryTopologySafe)
   throw Error('R47 effective canary configuration fails safe topology');
 const merge=runR45GitPreview();
 const after=refSnapshot();
 if(before!==after||merge.mainSha!==main)
   throw Error('R47 local Git refs changed or main moved during preview');
 return {sourcePins,canary,merge,observedMain:main,
   historicalMergeBase:mergeBase,localBranchRefsUnchanged:true};
}
export async function collectR47FirstReview({
 fetcher=fetch,token=process.env.GITHUB_TOKEN,trustedReviewers=[],
 localEvidence
}={}){
 if(!localEvidence?.sourcePins?.exactHistoricalBytesVerified||
    !localEvidence.canary?.canaryTopologySafe||
    localEvidence.merge?.valid!==true||
    localEvidence.localBranchRefsUnchanged!==true)
   throw Error('R47 local source/Compose/Git evidence absent');
 let getCount=0;
 const get=async(path,{protection=false}={})=>{
   const r=await fetcher(API+path,{method:'GET',redirect:'error',
     headers:{Accept:'application/vnd.github+json',
       'User-Agent':'osmanx-r47-independent-readonly-review',
       ...(token?{Authorization:'Bearer '+token}:{})}});
   getCount++;
   if(protection&&[403,404].includes(r.status))
     return {status:r.status,data:null};
   if(!r.ok)throw Error('R47 GitHub GET refused '+r.status);
   const data=await r.json();
   return protection?{status:200,data}:data;
 };
 const mainBefore=await get('/git/ref/heads/main');
 const [pr,reviews,checks,firstCommit,compare,protection]=await Promise.all([
   get('/pulls/47'),
   get('/pulls/47/reviews?per_page=100'),
   get('/commits/'+R47_FIRST_PR.sha+'/check-runs?per_page=100'),
   get('/git/commits/'+R47_FIRST_PR.sha),
   get('/compare/'+mainBefore?.object?.sha+'...'+R47_FIRST_PR.sha),
   get('/branches/main/protection',{protection:true})
 ]);
 const mainAfter=await get('/git/ref/heads/main');
 if(!Array.isArray(reviews)||reviews.length>=100)
   throw Error('R47 reviewer list is incomplete');
 const compareProof=verifyR45FirstComparison({
   mainBefore,mainAfter,comparison:compare,firstCommit
 });
 if(compareProof.observedMain!==localEvidence.observedMain)
   throw Error('R47 current main drifted after local Git verification');
 const checksProof=assessR47FirstChecks(checks);
 const handoff=assessR47FirstHandoff({
   pr,reviews,trustedReviewers,
   sourcePins:localEvidence.sourcePins,
   canary:localEvidence.canary,
   checks:checksProof,compareProof,
   mergeProof:localEvidence.merge,
   mainFinal:mainAfter?.object?.sha,
   branchProtectionStatus:protection.status,
   protectionData:protection.data
 });
 return {schema:'osmanx.guest.r47.first-pr-get-only-evidence.v1',
   source:localEvidence.sourcePins,
   canary:localEvidence.canary,
   checks:checksProof,compare:compareProof,
   handoff,requestsMade:getCount,
   githubWriteCalls:0,productionAuthorized:false};
}
const direct=process.argv[1]&&
  resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
 try{
   if(process.argv.length!==3||!['--json','--markdown'].includes(process.argv[2]))
     throw Error('R47 --json or --markdown required');
   const trustedReviewers=(process.env.R47_TRUSTED_HUMANS||'')
     .split(',').map(x=>x.trim()).filter(Boolean);
   const evidence=readR47LocalEvidence();
   const data=await collectR47FirstReview({localEvidence:evidence,
     trustedReviewers});
   process.stdout.write(process.argv[2]==='--markdown'?
     renderR47HumanPacket(data.handoff):JSON.stringify(data)+'\n');
   if(!data.source.exactHistoricalBytesVerified||
      !data.canary.canaryTopologySafe||
      !data.checks.requiredCheckPolicyPassed||
      data.githubWriteCalls!==0||data.handoff.productionAuthorized!==false)
     process.exitCode=2;
 }catch(error){
   process.stderr.write('R47 first independent reviewer gate NO-GO: '+
     String(error.message).replace(/[^a-zA-Z0-9._ :-]/g,'').slice(0,160)+'\n');
   process.exitCode=2;
 }
}
