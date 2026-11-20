/**
 * Exact artifact revision and read-only public health response.
 * Commit labels/self-reports are useful deployment parity, NOT signed provenance.
 */
export const R38_BUILD_SCHEMA='osmanx.guest.r38.source-identity.v1';
const SHA=/^[a-f0-9]{40}$/;
export function evaluateR38BuildIdentity({expectedSha,status,contentType,
  json}={}){
  const blockers=[];
  if(!SHA.test(expectedSha||''))blockers.push('EXPECTED_SOURCE_SHA_INVALID');
  if(status!==200||!/^application\/json(?:;|$)/i.test(contentType||''))
    blockers.push('BUILD_ENDPOINT_STATUS_OR_MIME');
  if(!json||typeof json!=='object'||Array.isArray(json)||
    json.status!=='build'||json.commit!==expectedSha||
    json.guestWritesEnabled!==false||
    json.provenance!=='operator-self-reported'||
    json.signedBuildProvenanceVerified!==false)
    blockers.push('RUNNING_BUILD_SHA_OR_SAFETY_MISMATCH');
  return {schema:R38_BUILD_SCHEMA,valid:blockers.length===0,
    expectedSha:SHA.test(expectedSha||'')?expectedSha:null,
    advertisedCommit:SHA.test(json?.commit||'')?json.commit:null,
    advertisedWritesDisabled:json?.guestWritesEnabled===false,
    buildClaimMatched:blockers.length===0,
    signedBuildProvenanceVerified:false,
    remoteVpsIdentityIndependentlyVerified:false,
    customerGo:false,productionAuthorized:false,
    blockers:[...new Set(blockers)]};
}
export function evaluateR38SourceInput({release,gitCommit,dirty=false,
  checksumVerified=false}={}){
  const blockers=[];
  let sha=null;
  if(release!==undefined){
    if(release?.schema!=='osmanx.industry.r14.release.v1'||
      !SHA.test(release.fullCommit||'')||
      release.commit!==release.fullCommit.slice(0,12)||
      release.guestWritesDefault!==false||
      checksumVerified!==true)
      blockers.push('VERIFIED_RELEASE_MANIFEST_REQUIRED');
    else sha=release.fullCommit;
  }else{
    if(!SHA.test(gitCommit||'')||dirty!==false)
      blockers.push('CLEAN_GIT_COMMIT_REQUIRED');
    else sha=gitCommit;
  }
  return {valid:blockers.length===0,sourceCommit:sha,
    releaseIntegrityVerified:release!==undefined&&checksumVerified===true,
    dirtyWorkingCopyRejected:dirty===true,
    customerWritesEnabled:false,blockers};
}
