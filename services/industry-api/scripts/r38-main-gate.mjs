/**
 * Full 24-PR read-only source+main audit, with two snapshots of main.
 * Does not approve, merge, deploy or access customer/staging resources.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR37MainGate}
  from './r37-main-gate.mjs';
import {R37_PIN,evaluateR38Source,evaluateR38MainAncestry}
  from '../src/guest-r38-mainline.mjs';
const HEX=/^[a-f0-9]{40}$/;
export async function fetchR38Mainline({
  repository='osmanosmanov6880-bot/osmanx-world',
  token=process.env.GITHUB_TOKEN,fetcher=fetch,now=new Date()
}={}){
  if(repository!=='osmanosmanov6880-bot/osmanx-world')
    throw Error('Only pinned source repository is supported');
  const prior=await fetchR37MainGate({repository,token,fetcher,now});
  const get=async path=>{
    const response=await fetcher('https://api.github.com/repos/'+
      repository+path,{method:'GET',redirect:'error',
        headers:{Accept:'application/vnd.github+json',
          'User-Agent':'osmanx-r38-read-only-ancestry',
          ...(token?{Authorization:'Bearer '+token}:{})}});
    if(!response.ok)throw Error('GitHub read-only status '+response.status);
    return response.json();
  };
  const [pr,checks,compare,commit,mainBefore]=await Promise.all([
    get('/pulls/72'),
    get('/commits/'+R37_PIN.sha+'/check-runs?per_page=100'),
    get('/compare/'+R37_PIN.parent+'...'+R37_PIN.sha),
    get('/git/commits/'+R37_PIN.sha),
    get('/git/ref/heads/main')
  ]);
  const source=evaluateR38Source({prior:prior.source,pr,
    checks:checks.check_runs,
    comparison:{base:R37_PIN.parent,head:R37_PIN.sha,
      status:compare.status},
    commit:{sha:R37_PIN.sha,tree:commit.tree}});
  const mainSha=mainBefore?.object?.sha;
  let mainCommit=null,mainChecks=[],mainChecksComplete=false,
    ancestry=null;
  const extra=source.ordered.map(e=>get('/pulls/'+e.pr));
  if(HEX.test(mainSha||'')){
    extra.push(get('/git/commits/'+mainSha).then(x=>mainCommit=x));
    extra.push(get('/compare/'+R37_PIN.sha+'...'+mainSha).then(x=>
      ancestry={base:R37_PIN.sha,head:mainSha,
        status:x.status,mergeBaseSha:x.merge_base_commit?.sha}));
    extra.push((async()=>{
      for(let page=1;page<=10;page++){
        const v=await get('/commits/'+mainSha+
          '/check-runs?per_page=100&page='+page);
        if(!Array.isArray(v?.check_runs)||
          !Number.isInteger(v.total_count))
          throw Error('Untrusted check-runs pagination');
        mainChecks.push(...v.check_runs);
        if(mainChecks.length>=v.total_count){
          mainChecksComplete=true;break;
        }
        if(v.check_runs.length<100)break;
      }
    })());
  }
  const list=await Promise.all(extra);
  const prs=list.slice(0,source.ordered.length);
  const mainAfter=await get('/git/ref/heads/main');
  const postMerge=evaluateR38MainAncestry({source,prs,
    mainBefore:{ref:'refs/heads/main',object:mainBefore.object},
    mainAfter:{ref:'refs/heads/main',object:mainAfter.object},
    mainCommit:mainCommit?{sha:mainSha,tree:mainCommit.tree}:null,
    ancestry,checks:mainChecks,checksComplete:mainChecksComplete,now});
  return {schema:'osmanx.guest.r38.github-readonly-audit.v1',
    source,postMerge,gitHubWriteOperations:0,
    automaticMergeAllowed:false,productionAuthorized:false,
    customerGo:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Read-only --github mode required');
    const out=await fetchR38Mainline();
    process.stdout.write(JSON.stringify(out)+'\n');
    if(out.source.observedPrs!==24||!out.source.r37CiPassed||
      out.source.blockers.length||out.productionAuthorized!==false)
      process.exitCode=2;
  }catch(error){
    process.stderr.write('R38 release chain NO-GO: '+error.message+'\n');
    process.exitCode=2;
  }
}
