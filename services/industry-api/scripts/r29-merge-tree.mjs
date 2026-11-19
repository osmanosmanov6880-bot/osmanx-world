/**
 * R29 local ONLY, virtual merge-tree evaluation. No branch/HEAD/index/worktree
 * mutation or GitHub action. merge-tree --write-tree writes temporary git
 * OBJECTS in the ephemeral runner, never refs; is NOT an actual main merge,
 * production deployment or evidence of post-merge CI.
 */
import {execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
export const R29_MERGE_SCHEMA='osmanx.guest.r29.virtual-main-tree.v1';
const SHA=/^[a-f0-9]{40}$/;
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const text=bytes=>String(bytes).trim();
export function runR29VirtualMerge({targetSha,repoRoot=root,
  command=execFileSync}={}){
  if(!SHA.test(targetSha||''))throw new TypeError('Full exact PR source SHA required');
  const git=(args,options={})=>text(command('git',['-C',repoRoot,...args],{
    encoding:'utf8',maxBuffer:1024*1024,timeout:20000,
    env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1'},
    ...options
  }));
  const priorStatus=git(['status','--porcelain=v1','--untracked-files=no']);
  const mainSha=git(['rev-parse','--verify','refs/remotes/origin/main']);
  const commit=git(['rev-parse','--verify',targetSha+'^{commit}']);
  if(!SHA.test(mainSha)||commit!==targetSha)
    throw Error('Required exact main and target commit are unavailable');
  const parent=git(['merge-base',mainSha,targetSha]);
  if(!SHA.test(parent))throw Error('No verified local common ancestor');
  let mainIsAncestor=false;
  try{
    git(['merge-base','--is-ancestor',mainSha,targetSha]);
    mainIsAncestor=true;
  }catch(error){
    if(error?.status!==1)throw error;
  }
  const sourceTree=git(['rev-parse','--verify',targetSha+'^{tree}']);
  if(!SHA.test(sourceTree))throw Error('Source tree unavailable');
  const paths=git(['diff','--name-only','--no-ext-diff',mainSha,targetSha])
    .split('\n').filter(Boolean);
  if(paths.length>750||paths.some(p=>p.length>300||
    p.includes('\0')||p.startsWith('/')||
    p.split('/').includes('..')||
    /(^|\/)\.env$|\.pem$|\.key$|\.age$/i.test(p)))
    throw Error('Unbounded or sensitive changes in proposed tree');
  let mergedTree=null,conflicts=false;
  try{
    const output=git(['merge-tree','--write-tree',mainSha,targetSha]);
    const first=output.split('\n')[0].trim();
    if(!SHA.test(first))throw Error('Git returned no merge tree SHA');
    mergedTree=first;
  }catch(error){
    if(error?.status===1)conflicts=true;
    else throw error;
  }
  const lastMain=git(['rev-parse','--verify','refs/remotes/origin/main']);
  const lastStatus=git(['status','--porcelain=v1','--untracked-files=no']);
  if(lastMain!==mainSha||lastStatus!==priorStatus)
    throw Error('Workspace or protected ref changed during virtual merge');
  const conflictsAbsent=!conflicts&&SHA.test(mergedTree||'');
  return {
    schema:R29_MERGE_SCHEMA,mainSha,sourceSha:targetSha,
    mergeBaseSha:parent,sourceTreeSha:sourceTree,
    virtualTreeSha:conflictsAbsent?mergedTree:null,
    mainIsAncestor,conflictsAbsent,
    virtualTreeMatchesSource:conflictsAbsent&&mergedTree===sourceTree,
    changedPathCount:paths.length,
    changedPathSha256:null, // no paths/filenames leaked to owner API
    mainRefUnchanged:true,trackedWorkspaceUnchanged:true,
    ephemeralGitObjectsOnly:true,
    realMergePerformed:false,postMergeMainCiPassed:false,
    actualProductionTested:false,deployAllowed:false,
    productionAuthorized:false,customerGo:false,
    recommendation:conflictsAbsent?
      'Virtual tree computed; independent human merge/review and final main CI remain required':
      'Virtual merge conflicts detected; prohibit main merge until reviewed',
    blockers:[
      ...(conflictsAbsent?[]:['VIRTUAL_GIT_MERGE_CONFLICT']),
      ...(!mainIsAncestor?['MAIN_IS_NOT_ANCESTOR_OF_SOURCE']:[]),
      'HUMAN_SOURCE_REVIEW_AND_ACTUAL_MERGE_REQUIRED',
      'FRESH_CI_ON_FINAL_MAIN_REQUIRED'
    ]
  };
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==4||process.argv[2]!=='--git'||
       process.env.CI!=='true'||process.env.GITHUB_ACTIONS!=='true')
      throw Error('Run --git SHA only on a temporary CI checkout');
    const report=runR29VirtualMerge({targetSha:process.argv[3]});
    process.stdout.write(JSON.stringify(report)+'\n');
    if(!report.conflictsAbsent||!report.mainIsAncestor)process.exitCode=2;
  }catch{
    process.stdout.write(JSON.stringify({
      schema:R29_MERGE_SCHEMA,conflictsAbsent:false,
      mainRefUnchanged:false,trackedWorkspaceUnchanged:false,
      blockers:['VIRTUAL_MERGE_NOT_VERIFIED'],
      realMergePerformed:false,postMergeMainCiPassed:false,
      productionAuthorized:false,customerGo:false})+'\n');
    process.exitCode=2;
  }
}
