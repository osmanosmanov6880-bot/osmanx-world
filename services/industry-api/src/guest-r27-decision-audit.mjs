/**
 * R27 cross-layer decision integrity: R24 retention, R25 anonymous process
 * observations, R26 internal source declarations. No guest identifiers
 * and NO causal inference or automatic operational actions.
 */
import {verifyR24Brief} from './guest-r24-brief.mjs';
import {verifyR25Brief} from './guest-r25-brief.mjs';
import {verifyR26Brief} from './guest-r26-brief.mjs';
export const R27_AUDIT_SCHEMA='osmanx.guest.r27.decision-integrity.v1';
const SHA=/^[a-f0-9]{64}$/;
const codeOk=c=>typeof c==='string'&&/^[A-Z][A-Z0-9_]{1,70}$/.test(c);
const seriousBias=new Set([
  'SHIFT_COMPOSITION_CHANGED','SOURCE_COMPOSITION_CHANGED',
  'ONE_SHIFT_DOMINATES_SAMPLE','POSSIBLE_AGGREGATE_TREND_REVERSAL',
  'LEADER_UNSTABLE_LEAVE_ONE_DAY_OUT'
]);
export function auditR27Decision({r24,r25,r26}={}){
  if(!verifyR24Brief(r24).valid||!verifyR25Brief(r25).valid||
     !verifyR26Brief(r26).valid)
    throw new TypeError('R27 refuses invalid or altered evidence envelopes');
  const samePilot=r24.pilotId===r25.pilotId&&r24.pilotId===r26.pilotId;
  const sameVersion=r24.version===r25.version&&r24.version===r26.version;
  const sameR24=SHA.test(r24.evidenceDigest||'')&&
    r25.r24EvidenceSha===r24.evidenceDigest&&
    r26.r24EvidenceSha===r24.evidenceDigest;
  const sameR25=r25.tallySourceSha===r26.r25SourceSha&&
    r25.sha256===r26.r25BriefSha&&
    r25.profile.recordedShifts===r26.sourceRowCount&&
    r25.profile.totalSampled===r26.sourceSampled;
  const stopPropagated=r24.stopped===r25.emergencyStopActive&&
    r24.stopped===r26.stopActive;
  const dataQualityClear=r24.quality.analysisStatus!=='BLOCKED'&&
    !r24.quality.issues.some(c=>
      ['PROTOCOL_MISSING_OR_INVALID','NO_OBSERVATIONS',
        'OBSERVATION_IN_FUTURE','OBSERVATION_OUTSIDE_PROTOCOL'].includes(c));
  const targetSampleReached=r24.sample.enough===true;
  const observationWindowComplete=r24.quality.outcomeWindowCompleted===true;
  const repeatEvidenceAvailable=r24.observedPeriods>0&&
    r24.statistics.differencePp!==null;
  const sufficientShiftCount=r25.profile.recordedShifts>=3&&
    r25.profile.totalSampled>=60;
  const internalReviewComplete=r26.review.internalDeclarationsComplete===true;
  const shiftMixStable=!r26.bias.warnings.some(c=>seriousBias.has(c));
  const scenariosAreNotRealProfit=r24.scenario.state!=='REALIZED_PROFIT'&&
    r24.scenario.state!=='PROVEN_ROI';
  const independentAuditUnavailable=r26.externalAuditCompleted===false&&
    r26.review.reviewedPrimaryEvidenceExternally===false;
  const checks={
    samePilot,sameVersion,sameR24,sameR25,stopPropagated,
    noEmergencyStop:!r26.stopActive,
    dataQualityClear,targetSampleReached,observationWindowComplete,
    repeatEvidenceAvailable,sufficientShiftCount,internalReviewComplete,
    shiftMixStable,scenariosAreNotRealProfit,independentAuditUnavailable
  };
  const blockers=Object.entries(checks)
    .filter(([name,pass])=>!pass)
    .map(([name])=>'R27_'+name.replace(/[A-Z]/g,m=>'_'+m).toUpperCase());
  if(!samePilot||!sameVersion||!sameR24||!sameR25||!stopPropagated)
    blockers.push('R27_CROSS_LAYER_SNAPSHOT_CONFLICT');
  if(!independentAuditUnavailable)
    blockers.push('R27_UNEXPECTED_EXTERNAL_APPROVAL_CLAIM');
  // Even all-green internal checks cannot establish causal or legal GO.
  blockers.push('R27_EXTERNAL_SOURCE_AUDIT_REQUIRED');
  blockers.push('R27_LEGAL_AND_PRODUCTION_APPROVAL_REQUIRED');
  const warnings=[
    ...r24.quality.issues,
    ...(r24.statistics.riskCodes||[]),
    ...r25.profile.warningCodes,
    ...r26.bias.warnings
  ].filter(codeOk).slice(0,60);
  const stage=!samePilot||!sameVersion||!sameR24||!sameR25||!stopPropagated?
    'INTEGRITY_CONFLICT':r26.stopActive?'SAFETY_HOLD':
      !dataQualityClear?'DATA_BLOCKED':
      !internalReviewComplete?'SOURCE_REVIEW_PENDING':
      !shiftMixStable?'SHIFT_BIAS_REVIEW':
      !targetSampleReached||!observationWindowComplete||!sufficientShiftCount?
        'MORE_EVIDENCE_REQUIRED':'EXTERNAL_REVIEW_REQUIRED';
  const next=r26.decision.firstAction;
  return {
    schema:R27_AUDIT_SCHEMA,pilotId:r24.pilotId,version:r24.version,
    r24EvidenceSha:r24.evidenceDigest,
    r25SourceSha:r25.tallySourceSha,r26BriefSha:r26.sha256,
    state:stage,checks,
    blockers:[...new Set(blockers)],warnings:[...new Set(warnings)],
    nextAction:{code:next.code,title:next.title,
      evidence:next.evidence,requiresHumanOwner:true,created:false},
    evidenceReviewInternallyComplete:internalReviewComplete,
    independentExternalAuditDone:false,
    decisionMayBeConsideredByHuman:
      stage==='EXTERNAL_REVIEW_REQUIRED'||stage==='SHIFT_BIAS_REVIEW',
    customerMotivesKnown:false,causalEffectProven:false,
    actualROIValidated:false,automaticActionTaken:false,
    newPilotStarted:false,customerGo:false,
    productionAuthorized:false,
    disclaimer:'Даже согласованные R24–R26 агрегаты не доказывают причинный эффект. Внешний аудит, правовые основания и отдельная эксплуатационная приёмка обязательны.'
  };
}
