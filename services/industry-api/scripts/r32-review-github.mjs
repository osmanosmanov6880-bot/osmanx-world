/** Read-only pinned 18 PR check; NO GitHub mutation operations. */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR31GitHubChain} from './r31-review-github.mjs';
import {R31_PIN,evaluateR32Source} from '../src/guest-r32-source.mjs';
const SHA=/^[a-f0-9]{40}$/;
export async function fetchR32Source({
  repository='osmanosmanov6880-bot/osmanx-world',
  fetcher=fetch,token=process.env.GITHUB_TOKEN
}={}){
  if(repository!=='osmanosmanov6880-bot/osmanx-world')
    throw new TypeError('R32 repository is pinned');
  const prior=await fetchR31GitHubChain({repository,fetcher,token});
  const get=async p=>{
    const response=await fetcher(
      'https://api.github.com/repos/'+repository+p,{
        method:'GET',redirect:'error',
        headers:{Accept:'application/vnd.github+json',
          'User-Agent':'osmanx-r32-read-only',
          ...(token?{Authorization:'Bearer '+token}:{})}
      });
    if(!response.ok)throw new Error('R32 GitHub GET '+response.status);
    return response.json();
  };
  const [pr,ci,ancestry,commit,main]=await Promise.all([
    get('/pulls/66'),
    get('/commits/'+R31_PIN.sha+'/check-runs?per_page=100'),
    get('/compare/'+R31_PIN.parent+'...'+R31_PIN.sha),
    get('/git/commits/'+R31_PIN.sha),
    SHA.test(prior.mainSha||'')?
      get('/git/commits/'+prior.mainSha):Promise.resolve(null)
  ]);
  return evaluateR32Source({
    prior,pr,checks:ci.check_runs||[],
    ancestry:{base:R31_PIN.parent,head:R31_PIN.sha,status:ancestry.status},
    releaseCommit:{sha:R31_PIN.sha,tree:commit.tree},
    mainCommit:main?{sha:prior.mainSha,tree:main.tree}:null
  });
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Use --github for read-only source audit');
    const out=await fetchR32Source();
    process.stdout.write(JSON.stringify(out)+'\n');
    if(out.observedPrs!==18||!out.sourceCiPassed||!out.ancestryVerified||
      out.automaticMergeAllowed!==false||out.productionAuthorized!==false)
      process.exitCode=2;
  }catch(error){
    process.stderr.write('R32 source check failed closed: '+error.message+'\n');
    process.exitCode=2;
  }
}
