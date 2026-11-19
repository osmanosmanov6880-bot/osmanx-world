/**
 * Actual byte-level verification of two operator-provided AGE envelopes.
 * It does not decrypt/restore, assert offsite custody or touch databases.
 */
import {evaluateR34Custody,R34_CUSTODY_ROLES}
  from './guest-r34-custody.mjs';
import {hashR35RegularFile} from './guest-r35-byte-proof.mjs';
export const R35_ARCHIVE_SCHEMA='osmanx.guest.r35.age-byte-audit.v1';
const keys=['A','B'];
export async function auditR35ArchiveBytes({
  custody,statements,trustedKeys={},archiveFiles,now=new Date()
}={}){
  const review=evaluateR34Custody({packet:custody,statements,
    trustedKeys,now});
  if(!review.metadataReadyForHumanAudit)
    throw Error('Signed R34 custody metadata must pass before reading archives');
  if(!archiveFiles||typeof archiveFiles!=='object'||
    Array.isArray(archiveFiles)||
    Object.keys(archiveFiles).sort().join('|')!=='A|B')
    throw Error('Require exactly two separate archive paths');
  if(archiveFiles.A===archiveFiles.B)
    throw Error('Independent archives must have different files');
  const proofs=[];
  for(const copyId of keys){
    const copy=custody.copies.find(c=>c.copyId===copyId);
    const proof=await hashR35RegularFile({
      path:archiveFiles[copyId],expectedSha:copy.archiveSha,
      maxBytes:64*1024*1024,requireAgeHeader:true
    });
    proofs.push({copyId,sha256:proof.sha256,byteCount:proof.byteCount,
      ageEnvelopeHeaderSeen:proof.ageEnvelopeHeaderSeen});
  }
  return {schema:R35_ARCHIVE_SCHEMA,
    localEncryptedArchiveHashesMatched:true,proofs,
    claimedRestoreMetadataSigned:true,
    actualDecryptionAndRestorationPerformed:false,
    independentOffsiteCustodyVerified:false,
    productionDatabaseTouched:false,customerGo:false,
    productionAuthorized:false};
}
