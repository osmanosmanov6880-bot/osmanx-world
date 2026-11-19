/**
 * Local container <> source bundle metadata parity. The labels are self-
 * assertions and MUST NOT be mistaken for cryptographic trusted provenance
 * or external VPS attestation. No container mutations or credential access.
 */
import {createHash} from 'node:crypto';
export const R37_IMAGE_SCHEMA='osmanx.guest.r37.local-running-image-parity.v1';
const HEX40=/^[a-f0-9]{40}$/;
const IMG=/^sha256:[a-f0-9]{64}$/;
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const expectedName='osmanx-guest-r14-canary-api-1';
const expectedPort=Object.freeze({HostIp:'127.0.0.1',HostPort:'3150'});
export function evaluateR37ImageProvenance({
  release,container,image,expectedCommit,containerName=expectedName
}={}){
  const errors=[];
  if(!HEX40.test(expectedCommit||'')||
    release?.schema!=='osmanx.industry.r14.release.v1'||
    release?.fullCommit!==expectedCommit||
    release?.guestWritesDefault!==false||
    typeof release?.commit!=='string'||
    release.commit!==expectedCommit.slice(0,12))
    errors.push('SOURCE_RELEASE_MANIFEST_INVALID');
  if(containerName!==expectedName||
    container?.running!==true||
    !IMG.test(container?.imageId||'')||
    container?.networkMode!=='osmanx-guest-r14-canary_r14_private')
    errors.push('CONTAINER_NOT_ISOLATED_R14_RUNNING');
  const ports=container?.ports;
  if(!ports||typeof ports!=='object'||Array.isArray(ports)||
    Object.keys(ports).join('|')!=='3047/tcp'||
    !Array.isArray(ports['3047/tcp'])||
    ports['3047/tcp'].length!==1||
    ports['3047/tcp'][0]?.HostIp!==expectedPort.HostIp||
    ports['3047/tcp'][0]?.HostPort!==expectedPort.HostPort)
    errors.push('CANARY_PORT_EXPOSED_OR_DRIFTED');
  if(!IMG.test(image?.id||'')||
    image?.id!==container?.imageId||
    image?.revision!==expectedCommit||
    image?.guestWritesDefault!=='false')
    errors.push('IMAGE_LABEL_OR_DIGEST_DRIFT');
  const ready=errors.length===0;
  const body={schema:R37_IMAGE_SCHEMA,
    expectedSourceCommit:HEX40.test(expectedCommit||'')?expectedCommit:null,
    containerName:expectedName,
    imageId:IMG.test(container?.imageId||'')?container.imageId:null,
    sourceBundleMetadataMatched:ready,
    imageSelfReportedRevisionMatched:ready,
    observedLocalContainerRunning:container?.running===true,
    loopbackCanaryPortVerified:!errors.includes('CANARY_PORT_EXPOSED_OR_DRIFTED'),
    localMetadataConsistent:ready,
    trustedBuildProvenanceCryptographicallyVerified:false,
    remoteVpsDeploymentVerified:false,
    humanApprovalPerformed:false,
    productionAuthorized:false,customerGo:false,
    blockers:errors};
  return {...body,sha256:sha(body)};
}
