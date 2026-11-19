/**
 * R25 proposed controlled test (document only). A new pilot MUST be separately
 * registered and legally approved; no mutation of the existing experiment.
 */
import {R25_PROFILE_SCHEMA} from './guest-r25-signals.mjs';
import {R25_HYPOTHESIS_SCHEMA} from './guest-r25-hypotheses.mjs';
export const R25_EXPERIMENT_SCHEMA='osmanx.guest.r25.next-test-draft.v1';
const isoDate=ms=>new Date(ms).toISOString().slice(0,10);
const DAY=86400000;
export function draftR25Experiment({
  pilot,profile,board,r24,stopActive=false,now=new Date()
}={}){
  if(!pilot||profile?.schema!==R25_PROFILE_SCHEMA||
    board?.schema!==R25_HYPOTHESIS_SCHEMA||
    !(now instanceof Date)||!Number.isFinite(now.getTime()))
    throw new TypeError('R25 proposed test requires bounded evidence');
  const next=board.hypotheses.find(x=>x.code===board.leadingHypothesis);
  const hasTarget=Number.isSafeInteger(pilot.target_per_group)&&
    pilot.target_per_group>=1&&pilot.target_per_group<=1000000;
  const followUp=pilot.protocol?.outcomeWindowDays;
  const windowOK=Number.isSafeInteger(followUp)&&followUp>=1&&followUp<=90;
  const start=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())+DAY;
  const candidates=[
    ['NO_PRIOR_OPERATIONAL_SIGNALS',!next],
    ['SAMPLE_TARGET_UNAVAILABLE',!hasTarget],
    ['RETURN_WINDOW_UNAVAILABLE',!windowOK],
    ['EMERGENCY_HOLD_REQUIRES_REVIEW',stopActive],
    ['DATA_QUALITY_REVIEW_REQUIRED',r24?.quality?.analysisStatus==='BLOCKED'],
    ['EXISTING_PILOT_NOT_FINALIZED',
      !['in_review','reviewed','archived','returned'].includes(pilot.phase)]
  ];
  const blockers=candidates.filter(([,value])=>value).map(([code])=>code);
  const selected=next?{
    code:next.code,title:next.title,intervention:next.test,
    validation:next.verification,guardrail:next.guardrail
  }:null;
  const protocolDraft=blockers.length===0?{
    newPilotRequired:true,
    primaryOutcome:'repeat_visit',
    comparison:'randomly_assigned_comparable_shifts',
    preliminarySamplePerGroup:pilot.target_per_group,
    sampleSizeNotPowerValidated:true,
    exposureStart:isoDate(start),
    exposureEnd:isoDate(start+13*DAY),
    repeatWindowDays:followUp,
    resultsNotBefore:isoDate(start+(13+followUp)*DAY),
    measureAnonymousBarriers:true,
    preRegisterBeforeAnyCollection:true,
    independentGroupOverlapAudit:true,
    control:'existing_service_process',
    intervention:selected.intervention,
    guardrail:selected.guardrail
  }:null;
  return {schema:R25_EXPERIMENT_SCHEMA,selectedHypothesis:selected,
    blockers,protocolDraft,
    eligibleForHumanDesignReview:blockers.length===0,
    independentLegalAndPrivacyApprovalRequired:true,
    ownerAndManagerApprovalRequired:true,
    offsiteEvidenceRetentionReviewRequired:true,
    signedScopeRequiredForNewPilot:true,
    automaticExperimentStart:false,
    writesEnabled:false,
    stopLifted:false,customerGo:false,productionAuthorized:false,
    warning:'План — гипотеза для нового отдельного испытания. Случайность назначения, достаточность выборки, документы и реальное влияние не установлены.'
  };
}
