/**
 * Operator-only rendered compose validator. Child stdout is captured and
 * never logged because it includes resolved passwords. No up/down/exec.
 */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectR38RenderedCompose}
  from '../src/guest-r38-compose-runtime.mjs';
import {inspectR39ComposePrivileges}
  from '../src/guest-r39-compose-boundaries.mjs';
const exec=promisify(execFile);
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
export async function checkR38Compose({
  envFile,runner=async(args)=>((await exec('docker',args,{
    timeout:12000,maxBuffer:131072,env:{...process.env}
  })).stdout)
}={}){
  if(typeof envFile!=='string'||!envFile.startsWith('/')||
    envFile.length>1024||process.env.DOCKER_HOST||
    process.env.DOCKER_CONTEXT)
    throw Error('R38 local Docker env and exact private path required');
  const raw=await runner(['compose','-p','osmanx-guest-r14-canary',
    '--env-file',envFile,'-f',root+'/ops/compose.r14.yml',
    'config','--format','json']);
  if(typeof raw!=='string'||raw.length>131072)
    throw Error('Rendered Compose metadata unavailable');
  const inspection=inspectR38RenderedCompose(JSON.parse(raw));
  if(!inspection.valid)throw Error('Canary rendered Compose refused: '+
    inspection.blockers.join(','));
  const sandbox=inspectR39ComposePrivileges(JSON.parse(raw));
  if(!sandbox.valid)throw Error('R39 rendered privileges refused: '+
    sandbox.blockers.join(','));
  return {...inspection,r39SandboxVerified:true,
    sandboxPolicySchema:sandbox.schema};
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3)throw Error('Private env path required');
    const out=await checkR38Compose({envFile:process.argv[2]});
    process.stdout.write(JSON.stringify(out)+'\n');
  }catch(e){
    process.stderr.write('R38 rendered Compose NO-GO: '+e.message+'\n');
    process.exitCode=2;
  }
}
