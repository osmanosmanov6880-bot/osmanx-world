/**
 * GitHub read-only snapshot pinned to R30 PR #65. Exact GET endpoints only.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR30GitHubReview} from './r30-review-github.mjs';
import {R30_PIN,evaluateR31Chain} from '../src/guest-r31-chain.mjs';
const SHA=/^[a-f0-9]{40}$/;
export async function fetchR31GitHubChain({
  repository='osmanosmanov6880-bot/osmanx-world',
  fetcher=fetch,token=process.env.GITHUB_TOKEN
}={}){
  if(repository!=='osmanosmanov6880-bot/osmanx-world')
    throw new TypeError('R31 repository is pinned');
  const prev=await fetchR30GitHubReview({repository,fetcher,token});
  const get=async p=>{
    const res=await fetcher('https://api.github.com/repos/'+repository+p,{
      method:'GET',redirect:'error',
      headers:{Accept:'application/vnd.github+json',
        'User-Agent':'osmanx-r31-readonly',
        ...(token?{Authorization:'Bearer '+token}:{})}
    });
    if(!res.ok)throw new Error('Read-only GitHub failure '+res.status);
    return res.json();
  };
  const [pr,ci,compare,release,main]=await Promise.all([
    get('/pulls/65'),
    get('/commits/'+R30_PIN.sha+'/check-runs?per_page=100'),
    get('/compare/'+R30_PIN.parent+'...'+R30_PIN.sha),
    get('/git/commits/'+R30_PIN.sha),
    SHA.test(prev.mainSha||'')?
      get('/git/commits/'+prev.mainSha):Promise.resolve(null)
  ]);
  return evaluateR31Chain({previous:prev,r30:pr,checks:ci.check_runs||[],
    compare:{base:R30_PIN.parent,head:R30_PIN.sha,status:compare.status},
    releaseCommit:{sha:R30_PIN.sha,tree:release.tree},
    mainCommit:main?{sha:prev.mainSha,tree:main.tree}:null
  });
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw new Error('Expected --github');
    const x=await fetchR31GitHubChain();
    process.stdout.write(JSON.stringify(x)+'\n');
    if(x.observedPrs!==17||!x.sourceCiPassed||!x.ancestryVerified||
      x.productionAuthorized!==false||x.autoMergeAllowed!==false)
      process.exitCode=2;
  }catch(error){
    process.stderr.write('R31 source review NO-GO: '+error.message+'\n');
    process.exitCode=2;
  }
}
