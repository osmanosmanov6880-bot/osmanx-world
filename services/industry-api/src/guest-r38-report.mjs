/**
 * Read-only R38 tenant NO-GO summary: network, Compose, Docker and DR
 * operator tools are never invoked by this Fastify/report module.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR37Readiness} from './guest-r37-report.mjs';
import {R37_PIN} from './guest-r38-mainline.mjs';
export const R38_REPORT_SCHEMA='osmanx.guest.r38.release-safety-no-go.v1';
export const R38_BLOCKERS=Object.freeze([
  'R38_24_PRS_REQUIRE_INDEPENDENT_REVIEW_AND_MERGE',
  'R38_FIRST_PENDING_PR47_IS_DRAFT_WITHOUT_HUMAN_APPROVAL',
  'R38_RELEASE_SOURCE_MUST_BE_ANCESTOR_OF_MAIN',
  'R38_CURRENT_MAIN_REQUIRES_POSTMERGE_CI',
  'R38_RESOLVED_CANARY_COMPOSE_NOT_OPERATOR_VERIFIED',
  'R38_CANARY_SOURCE_SHA_AND_RUNNING_BUILD_NOT_WITNESSED',
  'R38_DISPOSABLE_AGE_RESTORE_NOT_INDEPENDENTLY_WITNESSED',
  'R38_REMOTE_STAGING_OFFSITE_LEGAL_AND_CHANGE_APPROVAL_MISSING'
]);
const NOTE='R38: проверка развёрнутой Docker-конфигурации, точного source SHA и AGE-restore доступна только оператору. Веб-API ничего не разворачивает, не читает секреты и не разрешает гостевые записи. CI не доказывает реальный VPS/offsite restore.';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const exact=(x,props)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===props.slice().sort().join('|');
const digest=o=>createHash('sha256').update(JSON.stringify(o)).digest('hex');
const PROPS=['schema','pilotId','version','r37PacketSha','releaseSha',
  'source','compose','buildIdentity','restore','blockers','issuedAt',
  'expiresAt','manualOperatorReviewOnly','automaticMergeAllowed',
  'deployAllowed','mainChanged','productionChanged','guestWritesEnabled',
  'customerDataRead','stopLifted','customerGo','productionAuthorized','note'];
export function makeR38Readiness({r37,now=new Date()}={}){
  if(!verifyR37Readiness(r37,{now}).valid)
    throw Error('R38 requires a verified current R37 NO-GO report');
  const expiry=Math.min(Date.parse(r37.expiresAt),now.getTime()+600000);
  if(expiry<=now.getTime())throw Error('R37 report expired');
  const body={schema:R38_REPORT_SCHEMA,pilotId:r37.pilotId,
    version:r37.version,r37PacketSha:r37.sha256,releaseSha:R37_PIN.sha,
    source:{requiredPrs:24,mergedPrsVerifiedInApi:0,
      pinnedSourceReachableFromMainInApi:false,
      postMergeMainCiVerifiedInApi:false},
    compose:{resolvedConfigPolicyAvailable:true,
      operatorComposeCallsFromWebApi:0,
      remoteDockerContextAllowed:false},
    buildIdentity:{sourceCommitHealthAvailable:true,
      runtimeBuildHealthReadFromWebApi:false,
      signedProvenanceIndependentlyVerified:false},
    restore:{directLocalRestoreGuardAvailable:true,
      offsiteRestoreExecutedByWebApi:false,
      realRollbackIndependentlyWitnessed:false},
    blockers:[...new Set([...R38_BLOCKERS,...r37.blockers])],
    issuedAt:now.toISOString(),expiresAt:new Date(expiry).toISOString(),
    manualOperatorReviewOnly:true,automaticMergeAllowed:false,
    deployAllowed:false,mainChanged:false,productionChanged:false,
    guestWritesEnabled:false,customerDataRead:false,stopLifted:false,
    customerGo:false,productionAuthorized:false,note:NOTE};
  return {...body,sha256:digest(body)};
}
export function verifyR38Readiness(packet,{pilotId,now=new Date()}={}){
  const errors=[];
  if(!exact(packet,[...PROPS,'sha256'])||
    packet?.schema!==R38_REPORT_SCHEMA||!UUID.test(packet?.pilotId||'')||
    !SHA.test(packet?.r37PacketSha||'')||!SHA.test(packet?.sha256||''))
    errors.push('INVALID_R38_REPORT');
  if(pilotId!==undefined&&packet?.pilotId!==pilotId)
    errors.push('WRONG_TENANT_PILOT');
  const created=Date.parse(packet?.issuedAt),expiry=Date.parse(packet?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(created)||!Number.isFinite(expiry)||
    created>now.getTime()||now.getTime()>=expiry||
    expiry<=created||expiry-created>600000)
    errors.push('STALE_OR_FUTURE_R38_REPORT');
  if(packet?.releaseSha!==R37_PIN.sha||
    !exact(packet?.source,['requiredPrs','mergedPrsVerifiedInApi',
      'pinnedSourceReachableFromMainInApi','postMergeMainCiVerifiedInApi'])||
    packet.source.requiredPrs!==24||
    packet.source.mergedPrsVerifiedInApi!==0||
    packet.source.pinnedSourceReachableFromMainInApi!==false||
    packet.source.postMergeMainCiVerifiedInApi!==false)
    errors.push('UNVERIFIED_MERGE_OR_MAIN_CI');
  if(!exact(packet?.compose,['resolvedConfigPolicyAvailable',
      'operatorComposeCallsFromWebApi','remoteDockerContextAllowed'])||
    packet.compose.resolvedConfigPolicyAvailable!==true||
    packet.compose.operatorComposeCallsFromWebApi!==0||
    packet.compose.remoteDockerContextAllowed!==false)
    errors.push('UNSAFE_DOCKER_SCOPE');
  if(!exact(packet?.buildIdentity,['sourceCommitHealthAvailable',
      'runtimeBuildHealthReadFromWebApi','signedProvenanceIndependentlyVerified'])||
    packet.buildIdentity.sourceCommitHealthAvailable!==true||
    packet.buildIdentity.runtimeBuildHealthReadFromWebApi!==false||
    packet.buildIdentity.signedProvenanceIndependentlyVerified!==false)
    errors.push('FALSE_BUILD_ATTESTATION');
  if(!exact(packet?.restore,['directLocalRestoreGuardAvailable',
      'offsiteRestoreExecutedByWebApi','realRollbackIndependentlyWitnessed'])||
    packet.restore.directLocalRestoreGuardAvailable!==true||
    packet.restore.offsiteRestoreExecutedByWebApi!==false||
    packet.restore.realRollbackIndependentlyWitnessed!==false)
    errors.push('FALSE_RESTORE_ATTESTATION');
  if(!Array.isArray(packet?.blockers)||packet.blockers.length>280||
    !packet.blockers.every(x=>typeof x==='string'&&x.length<=180)||
    !R38_BLOCKERS.every(x=>packet.blockers.includes(x)))
    errors.push('CRITICAL_BLOCKER_REMOVED');
  if(packet?.manualOperatorReviewOnly!==true||packet?.note!==NOTE)
    errors.push('REPORT_POLICY_CHANGED');
  for(const k of ['automaticMergeAllowed','deployAllowed','mainChanged',
    'productionChanged','guestWritesEnabled','customerDataRead','stopLifted',
    'customerGo','productionAuthorized'])
    if(packet?.[k]!==false)errors.push('UNAUTHORIZED_GO_CLAIM');
  if(exact(packet,[...PROPS,'sha256'])){
    const {sha256,...body}=packet;
    if(digest(body)!==sha256)errors.push('R38_SHA256_MISMATCH');
  }
  return {valid:errors.length===0,errors:[...new Set(errors)],
    customerGo:false,productionAuthorized:false};
}
export function r38ReadinessCsv(packet,{now=new Date()}={}){
  if(!verifyR38Readiness(packet,{now}).valid)
    throw Error('R38 report invalid or expired');
  const rows=[
    ['OSMANX Guest R38','NO-GO / manual operational acceptance'],
    ['Pilot',packet.pilotId],['Prior R37 SHA',packet.r37PacketSha],
    ['Source commit',packet.releaseSha],
    ['24 PR','human approval and merge required'],
    ['Final main','ancestry + fresh CI required'],
    ['Canary','operator-only resolved compose, local Docker endpoint'],
    ['Build identity','operator-only runtime revision check'],
    ['AGE restore','loopback disposable target and genuine witness required'],
    ['External legal/offsite','not witnessed'],
    ['Expires',packet.expiresAt]
  ];
  for(const b of packet.blockers)rows.push(['Блокировка',b]);
  rows.push(['SHA256',packet.sha256],['Условие',packet.note]);
  return csv(rows);
}
