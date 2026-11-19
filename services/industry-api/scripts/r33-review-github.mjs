/** R33 exact source chain: read-only GitHub GET requests. */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR32Source} from './r32-review-github.mjs';
import {R32_PIN,evaluateR33Source} from '../src/guest-r33-source.mjs';
const SHA=/^[a-f0-9]{40}$/;
export async function fetchR33GitHubSource({
  repository='osmanosmanov6880-bot/osmanx-world',
  token=process.env.GITHUB_TOKEN,fetcher=fetch
}={}){
  if(repository!=='osmanosmanov6880-bot/osmanx-world')
    throw new TypeError('Repository mismatch');
  const prior=await fetchR32Source({repository,token,fetcher});
  const get=async p=>{
    const response=await fetcher(
      'https://api.github.com/repos/'+repository+p,{
        method:'GET',redirect:'error',
        headers:{Accept:'application/vnd.github+json',
          'User-Agent':'osmanx-r33-readonly',
          ...(token?{Authorization:'Bearer '+token}:{})}
      });
    if(!response.ok)throw new Error('R33 GitHub GET '+response.status);
    return response.json();
  };
  const [pr,ci,compare,sourceCommit,mainCommit]=await Promise.all([
    get('/pulls/67'),
    get('/commits/'+R32_PIN.sha+'/check-runs?per_page=100'),
    get('/compare/'+R32_PIN.parent+'...'+R32_PIN.sha),
    get('/git/commits/'+R32_PIN.sha),
    SHA.test(prior.mainSha||'')?
      get('/git/commits/'+prior.mainSha):Promise.resolve(null)
  ]);
  return evaluateR33Source({
    prior,pr,checks:ci.check_runs||[],
    ancestry:{base:R32_PIN.parent,head:R32_PIN.sha,status:compare.status},
    releaseCommit:{sha:R32_PIN.sha,tree:sourceCommit.tree},
    mainCommit:mainCommit?{sha:prior.mainSha,tree:mainCommit.tree}:null
  });
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Use --github for read-only review');
    const result=await fetchR33GitHubSource();
    process.stdout.write(JSON.stringify(result)+'\n');
    if(result.observedPrs!==19||!result.sourceCiPassed||
      !result.ancestryVerified||result.productionAuthorized!==false||
      result.automaticMergeAllowed!==false)process.exitCode=2;
  }catch(error){
    process.stderr.write('R33 source review NO-GO: '+error.message+'\n');
    process.exitCode=2;
  }
}
