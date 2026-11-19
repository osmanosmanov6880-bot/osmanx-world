/**
 * R24 decision economics: scenario calculator, not realized revenue/profit.
 * Reuses the existing experiment-model cost assumptions and retention CI.
 * Missing or invalid price inputs are NOT silently guessed.
 */
import {cohort,economics} from '../shared/experiment-model.js';
import {R24_STAT_SCHEMA} from './guest-r24-statistics.mjs';
import {R24_QUALITY_SCHEMA} from './guest-r24-quality.mjs';
export const R24_ECON_SCHEMA='osmanx.guest.r24.scenario-economics.v1';
const rub=n=>Math.round(n*100)/100;
export function modelR24Economics({plan,quality,statistics}={}){
  if(quality?.schema!==R24_QUALITY_SCHEMA||
     statistics?.schema!==R24_STAT_SCHEMA)
    throw new TypeError('R24 economics requires validated aggregates');
  const empty={schema:R24_ECON_SCHEMA,state:'UNAVAILABLE',
    scenarioOnly:true,realizedRevenueKnown:false,causalProfitProven:false,
    inputsAuditedExternally:false,breakEvenDifferencePp:null,
    minimumExtraReturns:null,financialRangeRub:null,
    observedDifferenceScenarioRub:null,scenarioRub:null,
    risks:[],disclaimer:'Только финансовая модель при заданных допущениях. Не является фактическим ростом продаж, гарантией прибыли или подтверждением причинного эффекта.'};
  if(quality.periodCount===0||statistics.state==='NO_DATA')
    return {...empty,state:'NO_OBSERVATIONS'};
  if(!plan||typeof plan!=='object'||Array.isArray(plan))
    return {...empty,state:'MISSING_COST_ASSUMPTIONS'};
  try{
    const t=quality.totals;
    const c=cohort({control:String(t.control),
      controlReturn:String(t.controlReturn),
      offer:String(t.offer),offerReturn:String(t.offerReturn)});
    const e=economics({
      margin:plan.margin,discount:plan.discount,fixed:plan.fixed,fee:plan.fee
    },c);
    if(![e.costs,e.net,...e.rangeNet].every(Number.isFinite))
      throw new RangeError('Nonfinite economics');
    const minReturns=e.margin>0?Math.ceil(e.costs/e.margin):null;
    const breakEven=e.margin>0?
      rub((e.costs/(e.margin*c.offerSize))*100):null;
    const risk=[];
    if(quality.blocking)risk.push('QUALITY_BLOCKERS');
    if(statistics.intervalIncludesZero)risk.push('INTERVAL_CROSSES_ZERO');
    if(!quality.randomizedDeclared)risk.push('NON_RANDOM_ALLOCATION');
    if(!quality.outcomeWindowCompleted)risk.push('OUTCOME_WINDOW_OPEN');
    if(minReturns===null)risk.push('ZERO_MARGIN');
    if(breakEven>100)risk.push('BREAKEVEN_EXCEEDS_POSSIBLE_RETURNS');
    if(e.rangeNet[0]<0)risk.push('NEGATIVE_DOWNSIDE');
    return {...empty,
      state:quality.blocking?'QUALITY_BLOCKED':'SCENARIO_ONLY',
      costAssumptionsRub:{
        marginPerExtraVisit:rub(e.margin),offerCostPerGuest:rub(e.discount),
        fixed:rub(e.fixed),serviceFee:rub(e.fee),
        modeledTotal:rub(e.costs)
      },
      breakEvenDifferencePp:breakEven,
      minimumExtraReturns:minReturns,
      financialRangeRub:[rub(e.rangeNet[0]),rub(e.rangeNet[1])],
      observedDifferenceScenarioRub:rub(e.net),
      scenarioRub:{
        conservative:rub(e.rangeNet[0]),
        observedDifference:rub(e.net),
        optimistic:rub(e.rangeNet[1])
      },
      modeledExtraReturns:rub(e.incrementalVisits),
      risks:risk,
      disclaimer:empty.disclaimer
    };
  }catch{
    return {...empty,state:'INVALID_COST_ASSUMPTIONS',
      risks:['REVIEW_FINANCIAL_INPUTS']};
  }
}
