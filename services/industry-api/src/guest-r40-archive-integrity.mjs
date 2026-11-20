/**
 * R40 AGE artifact integrity: exact sidecar filename and one SHA-256;
 * opened file descriptors, owner-only AGE identity and bounded streamed hash.
 * SHA is checksum, NOT authentication of the archive's origin.
 */
import {createHash} from 'node:crypto';
import {basename} from 'node:path';
import {openR40Regular,readR40Regular}
  from './guest-r40-secure-files.mjs';
export const R40_ARCHIVE_SCHEMA='osmanx.guest.r40.age-bytes-verified.v1';
const FILENAME=/^industry-\d{8}T\d{6}Z-\d{1,10}\.dump\.age$/;
const SHA=/^[0-9a-f]{64}$/;
export function inspectR40Sidecar({filename,text}={}){
  const invalid=()=>({valid:false,expectedDigest:null,
    blockers:['INVALID_OR_MISBOUND_SHA256_SIDECAR']});
  if(typeof filename!=='string'||!FILENAME.test(filename)||
    typeof text!=='string')return invalid();
  // GNU sha256sum text mode: 64 lowercase hex, TWO spaces, basename.
  // Reject multi-line manifests, absolute paths, symlink indicators and escapes.
  const match=/^([a-f0-9]{64}) {2}([A-Za-z0-9._-]+)\n?$/.exec(text);
  if(!match||match[2]!==filename||!SHA.test(match[1]))
    return invalid();
  return {valid:true,expectedDigest:match[1],blockers:[]};
}
export async function verifyR40Archive({archive,identityFile,
  maxBytes=5368709120}={}){
  if(typeof archive!=='string'||typeof identityFile!=='string'||
    !Number.isSafeInteger(maxBytes)||maxBytes<1)
    throw Error('R40 archive args invalid');
  const filename=basename(archive);
  if(!FILENAME.test(filename))throw Error('R40 unexpected AGE archive name');
  const manifest=await readR40Regular(archive+'.sha256',{
    maxBytes:300,minBytes:1});
  const sidecar=inspectR40Sidecar({filename,text:manifest});
  if(!sidecar.valid)throw Error('R40 archive digest filename mismatch');
  const identity=await openR40Regular(identityFile,{
    privateFile:true,minBytes:16,maxBytes:65536});
  await identity.close();
  const handle=await openR40Regular(archive,{
    privateFile:true,minBytes:1,maxBytes});
  try{
    const hash=createHash('sha256');
    const buffer=Buffer.allocUnsafe(131072);
    let offset=0;
    while(true){
      const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);
      if(!bytesRead)break;
      offset+=bytesRead;
      if(offset>maxBytes)throw Error('R40 AGE size exceeded limit');
      hash.update(buffer.subarray(0,bytesRead));
    }
    const actual=hash.digest('hex');
    const stat=await handle.stat();
    if(offset!==stat.size||actual!==sidecar.expectedDigest)
      throw Error('R40 AGE archive corrupted/changed');
    return {schema:R40_ARCHIVE_SCHEMA,digest:actual,bytes:offset,
      exactSidecarNameVerified:true,ownerOnlyIdentityVerified:true,
      localSnapshotVerified:true,offsiteOriginAuthenticated:false,
      productionAuthorized:false};
  }finally{await handle.close()}
}
