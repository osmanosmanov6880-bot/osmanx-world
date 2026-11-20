/**
 * R38 current head GitHub review: exact 24 PRs with predecessor R37 PR72.
 * This module uses only GET; never submits reviews, merges or edits branches.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR37MainGate}
  from './r37-main-gate.mjs';
import {evaluateR38CurrentReview}
  from '../src/guest-r38-review-policy.mjs';
const PIN='a9f6cb0b7a9c6af6d005b5a634a1c277b42e8d5f';
const JOBS=['r37-offline','r37-postgres','r37-encrypted-dr',
  'r37-reproducible','r37-release-graph'];
const HEX=/^[a-f0-9]{40}$/;
export async function fetchR38CurrentGitHubReview({
  repository='osmanosmanov6880-bot/osmanx-world',
  token=process.env.GITHUB_TOKEN,fetcher=fetch
}={}){
  if(repository!=='osmanosmanov6880-bot/osmanx-world')
    throw Error('R38 source repository pinned');
  const prior=await fetchR37MainGate({repository,token,fetcher});
  const get=async suffix=>{
    const res=await fetcher('https://api.github.com/repos/'+repository+
      suffix,{method:'GET',redirect:'error',
        headers:{Accept:'application/vnd.github+json',
          'User-Agent':'osmanx-r38-head-review-readonly',
          ...(token?{Authorization:'Bearer '+token}:{})}});
    if(!res.ok)throw Error('R38 GitHub GET failure '+res.status);
    return res.json();
  };
  const [r37,headJobs]=await Promise.all([
    get('/pulls/72'),get('/commits/'+PIN+'/check-runs?per_page=100')
  ]);
  const pinned=r37?.number===72&&r37?.head?.sha===PIN&&
    r37?.base?.ref==='feat/guest-r36-first-human-review-staging-dr-20261120'&&
    r37?.state==='open'&&r37?.merged!==true&&
    Array.isArray(headJobs?.check_runs)&&
    headJobs?.check_runs.length===headJobs?.total_count&&
    JOBS.every(name=>headJobs.check_runs.some(j=>
      j?.name===name&&j?.head_sha===PIN&&
      j?.status==='completed'&&j?.conclusion==='success'));
  if(!pinned)throw Error('Pinned PR72 changed or five CI jobs not green');
  const first=prior?.source?.ordered?.find(x=>x.pr===47);
  if(!HEX.test(first?.sourceSha||''))
    throw Error('First PR source SHA absent');
  const getPages=async(route,type)=>{
    const all=[];
    for(let page=1;page<=10;page++){
      const sep=route.includes('?')?'&':'?';
      const value=await get(route+sep+'per_page=100&page='+page);
      const rows=type==='checks'?value?.check_runs:value;
      if(!Array.isArray(rows))throw Error('Unexpected GitHub page type');
      all.push(...rows);
      if(rows.length<100)
        return {rows:all,complete:type!=='checks'||
          all.length===value.total_count};
    }
    return {rows:all,complete:false};
  };
  const [pr,reviews,checks]=await Promise.all([
    get('/pulls/47'),
    getPages('/pulls/47/reviews','reviews'),
    getPages('/commits/'+first.sourceSha+'/check-runs','checks')
  ]);
  const verdict=evaluateR38CurrentReview({
    pr,reviews:reviews.rows,reviewsComplete:reviews.complete,
    checks:checks.rows,checksComplete:checks.complete,
    requiredHead:first.sourceSha,requiredNumber:47
  });
  return {schema:'osmanx.guest.r38.github-review-evidence.v1',
    sourcePrsRequired:24,priorSourcePrs:23,pinnedR37Head:PIN,
    firstPendingPr:47,currentHeadReview:verdict,
    githubWriteCalls:0,mainChanged:false,
    productionAuthorized:false,customerGo:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Use --github read-only');
    const out=await fetchR38CurrentGitHubReview();
    process.stdout.write(JSON.stringify(out)+'\n');
    if(out.sourcePrsRequired!==24||out.githubWriteCalls!==0||
      out.productionAuthorized!==false)process.exitCode=2;
  }catch(e){
    process.stderr.write('R38 GitHub NO-GO: '+e.message+'\n');
    process.exitCode=2;
  }
}
