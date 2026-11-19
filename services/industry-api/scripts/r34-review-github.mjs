/** Read-only exact 20-PR check. No merge/deploy/dispatch. */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR33GitHubSource} from './r33-review-github.mjs';
import {R33_PIN,evaluateR34Source} from '../src/guest-r34-source.mjs';
const SHA=/^[a-f0-9]{40}$/;
export async function fetchR34GitHubSource({
  repository='osmanosmanov6880-bot/osmanx-world',
  fetcher=fetch,token=process.env.GITHUB_TOKEN
}={}){
  if(repository!=='osmanosmanov6880-bot/osmanx-world')
    throw new TypeError('R34 repository must be pinned');
  const prior=await fetchR33GitHubSource({repository,fetcher,token});
  const get=async path=>{
    const response=await fetcher(
      'https://api.github.com/repos/'+repository+path,{
        method:'GET',redirect:'error',
        headers:{Accept:'application/vnd.github+json',
          'User-Agent':'osmanx-r34-readonly',
          ...(token?{Authorization:'Bearer '+token}:{})}
      });
    if(!response.ok)throw Error('Read-only GitHub '+response.status);
    return response.json();
  };
  const [pr,ci,compare,source,main]=await Promise.all([
    get('/pulls/68'),
    get('/commits/'+R33_PIN.sha+'/check-runs?per_page=100'),
    get('/compare/'+R33_PIN.parent+'...'+R33_PIN.sha),
    get('/git/commits/'+R33_PIN.sha),
    SHA.test(prior.mainSha||'')?
      get('/git/commits/'+prior.mainSha):Promise.resolve(null)
  ]);
  return evaluateR34Source({prior,pr,checks:ci.check_runs||[],
    ancestry:{base:R33_PIN.parent,head:R33_PIN.sha,status:compare.status},
    releaseCommit:{sha:R33_PIN.sha,tree:source.tree},
    mainCommit:main?{sha:prior.mainSha,tree:main.tree}:null});
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Require --github');
    const result=await fetchR34GitHubSource();
    process.stdout.write(JSON.stringify(result)+'\n');
    if(result.observedPrs!==20||!result.sourceCiPassed||
      !result.ancestryVerified||result.automaticMergeAllowed!==false||
      result.productionAuthorized!==false)process.exitCode=2;
  }catch(error){
    process.stderr.write('R34 source NO-GO: '+error.message+'\n');
    process.exitCode=2;
  }
}
