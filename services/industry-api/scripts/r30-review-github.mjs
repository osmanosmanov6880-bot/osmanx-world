/**
 * R30 GitHub source inspector: GET only. No merge, dispatch, branch update,
 * deploy, credential export or customer data requests.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR29SourceTree,evaluateR29SourceTree}
  from './r29-source-tree.mjs';
import {R29_PIN,evaluateR30SourceReview}
  from '../src/guest-r30-source-review.mjs';
const SHA=/^[a-f0-9]{40}$/;
export async function fetchR30GitHubReview({
  repository='osmanosmanov6880-bot/osmanx-world',
  token=process.env.GITHUB_TOKEN,fetcher=fetch
}={}){
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new TypeError('Repository must be explicitly scoped');
  const prior=evaluateR29SourceTree(await fetchR29SourceTree({
    repository,token,fetcher}));
  const get=async p=>{
    const response=await fetcher('https://api.github.com/repos/'+repository+p,{
      method:'GET',headers:{Accept:'application/vnd.github+json',
        'User-Agent':'osmanx-guest-r30-readonly',
        ...(token?{Authorization:'Bearer '+token}:{})},
      redirect:'error'
    });
    if(!response.ok)throw new Error('GitHub read-only '+response.status);
    return response.json();
  };
  const [pr,ci,compare,commit,mainCommit]=await Promise.all([
    get('/pulls/'+R29_PIN.number),
    get('/commits/'+R29_PIN.sha+'/check-runs?per_page=100'),
    get('/compare/'+R29_PIN.parent+'...'+R29_PIN.sha),
    get('/git/commits/'+R29_PIN.sha),
    SHA.test(prior.mainSha||'')?
      get('/git/commits/'+prior.mainSha):Promise.resolve(null)
  ]);
  return evaluateR30SourceReview({
    previous:prior,r29:pr,
    checks:ci.check_runs||[],
    ancestry:{base:R29_PIN.parent,head:R29_PIN.sha,status:compare.status},
    sourceCommit:{sha:R29_PIN.sha,tree:commit.tree},
    mainCommit:mainCommit?{sha:prior.mainSha,tree:mainCommit.tree}:null
  });
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw new Error('Use --github (read-only)');
    const out=await fetchR30GitHubReview();
    process.stdout.write(JSON.stringify(out)+'\n');
    if(out.sourcePrsObserved!==16||out.headCommit!==R29_PIN.sha||
      !out.sourceNamedCiPassed||!out.parentAncestryVerified||
      out.customerGo!==false||out.automaticMergeAllowed!==false)
      process.exitCode=2;
  }catch(err){
    process.stderr.write('R30 source review failed closed: '+err.message+'\n');
    process.exitCode=2;
  }
}
