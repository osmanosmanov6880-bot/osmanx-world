/** Exact read-only source gate and next unmerged PR review introspection. */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR34GitHubSource} from './r34-review-github.mjs';
import {R34_PIN,evaluateR35Source,evaluateR35HumanReview}
  from '../src/guest-r35-source.mjs';
const SHA=/^[a-f0-9]{40}$/;
export async function fetchR35GitHubReview({
  repository='osmanosmanov6880-bot/osmanx-world',
  fetcher=fetch,token=process.env.GITHUB_TOKEN
}={}){
  if(repository!=='osmanosmanov6880-bot/osmanx-world')
    throw Error('R35 repository pinned');
  const prior=await fetchR34GitHubSource({repository,fetcher,token});
  const get=async path=>{
    const response=await fetcher(
      'https://api.github.com/repos/'+repository+path,{
        method:'GET',redirect:'error',
        headers:{Accept:'application/vnd.github+json',
          'User-Agent':'osmanx-r35-readonly',
          ...(token?{Authorization:'Bearer '+token}:{})}
      });
    if(!response.ok)throw Error('R35 GitHub GET '+response.status);
    return response.json();
  };
  const [pr,ci,compare,sourceCommit,mainCommit]=await Promise.all([
    get('/pulls/69'),
    get('/commits/'+R34_PIN.sha+'/check-runs?per_page=100'),
    get('/compare/'+R34_PIN.parent+'...'+R34_PIN.sha),
    get('/git/commits/'+R34_PIN.sha),
    SHA.test(prior.mainSha||'')?
      get('/git/commits/'+prior.mainSha):Promise.resolve(null)
  ]);
  const source=evaluateR35Source({
    prior,pr,checks:ci.check_runs||[],
    ancestry:{base:R34_PIN.parent,head:R34_PIN.sha,
      status:compare.status},
    releaseCommit:{sha:R34_PIN.sha,tree:sourceCommit.tree},
    mainCommit:mainCommit?{
      sha:prior.mainSha,tree:mainCommit.tree}:null
  });
  let review=null;
  if(Number.isInteger(source.firstPendingPr)&&
    source.firstPendingPr>0&&source.firstPendingPr<=1000){
    const number=source.firstPendingPr;
    const [pending,reviews,pendingCi]=await Promise.all([
      get('/pulls/'+number),
      get('/pulls/'+number+'/reviews?per_page=100'),
      get('/commits/'+source.expectedPendingSha+
        '/check-runs?per_page=100')
    ]);
    review=evaluateR35HumanReview({
      source,pr:pending,reviews,
      checks:pendingCi.check_runs||[]
    });
  }
  return {schema:'osmanx.guest.r35.readonly-review.v1',
    source,review,githubWritesPerformed:false,
    productionAuthorized:false,customerGo:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Use --github for read-only inspection');
    const out=await fetchR35GitHubReview();
    process.stdout.write(JSON.stringify(out)+'\n');
    if(out.source.observedPrs!==21||!out.source.sourceCiPassed||
      !out.source.ancestryVerified||
      out.productionAuthorized!==false)process.exitCode=2;
  }catch(e){
    process.stderr.write('R35 review failed closed: '+e.message+'\n');
    process.exitCode=2;
  }
}
