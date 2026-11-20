/**
 * R41 atomic private AGE snapshot from ONE verified open source fd. No cp(1),
 * source reopening or symlink following between verification and copying.
 * Checksum is not authenticity or custody proof.
 */
import {createHash} from 'node:crypto';
import {open,lstat,realpath,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,join,resolve,isAbsolute} from 'node:path';
import {openR40Regular,readR40Regular}
  from './guest-r40-secure-files.mjs';
import {inspectR40Sidecar}
  from './guest-r40-archive-integrity.mjs';
export const R41_SNAPSHOT_SCHEMA='osmanx.guest.r41.fd-bound-ciphertext-snapshot.v1';
const FILENAME=/^industry-\d{8}T\d{6}Z-\d{1,10}\.dump\.age$/;
export async function snapshotR41Age({
  archive,identityFile,destinationDir,maxBytes=5368709120
}={}){
  if(typeof archive!=='string'||typeof identityFile!=='string'||
    typeof destinationDir!=='string'||
    !isAbsolute(archive)||!isAbsolute(identityFile)||
    !isAbsolute(destinationDir)||!Number.isSafeInteger(maxBytes)||
    maxBytes<1)
    throw Error('R41 exact local absolute source, identity and destination required');
  const filename=basename(archive),dest=resolve(destinationDir);
  if(!FILENAME.test(filename))
    throw Error('R41 unexpected AGE archive basename');
  const [dstStat,canonical]=await Promise.all([
    lstat(dest),realpath(dest)
  ]);
  if(!dstStat.isDirectory()||dstStat.isSymbolicLink()||canonical!==dest||
    (dstStat.mode&0o077)!==0||
    (typeof process.getuid==='function'&&dstStat.uid!==process.getuid()))
    throw Error('R41 private destination directory refused');
  const identity=await openR40Regular(identityFile,{
    privateFile:true,minBytes:16,maxBytes:65536
  });
  await identity.close();
  const sidecar=inspectR40Sidecar({
    filename,text:await readR40Regular(archive+'.sha256',{
      privateFile:true,minBytes:1,maxBytes:300
    })
  });
  if(!sidecar.valid)
    throw Error('R41 source digest not bound to archive');
  const source=await openR40Regular(archive,{
    privateFile:true,minBytes:1,maxBytes
  });
  let output=null,created=false,sidecarCreated=false;
  const outputPath=join(dest,filename),manifestPath=outputPath+'.sha256';
  try{
    const before=await source.stat();
    output=await open(outputPath,constants.O_CREAT|constants.O_EXCL|
      constants.O_WRONLY|(constants.O_NOFOLLOW||0),0o600);
    created=true;
    const hash=createHash('sha256'),chunk=Buffer.allocUnsafe(131072);
    let cursor=0;
    while(true){
      const {bytesRead}=await source.read(chunk,0,chunk.length,cursor);
      if(!bytesRead)break;
      cursor+=bytesRead;
      if(cursor>maxBytes)throw Error('R41 AGE source exceeds cap');
      hash.update(chunk.subarray(0,bytesRead));
      let offset=0;
      while(offset<bytesRead){
        const written=await output.write(chunk,offset,bytesRead-offset,null);
        if(!Number.isSafeInteger(written.bytesWritten)||written.bytesWritten<1)
          throw Error('R41 short destination write');
        offset+=written.bytesWritten;
      }
    }
    await output.sync();
    const after=await source.stat(),copied=await output.stat();
    const digest=hash.digest('hex');
    if(before.dev!==after.dev||before.ino!==after.ino||
      before.size!==after.size||cursor!==before.size||
      copied.size!==cursor||digest!==sidecar.expectedDigest)
      throw Error('R41 source changed or SHA-256 verification failed');
    // Manifest is produced only from verified copied bytes. Never import the
    // original sidecar as an authoritative file without checking its target.
    const m=await open(manifestPath,constants.O_CREAT|constants.O_EXCL|
      constants.O_WRONLY|(constants.O_NOFOLLOW||0),0o600);
    sidecarCreated=true;
    try{
      await m.writeFile(digest+'  '+filename+'\n');
      await m.sync();
    }finally{await m.close()}
    return {schema:R41_SNAPSHOT_SCHEMA,
      bytes:cursor,sha256:digest,fdBound:true,
      privateDestinationVerified:true,
      exactManifestRegenerated:true,
      sourceIdentityPinChecked:true,
      externalCustodyIndependentlyVerified:false,
      productionAuthorized:false,customerGo:false};
  }catch(error){
    if(sidecarCreated)await rm(manifestPath,{force:true}).catch(()=>{});
    if(created)await rm(outputPath,{force:true}).catch(()=>{});
    throw error;
  }finally{
    await output?.close().catch(()=>{});
    await source.close();
  }
}
