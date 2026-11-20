/**
 * R40 secure, bounded operator-file reads for R14 admission and AGE manifests.
 * POSIX O_NOFOLLOW + opened-handle fstat; no unbounded readFile.
 * Does not imply control over a compromised host or parent-dir rename races.
 */
import {open,realpath,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const DEFAULT_ROOT=resolve(fileURLToPath(new URL('../',import.meta.url)));
const MAX_TEXT=131072;
export async function openR40Regular(path,{root=DEFAULT_ROOT,
  privateFile=false,maxBytes=MAX_TEXT,minBytes=1}={}){
  if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0')||
    path.length>4096||!Number.isSafeInteger(maxBytes)||maxBytes<1||
    !Number.isSafeInteger(minBytes)||minBytes<0||minBytes>maxBytes)
    throw Error('R40 invalid absolute operator file path/size policy');
  const lexical=resolve(path);
  const [canonical,sourceRoot]=await Promise.all([
    realpath(lexical),realpath(root)
  ]);
  // Reject symlinks in *all* path components, not only the final component.
  if(lexical!==canonical||canonical===sourceRoot||
    canonical.startsWith(sourceRoot+sep))
    throw Error('R40 symlink/checkout file refused');
  const fd=await open(canonical,constants.O_RDONLY|
    (constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));
  try{
    const [handleStat,currentStat]=await Promise.all([fd.stat(),stat(canonical)]);
    if(!handleStat.isFile()||!currentStat.isFile()||
      handleStat.dev!==currentStat.dev||handleStat.ino!==currentStat.ino||
      handleStat.nlink!==1||
      handleStat.size<minBytes||handleStat.size>maxBytes||
      (privateFile&&(handleStat.mode&0o077)!==0)||
      (!privateFile&&(handleStat.mode&0o022)!==0)||
      (typeof process.getuid==='function'&&
        privateFile&&handleStat.uid!==process.getuid()))
      throw Error('R40 operator file identity/permission/size refused');
    return fd;
  }catch(e){await fd.close();throw e}
}
export async function readR40Regular(path,opts={}){
  const maxBytes=opts.maxBytes??MAX_TEXT;
  const fd=await openR40Regular(path,{...opts,maxBytes});
  try{
    const buf=Buffer.alloc(maxBytes+1);
    let used=0;
    while(used<buf.length){
      const {bytesRead}=await fd.read(buf,used,buf.length-used,used);
      if(bytesRead===0)break;
      used+=bytesRead;
    }
    if(used>maxBytes)throw Error('R40 operator file exceeds bounded read');
    const final=await fd.stat();
    if(final.size!==used)throw Error('R40 file changed during read');
    return buf.subarray(0,used).toString('utf8');
  }finally{await fd.close()}
}
