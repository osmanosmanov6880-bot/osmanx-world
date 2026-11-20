/**
 * Live GitHub GET-only first-PR gate. The source PR #47's complete Git tree
 * is reconciled with its exact file SHA inventory, and main HEAD is observed.
 * --markdown writes a bounded human-readable checklist; no GitHub mutation.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR39FirstPrReview}
  from './r39-first-pr-review.mjs';
import {verifyR41FirstPrTree}
  from '../src/guest-r41-git-tree.mjs';
import {evaluateR41ReviewGate,renderR41ReviewerGuide}
  from '../src/guest-r41-review-gate.mjs';
const REPO='osmanosmanov6880-bot/osmanx-world';
export async function fetchR41FirstPrGate({
  repository=REPO,token=process.env.GITHUB_TOKEN,fetcher=fetch
}={}){
  if(repository!==REPO)throw Error('R41 source repository pinned');
  const previous=await fetchR39FirstPrReview({repository,token,fetcher});
  const get=async path=>{
    const response=await fetcher('https://api.github.com/repos/'+repository+path,{
      method:'GET',redirect:'error',headers:{
        Accept:'application/vnd.github+json',
        'User-Agent':'osmanx-r41-readonly-review-gate',
        ...(token?{Authorization:'Bearer '+token}:{})
      }
    });
    if(!response.ok)throw Error('R41 GitHub GET failed '+response.status);
    return response.json();
  };
  const [pr,commit,files,mainRef]=await Promise.all([
    get('/pulls/47'),
    get('/git/commits/840bb083e606058a9a32450f3b3a3e881a34891e'),
    get('/pulls/47/files?per_page=100'),
    get('/git/ref/heads/main')
  ]);
  const tree=await get('/git/trees/'+commit.tree.sha+'?recursive=1');
  const treeProof=verifyR41FirstPrTree({
    pr,commit,tree,files,
    filesComplete:Array.isArray(files)&&files.length===pr.changed_files&&
      files.length<100
  });
  const gate=evaluateR41ReviewGate({
    pr,packet:previous.packet,treeProof,mainRef
  });
  return {schema:'osmanx.guest.r41.github-get-only-review.v1',
    gate,treeProof,githubWriteCalls:0,
    automaticMergeAllowed:false,productionAuthorized:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||
      !['--github','--markdown'].includes(process.argv[2]))
      throw Error('Use --github or --markdown, read-only');
    const result=await fetchR41FirstPrGate();
    if(process.argv[2]==='--markdown')
      process.stdout.write(renderR41ReviewerGuide(result.gate));
    else process.stdout.write(JSON.stringify(result)+'\n');
    if(result.gate.technicallyAuditable!==true||
      result.treeProof.valid!==true||result.githubWriteCalls!==0)
      process.exitCode=2;
  }catch{
    process.stderr.write('R41 exact-source review NO-GO\n');
    process.exitCode=2;
  }
}
