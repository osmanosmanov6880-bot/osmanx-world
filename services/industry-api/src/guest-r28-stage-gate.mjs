/**
 * R28: never auto-promote to production.
 * Deterministically separates proven synthetic model checks, source-CI,
 * independent receipt signatures, and MISSING actual infrastructure review.
 * This planner cannot merge/deploy/enable collection or lift STOP.
 */
import {verifyR27Handoff} from './guest-r27-handoff.mjs';
export const R28_GATE_SCHEMA='osmanx.guest.r28.manual-cutover-gate.v1';
export const R28_STEP_CODES=Object.freeze([
  'DEPENDENCY_SOURCE_REVIEW','MAIN_MERGE_AND_FRESH_CI',
  'INDEPENDENT_OFFLINE_RECEIPTS','ACTUAL_VPS_READONLY_INSPECTION',
  'TWO_ARCHIVE_RESTORE_WITNESS','LEGAL_CLIENT_APPROVAL',
  'MANUAL_CHANGE_WINDOW_AND_ROLLBACK'
]);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const STEPS=Object.freeze({
  DEPENDENCY_SOURCE_REVIEW:{
    label:'Проверить точные исходники всех 14 PR и защиту main',
    proof:'Независимый code review каждого PR, immutable SHA и названия CI'},
  MAIN_MERGE_AND_FRESH_CI:{
    label:'Последовательно объединить PR вручную и заново запустить CI на main',
    proof:'Новый main SHA и зелёные обязательные тесты на merged tree'},
  INDEPENDENT_OFFLINE_RECEIPTS:{
    label:'Получить четыре независимые квитанции Ed25519 с закреплёнными ключами',
    proof:'Подписи infra/recovery/privacy/release на конкретных SHA и сроке'},
  ACTUAL_VPS_READONLY_INSPECTION:{
    label:'Проверить настоящий VPS отдельной командой в режиме только чтения',
    proof:'Подтверждённые HTTPS, ingress, firewalls, роли и runtime без секретов'},
  TWO_ARCHIVE_RESTORE_WITNESS:{
    label:'Подтвердить восстановление двух независимых внешних архивов',
    proof:'Два раздельных AGE recipient, точные контрольные суммы и журнал восстановления'},
  LEGAL_CLIENT_APPROVAL:{
    label:'Подтвердить договор и законное основание обработки данных',
    proof:'Подписанные клиентские документы и проверенные сроки хранения'},
  MANUAL_CHANGE_WINDOW_AND_ROLLBACK:{
    label:'Утвердить окно изменений, двух операторов и репетицию отката',
    proof:'Внепроизводственный rollback с отдельной подписью и регистрацией инцидента'}
});
export function evaluateR28ManualGate({
  handoff,chain=null,receipts=null,now=new Date()
}={}){
  const integrity=verifyR27Handoff(handoff,{now});
  if(!integrity.valid||!UUID.test(handoff?.pilotId||'')||
     !SHA.test(handoff?.sha256||''))
    throw new TypeError('Valid, current R27 source handoff required');
  if(chain!==null&&(
    chain?.schema!=='osmanx.guest.r28.fourteen-source-integration.v1'||
    chain.sourcePrCount!==14||chain.automaticMergeAllowed!==false||
    chain.deployAllowed!==false||chain.productionAuthorized!==false))
    throw new TypeError('Invalid R28 code-chain evidence');
  if(receipts!==null&&(
    receipts?.schema!=='osmanx.guest.r28.offline-verification.v1'||
    receipts.permissionToDeploy!==false||receipts.customerGo!==false))
    throw new TypeError('Invalid R28 independent receipt verification');
  const checks={
    internalSyntheticScenariosPassed:
      handoff.rehearsal?.passedCases===7&&
      handoff.rehearsal?.totalCases===7,
    intactCurrentPilotEvidence:true,
    fourteenSourcePrsVerified:chain?.verifiedStagedSource===true,
    allDependenciesMerged:chain?.allMerged===true,
    freshPostMergeMainCi:chain?.postMergeMainTested===true,
    independentReceiptSignaturesValid:
      receipts?.cryptographicReceiptsVerified===true,
    actualVpsIndependentlyInspected:false,
    externalDrCustodyVerified:false,
    lawfulClientContractApproved:false,
    changeWindowAndRollbackApproved:false
  };
  const blockers=[];
  if(!checks.internalSyntheticScenariosPassed)
    blockers.push('R28_SYNTHETIC_REHEARSAL_FAILED');
  if(!checks.fourteenSourcePrsVerified)
    blockers.push('R28_SOURCE_CI_NOT_INDEPENDENTLY_REVIEWED');
  if(!checks.allDependenciesMerged)
    blockers.push('R28_MANUAL_MERGES_OUTSTANDING');
  if(!checks.freshPostMergeMainCi)
    blockers.push('R28_MAIN_MERGED_TREE_CI_NOT_RUN');
  if(!checks.independentReceiptSignaturesValid)
    blockers.push('R28_FOUR_INDEPENDENT_RECEIPTS_MISSING');
  if(handoff.decision.stage==='SAFETY_HOLD')
    blockers.push('R28_EMERGENCY_STOP_ACTIVE');
  if(handoff.decision.stage==='INTEGRITY_CONFLICT')
    blockers.push('R28_PILOT_EVIDENCE_CONFLICT');
  blockers.push('R28_LIVE_VPS_NOT_INDEPENDENTLY_VERIFIED');
  blockers.push('R28_OFFSITE_DR_NOT_INDEPENDENTLY_VERIFIED');
  blockers.push('R28_LAWFUL_BASIS_NOT_VERIFIED');
  blockers.push('R28_MANUAL_CHANGE_WINDOW_AND_ROLLBACK_NOT_APPROVED');
  const steps=R28_STEP_CODES.map((code,i)=>({
    order:i+1,code,...STEPS[code],
    status:'HUMAN_REVIEW_REQUIRED',executed:false,
    requiresIndependentVerification:true
  }));
  const stage=handoff.decision.stage==='SAFETY_HOLD'?'STOP':
    !checks.fourteenSourcePrsVerified?'SOURCE_CHAIN_UNVERIFIED':
      !checks.allDependenciesMerged?'MANUAL_MERGE_PENDING':
        !checks.freshPostMergeMainCi?'MAIN_CI_PENDING':
          !checks.independentReceiptSignaturesValid?'EXTERNAL_RECEIPTS_PENDING':
            'EXTERNAL_HOST_LEGAL_AND_ROLLBACK_PENDING';
  return {
    schema:R28_GATE_SCHEMA,pilotId:handoff.pilotId,
    version:handoff.version,r27HandoffSha:handoff.sha256,
    releaseSourceSha:chain?.sourceHeadSha||null,
    stage,checks,blockers:[...new Set(blockers)],steps,
    humanNextStep:steps.find((_,i)=>i===0),
    checkedSourcePrs:chain?.sourcePrCount||0,
    externalReceiptsPresent:receipts!==null,
    externalReceiptSignaturesVerified:
      checks.independentReceiptSignaturesValid,
    actualVpsInspected:false,legalApprovalRecorded:false,
    productionEnabled:false,rollbackExecuted:false,
    sourceTrustNotSufficientForCommercialUse:true,
    customerGo:false,productionAuthorized:false,
    automaticMergeAllowed:false,actionAutomaticallyExecuted:false
  };
}
