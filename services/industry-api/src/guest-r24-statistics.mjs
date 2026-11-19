/**
 * R24 independent, observational retention comparison.
 * Reuses existing Newcombe/Wilson model; estimates are NOT causal.
 */
import {cohort} from '../shared/experiment-model.js';
import {R24_QUALITY_SCHEMA} from './guest-r24-quality.mjs';
export const R24_STAT_SCHEMA='osmanx.guest.r24.statistical-summary.v1';
const round=(n,d=2)=>Math.round(n*10**d)/10**d;
export function summarizeR24Retention(quality){
  if(quality?.schema!==R24_QUALITY_SCHEMA)
    throw new TypeError('R24 requires a validated quality snapshot');
  const empty={
    schema:R24_STAT_SCHEMA,state:'NO_DATA',
    controlRatePct:null,offerRatePct:null,differencePp:null,
    interval95Pp:null,intervalIncludesZero:null,
    sample:{control:quality.totals.control,offer:quality.totals.offer,
      targetReached:quality.sampleEnough},
    claim:'no_causal_inference',observationalOnly:true,
    noGuaranteedLift:true
  };
  if(quality.periodCount===0)return empty;
  const t=quality.totals;
  const c=cohort({
    control:String(t.control),controlReturn:String(t.controlReturn),
    offer:String(t.offer),offerReturn:String(t.offerReturn)
  });
  const interval=[round(c.range[0]*100),round(c.range[1]*100)];
  const flags=[];
  if(quality.blocking)flags.push('QUALITY_BLOCKER');
  if(!quality.sampleEnough)flags.push('INSUFFICIENT_TARGET_SAMPLE');
  if(!quality.randomizedDeclared)flags.push('RANDOMIZATION_NOT_VERIFIED');
  if(!quality.protocolProspective)flags.push('LATE_PROTOCOL');
  if(!quality.outcomeWindowCompleted)flags.push('INCOMPLETE_RETURN_WINDOW');
  if(c.small)flags.push('SMALL_SAMPLE_OR_RARE_EVENTS');
  if(c.uncertain)flags.push('INTERVAL_CROSSES_ZERO');
  const state=quality.blocking?'QUALITY_BLOCKED':
    flags.length?'EXPLORATORY':'ELIGIBLE_FOR_INDEPENDENT_REVIEW';
  return {...empty,
    state,controlRatePct:round(c.controlRate*100),
    offerRatePct:round(c.offerRate*100),
    differencePp:round(c.difference*100),
    interval95Pp:interval,intervalIncludesZero:c.uncertain,
    favorableObservedDifference:c.difference>0,
    uncertaintyFlags:flags,
    intervalMethod:'Newcombe-Wilson 95% approximate interval for independent proportions',
    caveat:'Интервал не учитывает кластеризацию, совпадение гостей между группами, смещения отбора и множественные проверки. Разница наблюдаемых долей не доказывает причину.'
  };
}
