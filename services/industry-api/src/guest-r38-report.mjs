import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR37Readiness} from './guest-r37-report.mjs';
export const R38_REPORT_SCHEMA='osmanx.guest.r38.runtime-policy-readiness.v1';
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const R38_BLOCKERS=Object.freeze([
  'R38_PR47_DRAFT_NO_INDEPENDENT_APPROVAL',
  'R38_TWENTY_FOUR_PRS_NOT_MERGED',
  'R38_RENDERED_COMPOSE_OPERATOR_INSPECTION_MISSING',
  'R38_PUBLIC_SCHEMA_DISPOSABLE_RESTORE_UNWITNESSED',
  'R38_CURRENT_SHA_GITHUB_REVIEW_UNVERIFIED',
  'R38_LOCAL_IMAGE_VERSION_NOT_WITNESSED',
  'R38_REMOTE_STAGING_NOT_VALIDATED',
  'R38_OFFSITE_RECOVERY_LEGAL_AND_MAIN_CI_MISSING'
]);
const NOTE='R38: рабочие инструменты только для отдельного оператора. Веб API не запускает Docker, проверку GitHub, AGE, внешние сети, merge или изменение гостевых данных.';
const required=['schema','pilotId','r37PacketSha','releaseSha',
  'source','runtime','recovery','blockers','issuedAt','expiresAt',
  'productionAuthorized','customerGo','guestWritesEnabled','stopLifted',
  'mainChanged','deployAllowed','note','sha256'];
const own=(x)=>x&&typeof x==='object'&&!Array.isArray(x);
export function makeR38Readiness({r37,now=new Date()}={}){
  if(!verifyR37Readiness(r37,{now}).valid)
    throw Error('R38 requires valid R37 NO-GO evidence');
  const expiry=Math.min(Date.parse(r37.expiresAt),now.getTime()+600000);
  if(expiry<=now.getTime())throw Error('Expired R37 handoff');
  const body={schema:R38_REPORT_SCHEMA,pilotId:r37.pilotId,
    r37PacketSha:r37.sha256,
    releaseSha:'a9f6cb0b7a9c6af6d005b5a634a1c277b42e8d5f',
    source:{requiredPrs:24,currentReviewCompletedInApi:false,
      mergeVerifiedInApi:false},
    runtime:{renderedComposeCheckAvailable:true,
      liveDockerCallsInApi:0,externalStagingObserved:false},
    recovery:{publicSchemaGuardAvailable:true,localRestoresInApi:0,
      offsiteWitnessVerified:false},
    blockers:[...new Set([...R38_BLOCKERS,...r37.blockers])],
    issuedAt:now.toISOString(),expiresAt:new Date(expiry).toISOString(),
    productionAuthorized:false,customerGo:false,
    guestWritesEnabled:false,stopLifted:false,mainChanged:false,
    deployAllowed:false,note:NOTE};
  return {...body,sha256:digest(body)};
}
export function verifyR38Readiness(packet,{pilotId,now=new Date()}={}){
  const failures=[];
  if(!own(packet)||Object.keys(packet).sort().join('|')!==
    required.slice().sort().join('|')||
    packet.schema!==R38_REPORT_SCHEMA||
    !UUID.test(packet.pilotId||'')||
    !SHA.test(packet.r37PacketSha||'')||
    !SHA.test(packet.sha256||''))
    failures.push('INVALID_R38_PACKET');
  if(pilotId!==undefined&&packet?.pilotId!==pilotId)
    failures.push('WRONG_PILOT');
  const begin=Date.parse(packet?.issuedAt),end=Date.parse(packet?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(begin)||!Number.isFinite(end)||
    begin>now.getTime()||now.getTime()>=end||end-begin>600000||end<=begin)
    failures.push('EXPIRED_REPORT');
  if(packet?.releaseSha!=='a9f6cb0b7a9c6af6d005b5a634a1c277b42e8d5f'||
    !own(packet.source)||Object.keys(packet.source).sort().join('|')!==
      ['requiredPrs','currentReviewCompletedInApi','mergeVerifiedInApi'].sort().join('|')||
    packet.source.requiredPrs!==24||
    packet.source.currentReviewCompletedInApi!==false||
    packet.source.mergeVerifiedInApi!==false)
    failures.push('UNVERIFIED_SOURCE');
  if(!own(packet?.runtime)||
    packet.runtime.renderedComposeCheckAvailable!==true||
    packet.runtime.liveDockerCallsInApi!==0||
    packet.runtime.externalStagingObserved!==false||
    !own(packet?.recovery)||
    packet.recovery.publicSchemaGuardAvailable!==true||
    packet.recovery.localRestoresInApi!==0||
    packet.recovery.offsiteWitnessVerified!==false)
    failures.push('UNVERIFIED_OPERATOR_EVIDENCE');
  if(!Array.isArray(packet?.blockers)||packet.blockers.length>300||
    !packet.blockers.every(x=>typeof x==='string'&&x.length<180)||
    !R38_BLOCKERS.every(x=>packet.blockers.includes(x)))
    failures.push('BLOCKERS_REMOVED');
  for(const key of ['productionAuthorized','customerGo','guestWritesEnabled',
    'stopLifted','mainChanged','deployAllowed'])
    if(packet?.[key]!==false)failures.push('GO_NOT_ALLOWED');
  if(packet?.note!==NOTE)failures.push('NOTE_CHANGED');
  if(own(packet)&&Object.keys(packet).sort().join('|')===
    required.slice().sort().join('|')){
    const {sha256,...body}=packet;
    if(digest(body)!==sha256)failures.push('SHA_CHANGED');
  }
  return {valid:failures.length===0,errors:[...new Set(failures)],
    productionAuthorized:false,customerGo:false};
}
export function r38ReadinessCsv(packet,{now=new Date()}={}){
  if(!verifyR38Readiness(packet,{now}).valid)
    throw Error('R38 report not valid');
  const rows=[
    ['OSMANX Guest R38','NO-GO / independent operator acceptance'],
    ['R37 SHA-256',packet.r37PacketSha],
    ['Pinned source SHA',packet.releaseSha],
    ['PRs to review','24'],
    ['Rendered Docker Compose','operator check required'],
    ['Public schema in disposable DB','operator restore required'],
    ['GitHub review','current independent approval required'],
    ['Production','NO-GO']
  ];
  for(const reason of packet.blockers)rows.push(['Блокировка',reason]);
  rows.push(['Expires',packet.expiresAt],['Report SHA-256',packet.sha256]);
  return csv(rows);
}
