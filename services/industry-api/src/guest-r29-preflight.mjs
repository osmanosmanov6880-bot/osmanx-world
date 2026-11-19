/**
 * R29 operator-facing staging readiness handoff. Does NOT claim that CI tests
 * conducted elsewhere were run on this host; live API passes null external
 * evidence until a separately reviewed operator process attests it.
 * Input is the already validated R28 per-pilot packet, never client PII.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR28OperatorPacket} from './guest-r28-operator-packet.mjs';
import {R29_ROLLBACK_SCHEMA} from './guest-r29-rollback.mjs';
import {R29_CHAIN_SCHEMA} from '../scripts/r29-release-review.mjs';
import {R29_MERGE_SCHEMA} from '../scripts/r29-merge-tree.mjs';
export const R29_PREFLIGHT_SCHEMA='osmanx.guest.r29.staging-handoff.v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const CODE=/^[A-Z][A-Z0-9_]{1,80}$/;
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const exact=(x,fields)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===[...fields].sort().join('|');
export const R29_TASKS=Object.freeze([
  {code:'HUMAN_SOURCE_REVIEW',title:'Рассмотреть пятнадцать исходных PR',
    evidence:'Независимый code review по порядку, начиная с первого несогласованного PR'},
  {code:'VIRTUAL_MAIN_MERGE',title:'Проверить Git merge-tree без изменения main',
    evidence:'Локальная репетиция конфликтов по точным SHA main и source на одноразовом runner'},
  {code:'STAGING_HTTP_ISOLATION',title:'Пройти реальную staging-цепочку Fastify/PostgreSQL',
    evidence:'Две компании, 401/404, 15-минутный пакет, STOP, контроль zero writes'},
  {code:'SQL_TRANSACTION_ROLLBACK',title:'Проверить SQL-откат на временной базе',
    evidence:'BEGIN/INSERT/ROLLBACK, до и после одинаковые SHA пяти таблиц'},
  {code:'MERGED_MAIN_AND_REAL_HOST',title:'Проверить финальный main и внешний эксплуатационный допуск',
    evidence:'Свежий CI на объединённом main, независимый аудит VPS/DR/юридических условий'}
]);
export function makeR29StagingHandoff({
  r28,chain=null,virtualMerge=null,rollback=null,now=new Date()
}={}){
  if(!verifyR28OperatorPacket(r28,{now}).valid||
     !UUID.test(r28?.pilotId||'')||!SHA.test(r28?.sha256||''))
    throw new TypeError('R29 requires a valid current tenant R28 handoff');
  if(chain!==null&&(chain.schema!==R29_CHAIN_SCHEMA||
    chain.sourcePrCount!==15||chain.automaticMergeAllowed!==false||
    chain.productionAuthorized!==false||
    chain.changedMain!==false))
    throw new TypeError('R29 chain evidence cannot be trusted');
  if(virtualMerge!==null&&(virtualMerge.schema!==R29_MERGE_SCHEMA||
    virtualMerge.realMergePerformed!==false||
    virtualMerge.productionAuthorized!==false||
    virtualMerge.mainRefUnchanged!==true))
    throw new TypeError('R29 virtual merge evidence is unsafe');
  if(rollback!==null&&(rollback.schema!==R29_ROLLBACK_SCHEMA||
    rollback.productionDatabaseTouched!==false||
    rollback.customerGo!==false))
    throw new TypeError('R29 rollback evidence is unsafe');
  const syntheticSnapshotOK=rollback?.targetIsDisposable===true&&
    rollback?.transactionRolledBack===true&&
    rollback?.snapshotsIdentical===true&&
    rollback?.beforeSha===rollback?.afterSha;
  const localMergeReady=virtualMerge?.conflictsAbsent===true&&
    virtualMerge?.mainIsAncestor===true&&
    virtualMerge?.virtualTreeMatchesSource===true;
  const sourceReady=chain?.verifiedSourceTree===true&&
    chain?.sourcePrCount===15&&chain?.allSourceChecks===true;
  const blockers=[];
  if(!sourceReady)blockers.push('R29_SOURCE_CHAIN_UNVERIFIED');
  if(!chain?.allMerged)blockers.push('R29_FIFTEEN_MANUAL_MERGES_REQUIRED');
  if(!localMergeReady)blockers.push('R29_VIRTUAL_MERGE_UNVERIFIED');
  if(!syntheticSnapshotOK)blockers.push('R29_DISPOSABLE_ROLLBACK_UNVERIFIED');
  // Dedicated CI, real main, real host and legal approval cannot be inferred
  // from this private GET nor from a mocked input object.
  blockers.push('R29_STAGING_HTTP_CI_NOT_BOUND_TO_THIS_REPORT');
  blockers.push('R29_FINAL_MAIN_MERGED_TREE_CI_MISSING');
  blockers.push('R29_REAL_VPS_AND_OFFSITE_DR_NOT_VERIFIED');
  blockers.push('R29_LAWFUL_CUSTOMER_APPROVAL_NOT_VERIFIED');
  blockers.push('R29_CHANGE_WINDOW_ROLLBACK_NOT_APPROVED');
  if(r28.stage==='STOP')blockers.push('R29_EMERGENCY_STOP_ACTIVE');
  const issued=now.toISOString();
  const expire=new Date(Math.min(Date.parse(r28.expiresAt),
    now.getTime()+10*60000)).toISOString();
  const body={
    schema:R29_PREFLIGHT_SCHEMA,pilotId:r28.pilotId,
    version:r28.version,r28HandoffSha:r28.sha256,
    issuedAt:issued,expiresAt:expire,
    stage:r28.stage==='STOP'?'STOP':'NO_GO_EXTERNAL_EVIDENCE_PENDING',
    requiredSourcePrs:15,reviewedSourcePrs:sourceReady?15:0,
    firstUnmergedPr:chain?.firstHumanReview?.pr||47,
    checks:{
      sourceChainVerified:sourceReady,
      virtualMergeConflictFree:localMergeReady,
      disposableSqlRollbackVerified:syntheticSnapshotOK,
      stagingHttpRunBoundToPilot:false,
      finalMergedMainCiPassed:false,
      actualProductionVpsVerified:false,
      externalDrCustodyVerified:false,
      legalApprovalVerified:false
    },
    blockers,steps:R29_TASKS.map((task,i)=>({
      order:i+1,...task,executed:false,humanOnly:true
    })),
    completeLocalPreparationForReview:
      sourceReady&&localMergeReady&&syntheticSnapshotOK,
    actualProductionChecked:false,liveClientDataUsed:false,
    noProductionChanges:true,automaticMergeAllowed:false,
    deployAllowed:false,customerGo:false,productionAuthorized:false,
    note:'R29 проверяет исходники и синтетический staging. До ручного слияния, свежего CI на main и внешнего аудита разрешение на реальный запуск не выдаётся.'
  };
  return {...body,sha256:hash(body)};
}
export function verifyR29StagingHandoff(packet,{now=new Date(),
  pilotId,version,r28HandoffSha}={}){
  const bad=[];
  if(!exact(packet,[
    'schema','pilotId','version','r28HandoffSha','issuedAt','expiresAt',
    'stage','requiredSourcePrs','reviewedSourcePrs','firstUnmergedPr',
    'checks','blockers','steps','completeLocalPreparationForReview',
    'actualProductionChecked','liveClientDataUsed','noProductionChanges',
    'automaticMergeAllowed','deployAllowed','customerGo',
    'productionAuthorized','note','sha256'
  ])||packet?.schema!==R29_PREFLIGHT_SCHEMA||
    !UUID.test(packet?.pilotId||'')||
    !SHA.test(packet?.r28HandoffSha||'')||!SHA.test(packet?.sha256||''))
    bad.push('INVALID_PACKET');
  const issued=Date.parse(packet?.issuedAt),expiry=Date.parse(packet?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
     !Number.isFinite(issued)||!Number.isFinite(expiry)||
     issued>now.getTime()||expiry<=now.getTime()||
     expiry-issued>10*60000||expiry<=issued)
    bad.push('EXPIRED_OR_INVALID_CLOCK');
  if(pilotId!==undefined&&packet?.pilotId!==pilotId)bad.push('WRONG_PILOT');
  if(version!==undefined&&packet?.version!==version)bad.push('WRONG_VERSION');
  if(r28HandoffSha!==undefined&&packet?.r28HandoffSha!==r28HandoffSha)
    bad.push('WRONG_R28_HANDOFF');
  if(packet?.requiredSourcePrs!==15||
     !Number.isSafeInteger(packet?.reviewedSourcePrs)||
     packet.reviewedSourcePrs<0||packet.reviewedSourcePrs>15||
     !Number.isSafeInteger(packet?.firstUnmergedPr)||
     packet.firstUnmergedPr<47||packet.firstUnmergedPr>62)
    bad.push('INVALID_PR_SUMMARY');
  if(!Array.isArray(packet?.steps)||packet.steps.length!==5||
    !R29_TASKS.every((step,i)=>packet.steps[i]?.code===step.code&&
      packet.steps[i]?.order===i+1&&
      packet.steps[i]?.executed===false&&
      packet.steps[i]?.humanOnly===true))
    bad.push('UNSAFE_HUMAN_STEPS');
  if(!Array.isArray(packet?.blockers)||packet.blockers.length>50||
     !packet.blockers.every(x=>CODE.test(x))||
     ![
       'R29_FINAL_MAIN_MERGED_TREE_CI_MISSING',
       'R29_REAL_VPS_AND_OFFSITE_DR_NOT_VERIFIED',
       'R29_LAWFUL_CUSTOMER_APPROVAL_NOT_VERIFIED',
       'R29_CHANGE_WINDOW_ROLLBACK_NOT_APPROVED'
     ].every(x=>packet.blockers.includes(x)))
    bad.push('EXTERNAL_BLOCKERS_MISSING');
  for(const k of ['actualProductionChecked','liveClientDataUsed',
    'automaticMergeAllowed','deployAllowed','customerGo',
    'productionAuthorized'])
    if(packet?.[k]!==false)bad.push('UNSAFE_AUTHORIZATION');
  if(packet?.noProductionChanges!==true||
     packet?.checks?.finalMergedMainCiPassed!==false||
     packet?.checks?.actualProductionVpsVerified!==false||
     packet?.checks?.legalApprovalVerified!==false)
    bad.push('UNSAFE_EVIDENCE');
  try{
    const {sha256,...body}=packet;
    if(hash(body)!==sha256)bad.push('CONTENT_TAMPERED');
  }catch{bad.push('MALFORMED_PACKET');}
  return {valid:bad.length===0,blockers:[...new Set(bad)],
    productionAuthorized:false,customerGo:false};
}
export function r29HandoffCsv(packet,{now=new Date()}={}){
  if(!verifyR29StagingHandoff(packet,{now}).valid)
    throw Error('Invalid or expired R29 staging report');
  const rows=[
    ['OSMANX Guest R29','Синтетическая staging-проверка; ручной запуск запрещён'],
    ['Пилот версия',packet.version],
    ['Состояние',packet.stage],
    ['SHA R28',packet.r28HandoffSha],
    ['Создано',packet.issuedAt],['Истекает',packet.expiresAt],
    ['Проверено PR',packet.reviewedSourcePrs+'/'+packet.requiredSourcePrs],
    ['Первый ожидающий PR',packet.firstUnmergedPr]
  ];
  for(const step of packet.steps)
    rows.push(['Этап '+step.order,step.title+'; '+step.evidence]);
  for(const blocker of packet.blockers)rows.push(['Блокировка',blocker]);
  rows.push(['SHA-256 отчёта',packet.sha256]);
  rows.push(['Публикация','ЗАПРЕЩЕНА']);
  rows.push(['Ограничение',packet.note]);
  return csv(rows);
}
