/** Local npm package-lock reviewer. npm itself is run separately by CI. */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditR42Dependencies} from '../src/guest-r42-dependency-audit.mjs';
const root=resolve(fileURLToPath(new URL('../',import.meta.url)));
export async function reviewR42Deps(){
  const [p,rawLock]=await Promise.all([
    readFile(root+'/package.json','utf8'),
    readFile(root+'/package-lock.json','utf8')
  ]);
  return auditR42Dependencies({pkg:JSON.parse(p),
    lock:JSON.parse(rawLock),rawLock});
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==3||process.argv[2]!=='--ci-generated-lock')
      throw Error('Read-only generated-lock check only');
    const out=await reviewR42Deps();
    process.stdout.write(JSON.stringify(out)+'\n');
    if(!out.integrityGraphValid||out.productionAuthorized!==false)
      process.exitCode=2;
  }catch{
    process.stderr.write('R42 generated npm lock audit NO-GO\n');
    process.exitCode=2;
  }
}
