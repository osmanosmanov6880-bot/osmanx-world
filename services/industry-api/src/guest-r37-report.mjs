/**
 * R37 read-only tenant report. Files, Docker, GitHub and Postgres restore
 * operations remain outside Fastify; this API never asserts real GO.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR36Readiness} from './guest-r36-report.mjs';
import {R36_PIN} from './guest-r37-postmerge.mjs';
export const R37_REPORT_SCHEMA='osmanx.guest.r37.independent-release-barriers.v1';
export const R37_BLOCKERS=Object.freeze([
  'R37_TWENTY_THREE_SOURCE_PRS_NOT_REVIEWED_AND_MERGED',
  'R37_PR47_INDEPENDENT_HUMAN_APPROVAL_MISSING',
  'R37_MAIN_REQUIRES_FRESH_POSTMERGE_CI_AND_TREE',
  'R37_CANARY_PRIVATE_FILE_AND_LOOPBACK_POLICY_REQUIRES_OPERATOR',
  'R37_DOCKER_CONTAINER_SOURCE_IMAGE_IDENTITY_NOT_WITNESSED',
  'R37_LOCAL_DR_POSTGRES_EMPTY_AND_RESTORED_STATE_NOT_ATTESTED',
  'R37_REMOTE_STAGING_TLS_AND_DEPLOYED_IDENTITY_NOT_ATTESTED',
  'R37_OFFSITE_RESTORE_AND_ROLLBACK_NOT_INDEPENDENTLY_WITNESSED',
  'R37_CONTRACT_LEGAL_AUTHORITY_AND_CHANGE_WINDOW_MISSING'
]);
const NOTE='R37: безопасный canary, локальный AGE/PostgreSQL restore, проверка Docker image identity и 23 PR доступны только отдельным операторам. Веб-API не читает их секреты или данные, не запускает Docker, GitHub, восстановление, записи гостей и deploy.';
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exact=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===k.slice().sort().join('|');
const sha=o=>createHash('sha256').update(JSON.stringify(o)).digest('hex');
const PROPS=['schema','pilotId','version','r36PacketSha','releaseSha',
  'source','canary','image','disasterRecovery','blockers','issuedAt',
  'expiresAt','manualHumanReviewOnly','automaticMergeAllowed',
  'deployAllowed','mainChanged','productionChanged','guestWritesEnabled',
  'customerDataRead','stopLifted','customerGo','productionAuthorized','note'];
export function makeR37Readiness({r36,now=new Date()}={}){
  if(!verifyR36Readiness(r36,{now}).valid)
    throw Error('R37 requires a current valid R36 NO-GO report');
  const expiry=Math.min(Date.parse(r36.expiresAt),now.getTime()+600000);
  if(expiry<=now.getTime())throw Error('Inherited release report expired');
  const body={schema:R37_REPORT_SCHEMA,pilotId:r36.pilotId,
    version:r36.version,r36PacketSha:r36.sha256,
    releaseSha:R36_PIN.sha,
    source:{requiredPrs:23,mergedPrsVerifiedInApi:0,
      independentApprovalsVerifiedInApi:0,
      postMergeMainCiVerifiedInApi:false},
    canary:{envPermissionsVerifierAvailable:true,
      loopbackTopologyVerifierAvailable:true,
      dockerCallsFromWebApi:0},
    image:{localImageIdentityVerifierAvailable:true,
      liveContainerInspectionsFromWebApi:0,
      independentDeploymentProof:false},
    disasterRecovery:{localServerInspectionToolAvailable:true,
      localRestoreCallsFromWebApi:0,
      realOffsiteRestoreIndependentlyWitnessed:false},
    blockers:[...new Set([...R37_BLOCKERS,...r36.blockers])],
    issuedAt:now.toISOString(),expiresAt:new Date(expiry).toISOString(),
    manualHumanReviewOnly:true,automaticMergeAllowed:false,
    deployAllowed:false,mainChanged:false,productionChanged:false,
    guestWritesEnabled:false,customerDataRead:false,stopLifted:false,
    customerGo:false,productionAuthorized:false,note:NOTE};
  return {...body,sha256:sha(body)};
}
export function verifyR37Readiness(packet,{pilotId,now=new Date()}={}){
  const errors=[];
  if(!exact(packet,[...PROPS,'sha256'])||
    packet?.schema!==R37_REPORT_SCHEMA||
    !UUID.test(packet?.pilotId||'')||
    !SHA.test(packet?.r36PacketSha||'')||
    !SHA.test(packet?.sha256||''))
    errors.push('MALFORMED_R37_REPORT');
  if(pilotId!==undefined&&packet?.pilotId!==pilotId)
    errors.push('WRONG_PILOT');
  const issued=Date.parse(packet?.issuedAt),
    expires=Date.parse(packet?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(issued)||!Number.isFinite(expires)||
    issued>now.getTime()||now.getTime()>=expires||
    expires<=issued||expires-issued>600000)
    errors.push('R37_REPORT_EXPIRED');
  if(packet?.releaseSha!==R36_PIN.sha||
    !exact(packet?.source,['requiredPrs','mergedPrsVerifiedInApi',
      'independentApprovalsVerifiedInApi','postMergeMainCiVerifiedInApi'])||
    packet.source.requiredPrs!==23||
    packet.source.mergedPrsVerifiedInApi!==0||
    packet.source.independentApprovalsVerifiedInApi!==0||
    packet.source.postMergeMainCiVerifiedInApi!==false)
    errors.push('UNVERIFIED_MERGE_CLAIM');
  if(!exact(packet?.canary,['envPermissionsVerifierAvailable',
      'loopbackTopologyVerifierAvailable','dockerCallsFromWebApi'])||
    packet.canary.envPermissionsVerifierAvailable!==true||
    packet.canary.loopbackTopologyVerifierAvailable!==true||
    packet.canary.dockerCallsFromWebApi!==0)
    errors.push('WEB_CANARY_POLICY_CHANGED');
  if(!exact(packet?.image,['localImageIdentityVerifierAvailable',
      'liveContainerInspectionsFromWebApi','independentDeploymentProof'])||
    packet.image.localImageIdentityVerifierAvailable!==true||
    packet.image.liveContainerInspectionsFromWebApi!==0||
    packet.image.independentDeploymentProof!==false)
    errors.push('FALSE_IMAGE_ATTESTATION');
  if(!exact(packet?.disasterRecovery,['localServerInspectionToolAvailable',
      'localRestoreCallsFromWebApi','realOffsiteRestoreIndependentlyWitnessed'])||
    packet.disasterRecovery.localServerInspectionToolAvailable!==true||
    packet.disasterRecovery.localRestoreCallsFromWebApi!==0||
    packet.disasterRecovery.realOffsiteRestoreIndependentlyWitnessed!==false)
    errors.push('FALSE_OFFSITE_CLAIM');
  if(!Array.isArray(packet?.blockers)||packet.blockers.length>250||
    !packet.blockers.every(x=>typeof x==='string'&&x.length<=175)||
    !R37_BLOCKERS.every(x=>packet.blockers.includes(x)))
    errors.push('MANDATORY_NO_GO_BLOCKERS_REMOVED');
  if(packet?.manualHumanReviewOnly!==true||packet?.note!==NOTE)
    errors.push('REPORT_POLICY_CHANGED');
  for(const key of ['automaticMergeAllowed','deployAllowed','mainChanged',
    'productionChanged','guestWritesEnabled','customerDataRead','stopLifted',
    'customerGo','productionAuthorized'])
    if(packet?.[key]!==false)errors.push('UNAUTHORIZED_GO_ATTEMPT');
  if(exact(packet,[...PROPS,'sha256'])){
    const {sha256,...body}=packet;
    if(sha(body)!==sha256)errors.push('REPORT_DIGEST_MISMATCH');
  }
  return {valid:errors.length===0,errors:[...new Set(errors)],
    productionAuthorized:false,customerGo:false};
}
export function r37ReadinessCsv(packet,{now=new Date()}={}){
  if(!verifyR37Readiness(packet,{now}).valid)
    throw Error('R37 report expired or tampered');
  const rows=[
    ['OSMANX Guest R37','NO-GO / human operational acceptance'],
    ['Version',packet.version],
    ['Pilot id',packet.pilotId],
    ['Prior R36 report SHA-256',packet.r36PacketSha],
    ['Pinned R36 source commit',packet.releaseSha],
    ['23 PR merge','manual review incomplete in API'],
    ['Canary env permissions','operator-only preflight required'],
    ['Running Docker image identity','operator-only local inspect required'],
    ['Disposable AGE restore','operator-only local PostgreSQL inspection required'],
    ['Offsite + legal + rollback','independent human evidence absent'],
    ['Expires',packet.expiresAt]
  ];
  for(const problem of packet.blockers)rows.push(['Блокировка',problem]);
  rows.push(['SHA-256',packet.sha256],['Ограничение',packet.note]);
  return csv(rows);
}
