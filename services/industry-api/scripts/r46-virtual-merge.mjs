/**
 * R46 true Git tree simulation of 32 PRs in the disposable CI repository.
 * This NEVER calls git merge/rebase/checkout/push/update-ref and it never
 * writes to remote GitHub. Synthetic commit-tree objects are unreachable.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {R46_PINNED_STACK} from '../src/guest-r46-source-graph.mjs';
import {assessR46VirtualMerge} from '../src/guest-r46-virtual-merge.mjs';
const SHA=/^[a-f0-9]{40}$/;
function git(args,{allowConflict=false}={}){
 const result=spawnSync('git',args,{encoding:'utf8',maxBuffer:3*1024*1024,
   timeout:120000,env:{...process.env,GIT_TERMINAL_PROMPT:'0',
     GIT_AUTHOR_NAME:'OSMANX synthetic proof',
     GIT_AUTHOR_EMAIL:'proof@example.invalid',
     GIT_COMMITTER_NAME:'OSMANX synthetic proof',
     GIT_COMMITTER_EMAIL:'proof@example.invalid',
     GIT_AUTHOR_DATE:'2001-01-01T00:00:00Z',
     GIT_COMMITTER_DATE:'2001-01-01T00:00:00Z'
   }});
 if(result.error||(result.status!==0&&(!allowConflict||result.status!==1)))
   throw Error('R46 local Git stage failed: '+args[0]);
 return result;
}
const outputSha=r=>{
 const val=r.stdout?.trim();
 if(r.status!==0||!SHA.test(val||''))throw Error('R46 source SHA invalid');
 return val;
};
const refFingerprint=()=>{
 const refs=git(['for-each-ref','--format=%(refname) %(objectname)',
   'refs/heads','refs/remotes']).stdout;
 return createHash('sha256').update(refs).digest('hex');
};
const safePaths=list=>Array.isArray(list)&&list.length<=1000&&
 list.every(p=>typeof p==='string'&&p.length<1024&&
 !p.startsWith('/')&&!p.includes('\\')&&
 !/[\x00-\x1f\x7f\ufffd]/.test(p)&&
 p.split('/').every(x=>x&&x!=='.'&&x!=='..'));
export function runR46VirtualRehearsal(){
 const before=refFingerprint();
 const mainSha=outputSha(git(['rev-parse','--verify','refs/remotes/origin/main']));
 let current=mainSha,lastSource=null;
 const steps=[];
 for(const expected of R46_PINNED_STACK){
   // Fail if this checkout is incomplete or a future source doesn't descend
   // from the previous pinned source in the declared PR chain.
   git(['cat-file','-e',expected.sha+'^{commit}']);
   if(lastSource)
     git(['merge-base','--is-ancestor',lastSource,expected.sha]);
   const raw=git(['merge-tree','--write-tree','--name-only','--no-messages',
     current,expected.sha],{allowConflict:true});
   const lines=raw.stdout.trimEnd().split('\n');
   const treeSha=lines[0];
   const conflictPaths=raw.status===1?lines.slice(1).filter(Boolean):[];
   if(!SHA.test(treeSha||'')||
      raw.status===0&&lines.length!==1||
      raw.status===1&&!conflictPaths.length||
      !safePaths(conflictPaths))
     throw Error('R46 real Git merge-tree output invalid');
   git(['cat-file','-e',treeSha+'^{tree}']);
   let syntheticCommit=null;
   if(raw.status===0){
     syntheticCommit=outputSha(git([
       'commit-tree',treeSha,'-p',current,'-p',expected.sha,
       '-m','R46 synthetic review-only tree for PR '+expected.number
     ]));
   }
   steps.push({number:expected.number,sourceSha:expected.sha,
     baseBefore:current,treeSha,mergeExitCode:raw.status,
     conflictPaths,syntheticCommit});
   if(raw.status===1)break;
   current=syntheticCommit;lastSource=expected.sha;
 }
 const after=refFingerprint();
 const latestMain=outputSha(git([
   'rev-parse','--verify','refs/remotes/origin/main'
 ]));
 if(latestMain!==mainSha)throw Error('R46 origin/main ref changed during rehearsal');
 const result=assessR46VirtualMerge({
   mainSha,steps,branchRefsBefore:before,branchRefsAfter:after
 });
 if(!result.valid||result.branchRefsModified)
   throw Error('R46 virtual Git proof corrupted or changed refs');
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
   if(process.argv.length!==3||process.argv[2]!=='--json')
     throw Error('R46 only --json is supported');
   process.stdout.write(JSON.stringify(runR46VirtualRehearsal())+'\n');
 }catch(error){
   process.stderr.write('R46 virtual Git rehearsal NO-GO: '+
     String(error.message).replace(/[^a-zA-Z0-9 .:_-]/g,'').slice(0,140)+'\n');
   process.exitCode=2;
 }
}
