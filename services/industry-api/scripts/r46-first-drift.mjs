/** R46 real first-PR drift inventory, only in a disposable full Git checkout. */
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {R46_PINNED_STACK} from '../src/guest-r46-source-graph.mjs';
import {assessR46FirstDrift} from '../src/guest-r46-first-drift.mjs';
const SHA=/^[a-f0-9]{40}$/;
function git(args,{binary=false}={}){
 const r=spawnSync('git',args,{encoding:binary?null:'utf8',
   timeout:60000,maxBuffer:5*1024*1024,env:{
     ...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'
   }});
 if(r.error||r.status!==0)
   throw Error('R46 read-only Git operation failed: '+args[0]+' '+args[1]);
 return r.stdout;
}
const paths=(a,b)=>{
 const output=git(['diff','--name-only','-z',a,b],{binary:true});
 if(output.length>4*1024*1024)throw Error('R46 diff exceeds safe limit');
 const parts=output.toString('utf8').split('\0');
 if(parts.at(-1)!=='')throw Error('R46 Git path stream not NUL terminated');
 parts.pop();
 return parts;
};
export function runR46DriftAudit(){
 const mainSha=git(['rev-parse','--verify','refs/remotes/origin/main']).trim();
 if(!SHA.test(mainSha))throw Error('R46 current main SHA unreadable');
 const sourceSha=R46_PINNED_STACK[0].sha;
 git(['cat-file','-e',sourceSha+'^{commit}']);
 const mergeBaseSha=git(['merge-base',mainSha,sourceSha]).trim();
 if(!SHA.test(mergeBaseSha))
   throw Error('R46 merge-base SHA invalid');
 const mainChangedPaths=paths(mergeBaseSha,mainSha);
 const sourceChangedPaths=paths(mergeBaseSha,sourceSha);
 const report=assessR46FirstDrift({mergeBaseSha,mainSha,sourceSha,
   mainChangedPaths,sourceChangedPaths});
 if(!report.valid)throw Error('R46 first source patch differs from verified PR47');
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
   if(process.argv.length!==3||process.argv[2]!=='--json')
     throw Error('R46 only --json is supported');
   process.stdout.write(JSON.stringify(runR46DriftAudit())+'\n');
 }catch(error){
   process.stderr.write('R46 first-patch review NO-GO: '+
     String(error.message).replace(/[^a-zA-Z0-9._ :-]/g,'').slice(0,120)+'\n');
   process.exitCode=2;
 }
}
