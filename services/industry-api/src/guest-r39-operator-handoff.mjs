/**
 * Evidence-aware offline operator packet. These are claims obtained from
 * locally supplied reports, not independent attestation of external systems.
 * No production GO / stop-lift path exists in this package.
 */
import {createHash} from 'node:crypto';
export const R39_HANDOFF_SCHEMA='osmanx.guest.r39.offline-handoff.v1';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const HEX64=/^[a-f0-9]{64}$/;
export function buildR39OperatorHandoff({
  review,compose,restore,image,now=new Date()
}={}){
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw new Error('Clock missing');
  const reviewReady=review?.schema===
    'osmanx.guest.r39.first-pr-review-packet.v1'&&
    review?.headSha==='840bb083e606058a9a32450f3b3a3e881a34891e'&&
    review?.fileCount===10&&review?.blockers?.length===0&&
    HEX64.test(review?.packetSha256||'');
  const renderedReady=compose?.schema===
    'osmanx.guest.r38.rendered-compose.v1'&&compose?.valid===true&&
    compose?.r39SandboxVerified===true;
  const emptyDbReady=restore?.schema===
    'osmanx.guest.r39.readonly-preflight.v1'&&
    restore?.localHostValidated===true&&
    restore?.emptyDatabaseVerified===true&&
    restore?.productionAuthorized===false;
  const imageReady=image?.localMetadataConsistent===true&&
    image?.remoteVpsDeploymentVerified===false&&
    image?.productionAuthorized===false;
  const steps=[
    {id:'PR47_HUMAN_REVIEW',
      ready:reviewReady&&review?.reviewSignal?.reviewSignalComplete===true,
      action:'Independent reviewer must inspect complete PR #47 and approve its exact current commit'},
    {id:'STACKED_SEQUENCE_AND_FRESH_MAIN_CI',ready:false,
      action:'Manually merge reviewed PR chain in dependency order, then run a fresh main CI'},
    {id:'LOCAL_RENDERED_COMPOSE',ready:renderedReady,
      action:'Operator must witness exact rendered sandbox Compose on the approved local host'},
    {id:'LOCAL_EMPTY_DB_PREFLIGHT',ready:emptyDbReady,
      action:'Verify disposable loopback DB is empty before approved AGE recovery'},
    {id:'LOCAL_IMAGE_PARITY',ready:imageReady,
      action:'Witness running local canary image/commit and isolated port binding'},
    {id:'EXTERNAL_STAGING_AND_OFFSITE_DR',ready:false,
      action:'Independently witness deployed staging version, real external restore and rollback'},
    {id:'CLIENT_LEGAL_AND_CHANGE_WINDOW',ready:false,
      action:'Review client authority, legal basis, signed terms and authorized window'}
  ];
  const body={schema:R39_HANDOFF_SCHEMA,
    pinnedFirstPr:47,
    pinnedFirstPrHead:'840bb083e606058a9a32450f3b3a3e881a34891e',
    issuedAt:now.toISOString(),
    expiresAt:new Date(now.getTime()+600000).toISOString(),
    evidenceType:'OPERATOR_SUPPLIED_NOT_INDEPENDENTLY_VERIFIED',
    checks:steps.map(x=>({id:x.id,ready:x.ready,action:x.action})),
    readySteps:steps.filter(x=>x.ready).length,
    totalSteps:steps.length,
    allExternalPrerequisitesVerified:false,
    mergeAllowed:false,
    customerGo:false,stopLifted:false,guestWritesEnabled:false,
    productionAuthorized:false};
  return {...body,sha256:sha(body)};
}
