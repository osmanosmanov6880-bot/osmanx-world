/**
 * R20 release genealogy and per-check SHA pinning. READ-ONLY GitHub calls.
 * Never triggers merge, deployment, production write flag, or customer GO.
 * A green CI result on the WRONG SHA or wrong PR base cannot pass.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const RELEASE_CHAIN=Object.freeze([
  {number:47,base:'main',head:'feat/guest-r14-production-operations-20261118',
   sha:'840bb083e606058a9a32450f3b3a3e881a34891e',
   checks:['industry-api','ops-contract','encrypted-backup-restore','package-and-smoke']},
  {number:48,base:'feat/guest-r14-production-operations-20261118',
   head:'feat/guest-r15-tenant-admission-20261119',
   sha:'125df326215494f1f690db6afbe1a796bcf3509a',
   checks:['r15-postgres','r15-offline']},
  {number:49,base:'feat/guest-r15-tenant-admission-20261119',
   head:'feat/guest-r16-multitenant-revocation-20261119',
   sha:'be2fa8391a6fc837e63bee98acaa010429f410cc',
   checks:['r16-source-release','r16-postgres','r16-offline']},
  {number:51,base:'feat/guest-r16-multitenant-revocation-20261119',
   head:'feat/guest-r17-witness-fence-onboarding-20261119',
   sha:'73ade05c91216913febd5ab4da2fc9a3694c1f84',
   checks:['r17-postgres','r17-offline','r17-reproducible']},
  {number:52,base:'feat/guest-r17-witness-fence-onboarding-20261119',
   head:'feat/guest-r18-external-anchor-recovery-20261119',
   sha:'8418a02718610fbc0728460437b457afb44c951c',
   checks:['r18-offline','r18-postgres','r18-encrypted-dr','r18-reproducible']},
  {number:53,base:'feat/guest-r18-external-anchor-recovery-20261119',
   head:'feat/guest-r19-single-pilot-controlled-rollout-20261119',
   sha:'3f43ffe7ac94a5d598f1df1a7701a3ccf45c1136',
   checks:['r19-offline','r19-postgres','r19-encrypted-dr','r19-reproducible']}
]);
export const CHAIN_SCHEMA='osmanx.guest.r20.release-chain.v1';
const ALL_APPROVALS=Object.freeze([
  'independentCodeReview','legalBasisSignedOff','contractVerified',
  'offsiteWormReceiptVerified','twoKeyDrRestoreVerified',
  'rollbackExerciseWitnessed','operationalChangeWindowApproved'
]);
function stringMap(x){return x!==null&&typeof x==='object'&&!Array.isArray(x)?x:{};}
export function evaluateR20Chain({pulls={},checks={},ancestry={},approvals={}}={}){
  const blockers=[],rows=[];
  const p=stringMap(pulls),c=stringMap(checks),a=stringMap(ancestry);
  for(let i=0;i<RELEASE_CHAIN.length;i++){
    const x=RELEASE_CHAIN[i];
    const pr=p[x.number],jobs=c[x.number];
    const refsGood=pr?.number===x.number&&pr?.head?.ref===x.head&&
      pr?.head?.sha===x.sha&&pr?.base?.ref===x.base;
    const approvedChecks=Array.isArray(jobs)&&x.checks.every(name=>
      jobs.some(job=>job?.name===name&&job?.status==='completed'&&
        job?.conclusion==='success'&&job?.head_sha===x.sha));
    const mergeDone=pr?.merged===true&&pr?.state==='closed'&&
      typeof pr?.merged_at==='string'&&Number.isFinite(Date.parse(pr.merged_at));
    // For staged PRs: every child commit must descend from its parent HEAD.
    // The comparison is between immutable pinned SHAs, not moving refs.
    const parent=RELEASE_CHAIN[i-1];
    const ancestorOk=!parent||(
      a[parent.number+'>'+x.number]?.base===parent.sha&&
      a[parent.number+'>'+x.number]?.head===x.sha&&
      ['ahead','identical'].includes(a[parent.number+'>'+x.number]?.status)
    );
    if(!refsGood)blockers.push('pr_changed_'+x.number);
    if(!approvedChecks)blockers.push('required_checks_missing_'+x.number);
    if(!ancestorOk)blockers.push('stack_ancestry_invalid_'+x.number);
    if(!mergeDone)blockers.push('unmerged_'+x.number);
    rows.push({pr:x.number,headPinned:refsGood,ciPassed:approvedChecks,
      parentCommitAncestor:ancestorOk,merged:mergeDone,
      requiredJobCount:x.checks.length});
  }
  const manual=stringMap(approvals);
  for(const key of ALL_APPROVALS){
    // API-returned booleans are not independent proof; manual approvals are
    // NOT accepted by this software as a deployment authorization.
    if(manual[key]!==true)blockers.push('manual_'+key+'_missing');
  }
  const stagedCodeVerified=rows.every(x=>
    x.headPinned&&x.ciPassed&&x.parentCommitAncestor);
  return {schema:CHAIN_SCHEMA,
    dependencies:rows,stagedCodeVerified,
    allDependenciesMerged:rows.every(x=>x.merged),
    documentaryChecklistComplete:ALL_APPROVALS.every(x=>manual[x]===true),
    blockers,automatedCustomerGo:false,productionActivated:false,
    secretsTransmitted:false,changesMade:false,
    warning:'CI and human declarations do not authorize deployment or data collection.'};
}
export async function fetchR20GitHub({repository='osmanosmanov6880-bot/osmanx-world',
  token=process.env.GITHUB_TOKEN,fetcher=fetch}={}){
  if(!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository))
    throw Error('Invalid repository');
  const base='https://api.github.com/repos/'+repository;
  async function get(route){
    const r=await fetcher(base+route,{
      method:'GET',redirect:'error',headers:{
        Accept:'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(token?{Authorization:'Bearer '+token}:{})
      }
    });
    if(!r.ok)throw Error('R20 GitHub read-only dependency unavailable');
    return r.json();
  }
  const pulls={},checks={},ancestry={};
  for(let i=0;i<RELEASE_CHAIN.length;i++){
    const x=RELEASE_CHAIN[i],prev=RELEASE_CHAIN[i-1];
    const [pr,ci,compare]=await Promise.all([
      get('/pulls/'+x.number),
      get('/commits/'+x.sha+'/check-runs?per_page=100'),
      prev?get('/compare/'+prev.sha+'...'+x.sha):Promise.resolve(null)
    ]);
    pulls[x.number]=pr;
    checks[x.number]=(ci.check_runs||[]).map(j=>({
      name:j.name,status:j.status,conclusion:j.conclusion,head_sha:j.head_sha
    }));
    if(prev)ancestry[prev.number+'>'+x.number]={
      base:prev.sha,head:x.sha,status:compare?.status
    };
  }
  return {pulls,checks,ancestry};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--github')
      throw Error('Use --github');
    const report=evaluateR20Chain(await fetchR20GitHub());
    process.stdout.write(JSON.stringify(report)+'\n');
    // Read-only: staged chain can be in draft and still produce a report.
  }catch{
    process.stdout.write(JSON.stringify({
      schema:CHAIN_SCHEMA,stagedCodeVerified:false,
      allDependenciesMerged:false,automatedCustomerGo:false,
      blockers:['github_dependency_unavailable'],productionActivated:false,
      changesMade:false
    })+'\n');
    process.exitCode=2;
  }
}
