/**
 * R18 read-only stacked PR release gate. Inspect concrete merged commits and
 * checks; never merge, deploy, provision a customer or flip a production flag.
 * Explicit human obligations cannot be derived from CI.
 */
export const CHAIN=Object.freeze([
  {number:47,base:'main',sha:'840bb083e606058a9a32450f3b3a3e881a34891e',minChecks:4},
  {number:48,base:'feat/guest-r14-production-operations-20261118',
    sha:'125df326215494f1f690db6afbe1a796bcf3509a',minChecks:2},
  {number:49,base:'feat/guest-r15-tenant-admission-20261119',
    sha:'be2fa8391a6fc837e63bee98acaa010429f410cc',minChecks:3},
  {number:51,base:'feat/guest-r16-multitenant-revocation-20261119',
    sha:'73ade05c91216913febd5ab4da2fc9a3694c1f84',minChecks:3}
]);
const MANUAL=['externalArchiveRetained','encryptedDrRestored',
  'independentLegalApproval','twoPersonOperationsApproval',
  'customerContractVerified','productionChangeWindowApproved'];
export function evaluateReleaseChain({pulls={},checks={},manual={}}={}){
  const blockers=[];
  const files=[];
  for(const step of CHAIN){
    const pr=pulls[String(step.number)]||pulls[step.number];
    const a=Array.isArray(checks[String(step.number)])?
      checks[String(step.number)]:checks[step.number];
    const refsGood=pr?.number===step.number&&pr?.base?.ref===step.base&&
      pr?.head?.sha===step.sha;
    const merged=pr?.merged===true&&typeof pr?.merged_at==='string'&&
      pr?.state==='closed';
    const ciGood=Array.isArray(a)&&a.length>=step.minChecks&&
      a.every(x=>x?.status==='completed'&&x?.conclusion==='success'&&
        x?.head_sha===step.sha);
    if(!refsGood)blockers.push('missing_or_changed_pr_'+step.number);
    if(!merged)blockers.push('unmerged_pr_'+step.number);
    if(!ciGood)blockers.push('unverified_ci_'+step.number);
    files.push({pr:step.number,refsVerified:refsGood,merged,ciPassed:ciGood});
  }
  for(const field of MANUAL)
    if(manual?.[field]!==true)blockers.push('manual_'+field+'_required');
  return {
    schema:'osmanx.guest.r18.release-review.v1',dependencies:files,
    technicalReleaseReady:blockers.length===0,
    blockers,productionActivated:false,
    customerGo:false,changesMade:false
  };
}
export async function githubSnapshot({
  repository='osmanosmanov6880-bot/osmanx-world',
  token=process.env.GITHUB_TOKEN,fetcher=fetch
}={}){
  if(!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository))
    throw Error('Invalid GitHub repository');
  const pulls={},checks={};
  async function read(path){
    const response=await fetcher('https://api.github.com/repos/'+repository+path,{
      method:'GET',redirect:'error',headers:{
        Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(token?{Authorization:'Bearer '+token}:{})
      }
    });
    if(!response.ok)throw Error('GitHub review data unavailable');
    return response.json();
  }
  for(const step of CHAIN){
    const pr=await read('/pulls/'+step.number);
    const list=await read('/commits/'+step.sha+'/check-runs?per_page=100');
    pulls[step.number]=pr;
    checks[step.number]=(list.check_runs||[]).map(x=>({
      status:x.status,conclusion:x.conclusion,head_sha:x.head_sha
    }));
  }
  return {pulls,checks};
}
const direct=process.argv[1]?.endsWith('/r18-release-gate.mjs');
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Usage: node scripts/r18-release-gate.mjs --github');
    const data=await githubSnapshot();
    const report=evaluateReleaseChain(data);
    process.stdout.write(JSON.stringify(report)+'\n');
    // Always 0 for read-only reporting. The critical action path requires a
    // separate human process and must not be auto-enabled by any result.
  }catch{
    process.stdout.write(JSON.stringify({
      schema:'osmanx.guest.r18.release-review.v1',technicalReleaseReady:false,
      blockers:['github_review_unavailable'],productionActivated:false,
      customerGo:false,changesMade:false
    })+'\n');
  }
}
