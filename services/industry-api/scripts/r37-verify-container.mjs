/**
 * Read-only, local Docker identity verifier. Uses CLI --format to avoid
 * exposing container ENV (which may contain secrets) even to this process.
 */
import {lstat,readFile} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {evaluateR37ImageProvenance}
  from '../src/guest-r37-image-provenance.mjs';
const exec=promisify(execFile);
const SHA=/^[a-f0-9]{40}$/;
export async function verifyR37DockerImage({
  expectedCommit,releaseFile,approved=false,
  execDocker=async(args)=>((await exec('docker',args,{
    timeout:8000,maxBuffer:4096,env:{...process.env,
      DOCKER_HOST:'',DOCKER_CONTEXT:''}
  })).stdout).trim()
}={}){
  if(!approved||!SHA.test(expectedCommit||'')||
    typeof releaseFile!=='string'||!isAbsolute(releaseFile)||
    releaseFile.length>1024||
    process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT)
    throw Error('Explicit local Docker identity approval required');
  const stat=await lstat(releaseFile);
  if(!stat.isFile()||stat.isSymbolicLink()||
    stat.size<100||stat.size>8192)
    throw Error('Pinned release JSON must be a small regular local file');
  const release=JSON.parse(await readFile(releaseFile,'utf8'));
  if(release?.fullCommit!==expectedCommit||
    release?.guestWritesDefault!==false)
    throw Error('Source release manifest mismatch before Docker access');
  const context=await execDocker(['context','show']);
  if(context!=='default')throw Error('Only default local Docker context allowed');
  const name='osmanx-guest-r14-canary-api-1';
  const raw=await execDocker(['container','inspect','--format',
    '{{.Image}};{{.State.Running}};{{json .HostConfig.PortBindings}};{{.HostConfig.NetworkMode}}',name]);
  const parts=raw.split(';');
  if(parts.length!==4)throw Error('Unexpected Docker identity fields');
  const container={imageId:parts[0],running:parts[1]==='true',
    ports:JSON.parse(parts[2]),networkMode:parts[3]};
  if(!/^sha256:[a-f0-9]{64}$/.test(container.imageId))
    throw Error('Docker content address absent');
  const rawImage=await execDocker(['image','inspect','--format',
    '{{.Id}};{{index .Config.Labels "org.opencontainers.image.revision"}};{{index .Config.Labels "io.osmanx.guest.writes-default"}}',
    container.imageId]);
  const imageParts=rawImage.split(';');
  if(imageParts.length!==3)throw Error('Unexpected image label output');
  return evaluateR37ImageProvenance({release,container,
    image:{id:imageParts[0],revision:imageParts[1],
      guestWritesDefault:imageParts[2]},expectedCommit});
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==5||process.argv[2]!=='--approved-local-docker'||
      process.env.GUEST_R37_DOCKER_ACK!=='CHECK_LOCAL_READONLY_IMAGE')
      throw Error('R37 requires --approved-local-docker RELEASE_JSON EXPECTED_SHA');
    const result=await verifyR37DockerImage({
      approved:true,releaseFile:process.argv[3],
      expectedCommit:process.argv[4]});
    process.stdout.write(JSON.stringify(result)+'\n');
    if(!result.localMetadataConsistent)process.exitCode=2;
  }catch(error){
    process.stderr.write('R37 Docker provenance NO-GO: '+error.message+'\n');
    process.exitCode=2;
  }
}
