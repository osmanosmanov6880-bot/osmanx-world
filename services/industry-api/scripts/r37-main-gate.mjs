/**
 * Read-only GitHub post-merge gate. Always returns NO-GO; a complete source
 * chain and green merged-main CI are not sufficient for customer collection.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR36HumanReview}
  from './r36-review-github.mjs';
import {R36_PIN,evaluateR37ReleaseChain,evaluateR37PostMerge}
  from '../src/guest-r37-postmerge.mjs';
const HEX=/^[a-f0-9]{40}$/;
export async function fetchR37MainGate({
  repository='osmanosmanov6880-bot/osmanx-world',
  token=process.env.GITHUB_TOKEN,fetcher=fetch,
  now=new Date()
}={}){
  if(repository!=='osmanosmanov6880-bot/osmanx-world')
    throw Error('R37 exact repository required');
  const prior=await fetchR36HumanReview({repository,token,fetcher});
  const get=async suffix=>{
    const res=await fetcher('https://api.github.com/repos/'+repository+
      suffix,{method:'GET',redirect:'error',
        headers:{Accept:'application/vnd.github+json',
          'User-Agent':'osmanx-r37-read-only-main-gate',
          ...(token?{Authorization:'Bearer '+token}:{})}});
    if(!res.ok)throw Error('R37 GitHub read failed: '+res.status);
    return res.json();
  };
  const [pr,ci,comp,commit,mainRef]=await Promise.all([
    get('/pulls/71'),
    get('/commits/'+R36_PIN.sha+'/check-runs?per_page=100'),
    get('/compare/'+R36_PIN.parent+'...'+R36_PIN.sha),
    get('/git/commits/'+R36_PIN.sha),
    get('/git/ref/heads/main')
  ]);
  const source=evaluateR37ReleaseChain({
    prior:prior.source,pr,ci:ci.check_runs||[],
    compare:{status:comp.status,base:R36_PIN.parent,head:R36_PIN.sha},
    releaseCommit:{sha:R36_PIN.sha,tree:commit.tree}
  });
  const mainSha=mainRef?.object?.sha;
  const [prs,mainCommit,mainCi]=await Promise.all([
    Promise.all(source.ordered.map(entry=>get('/pulls/'+entry.pr))),
    HEX.test(mainSha||'')?get('/git/commits/'+mainSha):Promise.resolve(null),
    HEX.test(mainSha||'')?
      get('/commits/'+mainSha+'/check-runs?per_page=100'):
      Promise.resolve(null)
  ]);
  const result=evaluateR37PostMerge({source,prs,
    mainRef:{ref:'refs/heads/main',object:mainRef.object},
    mainCommit:mainCommit?{sha:mainSha,tree:mainCommit.tree}:null,
    mainChecks:mainCi?.check_runs||[],
    checksComplete:Boolean(mainCi&&Array.isArray(mainCi.check_runs)&&
      mainCi.check_runs.length===mainCi.total_count),now});
  return {schema:'osmanx.guest.r37.github-readonly-audit.v1',
    source,postMerge:result,
    githubWriteCalls:0,productionAuthorized:false,customerGo:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Use --github for GitHub READ-ONLY audit');
    const out=await fetchR37MainGate();
    process.stdout.write(JSON.stringify(out)+'\n');
    if(out.source.observedPrs!==23||
      out.source.r36CiPassed!==true||
      out.productionAuthorized!==false)
      process.exitCode=2;
  }catch(e){
    process.stderr.write('R37 source NO-GO: '+e.message+'\n');
    process.exitCode=2;
  }
}
