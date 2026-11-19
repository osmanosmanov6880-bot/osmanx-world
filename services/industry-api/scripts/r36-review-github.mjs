/**
 * R36 GitHub GET only. Reports a real first pending review and a bounded
 * patch inventory. No merge, approval, branch edit or deployment actions.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR35GitHubReview} from './r35-review-github.mjs';
import {R35_PIN,evaluateR36Source,reviewR36FirstPending}
  from '../src/guest-r36-source.mjs';
import {inspectR36FirstPrFiles}
  from '../src/guest-r36-patch-audit.mjs';
const SHA=/^[a-f0-9]{40}$/;
export async function fetchR36HumanReview({
  repository='osmanosmanov6880-bot/osmanx-world',
  token=process.env.GITHUB_TOKEN,fetcher=fetch
}={}){
  if(repository!=='osmanosmanov6880-bot/osmanx-world')
    throw Error('R36 repository name pinned');
  const priorWrap=await fetchR35GitHubReview({repository,token,fetcher});
  const prior=priorWrap?.source;
  const get=async suffix=>{
    const response=await fetcher('https://api.github.com/repos/'+
      repository+suffix,{method:'GET',redirect:'error',
        headers:{Accept:'application/vnd.github+json',
          'User-Agent':'osmanx-r36-read-only-review',
          ...(token?{Authorization:'Bearer '+token}:{})}});
    if(!response.ok)throw Error('R36 GitHub GET '+response.status);
    return response.json();
  };
  const [pr,ci,ancestry,sourceCommit,mainCommit]=await Promise.all([
    get('/pulls/70'),
    get('/commits/'+R35_PIN.sha+'/check-runs?per_page=100'),
    get('/compare/'+R35_PIN.parent+'...'+R35_PIN.sha),
    get('/git/commits/'+R35_PIN.sha),
    SHA.test(prior?.mainSha||'')?
      get('/git/commits/'+prior.mainSha):Promise.resolve(null)
  ]);
  const source=evaluateR36Source({prior,pr,
    checks:ci.check_runs||[],
    compare:{base:R35_PIN.parent,head:R35_PIN.sha,status:ancestry.status},
    commit:{sha:R35_PIN.sha,tree:sourceCommit.tree},
    mainCommit:mainCommit?{sha:prior.mainSha,tree:mainCommit.tree}:null
  });
  let review=null,inventory=null;
  if(Number.isInteger(source.firstPendingPr)&&
    source.firstPendingPr>0&&source.firstPendingPr<=1000&&
    SHA.test(source.firstPendingExpectedSha||'')){
    const no=source.firstPendingPr;
    const getPages=async route=>{
      const result=[];
      for(let page=1;page<=10;page++){
        const response=await get(route+(route.includes('?')?'&':'?')+
          'per_page=100&page='+page);
        if(!Array.isArray(response))throw Error('Not a GitHub array');
        result.push(...response);
        if(response.length<100)return {entries:result,complete:true};
      }
      return {entries:result,complete:false};
    };
    const [pending,reviews,checkRuns,changedFiles]=await Promise.all([
      get('/pulls/'+no),
      getPages('/pulls/'+no+'/reviews'),
      (async()=>{
        // Check-runs uses a paginated object. Fail closed on truncation.
        const entries=[];let complete=false;
        for(let page=1;page<=10;page++){
          const obj=await get('/commits/'+source.firstPendingExpectedSha+
            '/check-runs?per_page=100&page='+page);
          if(!obj||!Array.isArray(obj.check_runs))throw Error('Bad checks');
          entries.push(...obj.check_runs);
          if(obj.check_runs.length<100){
            complete=entries.length>=obj.total_count;break;
          }
        }
        return {entries,complete};
      })(),
      getPages('/pulls/'+no+'/files')
    ]);
    review=reviewR36FirstPending({source,pr:pending,
      reviews:reviews.entries,reviewPagesComplete:reviews.complete,
      checks:checkRuns.entries,checksComplete:checkRuns.complete});
    inventory=inspectR36FirstPrFiles({pr:pending,
      files:changedFiles.entries,complete:changedFiles.complete});
  }
  return {schema:'osmanx.guest.r36.github-human-review-handoff.v1',
    source,review,inventory,
    githubWriteCount:0,automaticMergeAllowed:false,
    customerGo:false,productionAuthorized:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Use --github for read-only R36 review');
    const result=await fetchR36HumanReview();
    process.stdout.write(JSON.stringify(result)+'\n');
    if(result.source?.observedPrs!==22||
      result.source?.sourceCiVerified!==true||
      result.source?.sourceAncestryVerified!==true||
      result.review?.productionAuthorized!==false||
      result.productionAuthorized!==false)
      process.exitCode=2;
  }catch(error){
    process.stderr.write('R36 review NO-GO: '+error.message+'\n');
    process.exitCode=2;
  }
}
