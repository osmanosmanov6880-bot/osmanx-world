/**
 * Exact byte-level match for five locally held client/legal documents.
 * The signed SHA values refer to these bytes, but the content, validity and
 * authority of the signers still require an external legal reviewer.
 */
import {evaluateR34ClientScope} from './guest-r34-client.mjs';
import {hashR35RegularFile} from './guest-r35-byte-proof.mjs';
export const R35_DOCUMENT_SCHEMA='osmanx.guest.r35.document-byte-audit.v1';
const mapping=Object.freeze({
  contract:'contractSha',
  processorAgreement:'processorAgreementSha',
  privacyNotice:'privacyNoticeSha',
  lawfulBasisOpinion:'lawfulBasisOpinionSha',
  deletionProcedure:'deletionProcedureSha'
});
export async function auditR35LegalDocumentBytes({
  client,statements,trustedKeys={},documentFiles,now=new Date()
}={}){
  const reviewed=evaluateR34ClientScope({
    packet:client,statements,trustedKeys,now});
  if(!reviewed.signedScopeMetadataValid)
    throw Error('Signed client scope must be valid before reading documents');
  if(!documentFiles||typeof documentFiles!=='object'||
    Array.isArray(documentFiles)||
    Object.keys(documentFiles).sort().join('|')!==
      Object.keys(mapping).sort().join('|'))
    throw Error('Exactly five required document paths');
  const seen=new Set(),proofs=[];
  for(const [name,shaField] of Object.entries(mapping)){
    const path=documentFiles[name];
    if(seen.has(path))throw Error('Document files must be distinct');
    seen.add(path);
    const proof=await hashR35RegularFile({
      path,expectedSha:client[shaField],
      maxBytes:8*1024*1024
    });
    proofs.push({documentType:name,sha256:proof.sha256,
      byteCount:proof.byteCount});
  }
  return {schema:R35_DOCUMENT_SCHEMA,
    fiveSignedFileDigestsMatched:true,proofs,
    documentContentsNotReturned:true,
    legalValidityIndependentlyEstablished:false,
    clientIdentityIndependentlyVerified:false,
    personalDataUploaded:false,customerGo:false,
    productionAuthorized:false};
}
