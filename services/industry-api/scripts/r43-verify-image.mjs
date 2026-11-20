/** Offline validation of docker image inspect data, never runs Docker itself. */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyR43ImageConfig} from '../src/guest-r43-image-policy.mjs';
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
 try{
   if(process.argv.length!==4)throw Error('Image inspect file and SHA required');
   const raw=await readFile(process.argv[2],'utf8');
   if(raw.length>524288)throw Error('Image data too large');
   const report=verifyR43ImageConfig({
     inspect:JSON.parse(raw),sourceSha:process.argv[3]});
   process.stdout.write(JSON.stringify(report)+'\n');
   if(!report.valid)process.exitCode=2;
 }catch{
   process.stderr.write('R43 built container policy NO-GO\n');
   process.exitCode=2;
 }
}
