/**
 * GitHub read-only R39 PR47 reviewer packet. Retrieves live PATCHES, does not
 * submit an approval and does not mutate any GitHub source ref.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchR38CurrentGitHubReview}
  from './r38-github-review.mjs';
import {buildR39FirstPrPacket}
  from '../src/guest-r39-review-packet.mjs';
export async function fetchR39FirstPrReview({
  token=process.env.GITHUB_TOKEN,fetcher=fetch,
  repository='osmanosmanov6880-bot/osmanx-world'
}={}){
  if(repository!=='osmanosmanov6880-bot/osmanx-world')
    throw Error('R39 pinned repository required');
  const previous=await fetchR38CurrentGitHubReview({
    repository,token,fetcher});
  const get=async path=>{
    const response=await fetcher('https://api.github.com/repos/'+repository+
      path,{method:'GET',redirect:'error',headers:{
        Accept:'application/vnd.github+json',
        'User-Agent':'osmanx-r39-readonly-pr47-packet',
        ...(token?{Authorization:'Bearer '+token}:{})
      }});
    if(!response.ok)throw Error('GitHub GET not successful '+response.status);
    return response.json();
  };
  const [pr,commit]=await Promise.all([
    get('/pulls/47'),
    get('/git/commits/840bb083e606058a9a32450f3b3a3e881a34891e')
  ]);
  const files=[];let complete=false;
  for(let page=1;page<=10;page++){
    const pageFiles=await get('/pulls/47/files?per_page=100&page='+page);
    if(!Array.isArray(pageFiles))throw Error('Unexpected PR file page');
    files.push(...pageFiles);
    if(pageFiles.length<100){complete=files.length===pr.changed_files;break}
  }
  const packet=buildR39FirstPrPacket({pr,commit,files,
    filesComplete:complete,review:previous.currentHeadReview});
  return {schema:'osmanx.guest.r39.github-review-run.v1',
    packet,githubWriteCalls:0,customerGo:false,
    productionAuthorized:false};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Use --github (read-only)');
    const report=await fetchR39FirstPrReview();
    process.stdout.write(JSON.stringify(report)+'\n');
    if(report.packet.blockers.length||report.githubWriteCalls!==0)
      process.exitCode=2;
  }catch(error){
    process.stderr.write('R39 review packet NO-GO: '+error.message+'\n');
    process.exitCode=2;
  }
}
