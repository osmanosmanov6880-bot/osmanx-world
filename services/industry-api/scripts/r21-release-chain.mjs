/**
 * R21 release-chain extension: ALL R14-R20 PRs (seven stacked stages).
 * Read-only API; pin R20 source SHA and require ALL FIVE named checks.
 * No deployment, no merge and no implicit customer authorization.
 */
import {evaluateR20Chain,fetchR20GitHub,RELEASE_CHAIN}
  from './r20-release-chain.mjs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const R20_PR=Object.freeze({
  number:54,base:'feat/guest-r19-single-pilot-controlled-rollout-20261119',
  head:'feat/guest-r20-release-control-dr-20261119',
  sha:'aac97ee3d55758cc32776284fb69cffb34c94f06',
  checks:['r20-offline','r20-postgres','r20-encrypted-dr',
    'r20-reproducible','r20-release-graph']
});
export const R21_CHAIN_SCHEMA='osmanx.guest.r21.seven-stage-release.v1';

export function evaluateR21Chain({prior={},r20=null,checks=[],compare=null}={}){
  const base=evaluateR20Chain(prior);
  const blockers=[...base.blockers];
  const head=R20_PR;
  const refValid=r20?.number===head.number&&r20?.head?.ref===head.head&&
    r20?.head?.sha===head.sha&&r20?.base?.ref===head.base;
  const jobValid=Array.isArray(checks)&&head.checks.every(name=>
    checks.some(job=>job?.name===name&&job?.status==='completed'&&
      job?.conclusion==='success'&&job?.head_sha===head.sha));
  const parent=RELEASE_CHAIN[RELEASE_CHAIN.length-1];
  const ancestryValid=compare?.base===parent.sha&&compare?.head===head.sha&&
    ['ahead','identical'].includes(compare?.status);
  const merged=r20?.merged===true&&r20?.state==='closed'&&
    typeof r20?.merged_at==='string'&&Number.isFinite(Date.parse(r20.merged_at));
  if(!refValid)blockers.push('r20_pr_changed');
  if(!jobValid)blockers.push('r20_named_ci_missing');
  if(!ancestryValid)blockers.push('r20_parent_ancestry_changed');
  if(!merged)blockers.push('r20_not_merged');
  const dependencies=[...base.dependencies,{
    pr:head.number,headPinned:refValid,ciPassed:jobValid,
    parentCommitAncestor:ancestryValid,merged,
    requiredJobCount:head.checks.length
  }];
  const stagedCodeVerified=base.stagedCodeVerified&&refValid&&
    jobValid&&ancestryValid;
  return {schema:R21_CHAIN_SCHEMA,dependencies,stagedCodeVerified,
    allDependenciesMerged:base.allDependenciesMerged&&merged,
    manualChecklistComplete:base.documentaryChecklistComplete,
    blockers,automaticCustomerGo:false,automaticProductionApproval:false,
    changedProduction:false,codeReviewRequired:true};
}
export async function fetchR21Chain({repository='osmanosmanov6880-bot/osmanx-world',
  fetcher=fetch,token=process.env.GITHUB_TOKEN}={}){
  if(!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository))
    throw Error('Invalid repository');
  const prior=await fetchR20GitHub({repository,fetcher,token});
  const prefix='https://api.github.com/repos/'+repository;
  async function get(path){
    const response=await fetcher(prefix+path,{
      method:'GET',redirect:'error',headers:{
        Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(token?{Authorization:'Bearer '+token}:{})
      }
    });
    if(!response.ok)throw Error('R21 release evidence unavailable');
    return response.json();
  }
  const parent=RELEASE_CHAIN[RELEASE_CHAIN.length-1];
  const [r20,ci,c]=await Promise.all([
    get('/pulls/'+R20_PR.number),
    get('/commits/'+R20_PR.sha+'/check-runs?per_page=100'),
    get('/compare/'+parent.sha+'...'+R20_PR.sha)
  ]);
  return {prior,r20,
    checks:(ci.check_runs||[]).map(j=>({
      name:j.name,status:j.status,conclusion:j.conclusion,
      head_sha:j.head_sha
    })),
    compare:{base:parent.sha,head:R20_PR.sha,status:c.status}};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('R21 requires --github');
    const report=evaluateR21Chain(await fetchR21Chain());
    process.stdout.write(JSON.stringify(report)+'\n');
    // Read-only reports can succeed even while PRs remain correctly draft.
  }catch{
    process.stdout.write(JSON.stringify({schema:R21_CHAIN_SCHEMA,
      stagedCodeVerified:false,allDependenciesMerged:false,
      automaticCustomerGo:false,automaticProductionApproval:false,
      blockers:['github_release_graph_unavailable'],changedProduction:false})+'\n');
    process.exitCode=2;
  }
}
