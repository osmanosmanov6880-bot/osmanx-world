/**
 * Offline local-file byte verification. No upload, no remote I/O, no file
 * contents in results. Refuses symlinks and verifies opened inode == lstat.
 */
import {lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
const SHA=/^[a-f0-9]{64}$/;
export async function hashR35RegularFile({
  path,expectedSha,maxBytes,requireAgeHeader=false
}={}){
  if(typeof path!=='string'||path.length<2||path.length>1024||
    !isAbsolute(path)||path.includes('\0')||
    !SHA.test(expectedSha||'')||
    !Number.isSafeInteger(maxBytes)||maxBytes<128||
    maxBytes>128*1024*1024)
    throw Error('Unsafe file proof request');
  const first=await lstat(path);
  if(!first.isFile()||first.isSymbolicLink()||first.size<128||
    first.size>maxBytes)throw Error('File must be regular and size-bounded');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const second=await handle.stat();
    if(!second.isFile()||first.dev!==second.dev||
      first.ino!==second.ino||first.size!==second.size)
      throw Error('File changed during acquisition');
    const hash=createHash('sha256'),iterator=handle.createReadStream();
    let count=0,header=Buffer.alloc(0);
    for await(const chunk of iterator){
      count+=chunk.length;
      if(count>maxBytes)throw Error('File grew beyond allowed limit');
      if(header.length<32)
        header=Buffer.concat([header,chunk.subarray(
          0,Math.max(0,32-header.length))]);
      hash.update(chunk);
    }
    if(count!==second.size)throw Error('File truncated during audit');
    if(requireAgeHeader&&!header.toString('utf8').startsWith(
      'age-encryption.org/v1\n'))
      throw Error('Missing AGE v1 encrypted envelope header');
    const calculated=hash.digest('hex');
    if(calculated!==expectedSha)
      throw Error('File bytes do not match signed SHA-256');
    return {byteCount:count,sha256:calculated,
      ageEnvelopeHeaderSeen:requireAgeHeader,
      contentsReturned:false,fileUploaded:false};
  }finally{await handle.close();}
}
