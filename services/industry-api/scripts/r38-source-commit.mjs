/**
 * Source for canary Docker build arg, either clean Git HEAD or a checked
 * RELEASE.json/SHA256SUMS source bundle. Output is ONLY the 40-char SHA.
 */
import {readFile,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {evaluateR38SourceInput}
  from '../src/guest-r38-build.mjs';
const exec=promisify(execFile);
async function cmd(bin,args,cwd){
  const {stdout}=await exec(bin,args,{cwd,maxBuffer:262144,
    timeout:12000,encoding:'utf8'});
  return stdout.trim();
}
export async function verifyR38SourceAt(root){
  const dir=resolve(root),manifest=resolve(dir,'RELEASE.json');
  let stat;
  try{stat=await lstat(manifest)}catch(e){if(e.code!=='ENOENT')throw e}
  let out;
  if(stat){
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)
      throw Error('Release manifest not small regular file');
    const release=JSON.parse(await readFile(manifest,'utf8'));
    await cmd('sha256sum',['-c','--status','--','SHA256SUMS'],dir);
    out=evaluateR38SourceInput({release,checksumVerified:true});
  }else{
    const gitCommit=await cmd('git',['rev-parse','--verify','HEAD'],dir);
    const dirty=(await cmd('git',
      ['status','--porcelain=v1','--untracked-files=all'],dir))!=='';
    out=evaluateR38SourceInput({gitCommit,dirty});
  }
  if(!out.valid)throw Error('Source bytes are not pinned to verified commit');
  return out.sourceCommit;
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3)throw Error('Use absolute source checkout path');
    const sha=await verifyR38SourceAt(process.argv[2]);
    process.stdout.write(sha+'\n');
  }catch{
    process.stderr.write('R38 canary source integrity NO-GO\n');
    process.exitCode=2;
  }
}
