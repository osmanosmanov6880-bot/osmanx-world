/** 
 * R45 local-only conflict preview. Uses read-only ref lookup and merge-tree.
 * No git checkout, merge, rebase, branch update, GitHub mutation or deploy.
 */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {R45_FIRST} from '../src/guest-r45-compare-proof.mjs';
import {assessR45MergeTree} from '../src/guest-r45-merge-preview.mjs';
const SHA=/^[0-9a-f]{40}$/;
function git(args,{maxBuffer=1024*1024}={}){
 const r=spawnSync('git',args,{encoding:'utf8',timeout:30000,maxBuffer});
 if(r.error)throw Error('R45 git unavailable: '+r.error.code);
 return r;
}
export function runR45GitPreview(){
 const main=git(['rev-parse','--verify','refs/remotes/origin/main']);
 const mainSha=main.stdout?.trim();
 if(main.status!==0||!SHA.test(mainSha||''))
   throw Error('R45 origin/main full commit ref unavailable');
 for(const sha of [mainSha,R45_FIRST.sha]){
   const found=git(['cat-file','-e',sha+'^{commit}']);
   if(found.status!==0)throw Error('R45 one pinned commit object absent');
 }
 const merge=git(['merge-tree','--write-tree','--name-only','--no-messages',
   mainSha,R45_FIRST.sha]);
 const report=assessR45MergeTree({mainSha,sourceSha:R45_FIRST.sha,
   exitCode:merge.status,stdout:merge.stdout});
 if(!report.valid)throw Error('R45 Git conflict preview result untrusted');
 return report;
}
const direct=process.argv[1]&&
  resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
 try{
   if(process.argv.length!==3||process.argv[2]!=='--json')
     throw Error('R45 only --json is available');
   process.stdout.write(JSON.stringify(runR45GitPreview())+'\n');
 }catch(error){
   process.stderr.write('R45 real merge-tree audit NO-GO: '+
     String(error.message).replace(/[^a-zA-Z0-9._ -]/g,'').slice(0,120)+'\n');
   process.exitCode=2;
 }
}
