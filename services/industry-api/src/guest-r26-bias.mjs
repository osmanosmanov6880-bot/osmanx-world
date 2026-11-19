/**
 * R26: diagnostic checks on anonymous R25 shift aggregates.
 * Apparent frequencies are descriptive. Shift/source imbalances and
 * leave-one-day-out instability are sensitivity warnings, NOT causal proof.
 */
import {R25_CODES,R25_SHIFTS,parseR25Tally,
  R25_PROFILE_SCHEMA} from './guest-r25-signals.mjs';
export const R26_BIAS_SCHEMA='osmanx.guest.r26.source-bias.v1';
const PCT=n=>Math.round(n*10000)/100;
const rate=(n,d)=>d>0?PCT(n/d):null;
const summarize=(rows,key)=>Object.fromEntries(key.map(v=>[
  v,rows.filter(r=>r.shift===v).reduce((n,r)=>n+r.sampled,0)
]));
const source=(rows,type)=>rows.filter(x=>x.source===type)
  .reduce((n,x)=>n+x.sampled,0);
const sum=rows=>rows.reduce((n,x)=>n+x.sampled,0);
const count=(rows,code)=>rows.reduce((n,x)=>n+x.counts[code],0);
function leader(rows){
  return R25_CODES.filter(x=>x!=='unknown')
    .map(code=>({code,n:count(rows,code)}))
    .sort((a,b)=>b.n-a.n||a.code.localeCompare(b.code))[0]?.code||null;
}
function shiftWeights(rows){
  const total=sum(rows);
  const per=summarize(rows,R25_SHIFTS);
  return Object.fromEntries(R25_SHIFTS.map(s=>[s,
    total?per[s]/total:0]));
}
export function assessR26SignalReliability({rows,profile,protocol,
  now=new Date()}={}){
  if(profile?.schema!==R25_PROFILE_SCHEMA||
     !Array.isArray(rows)||rows.length>36)
    throw new TypeError('Validated R25 aggregate profile required');
  const seen=new Set(),clean=[];
  for(const item of rows){
    const r=parseR25Tally(item,{protocol,now});
    const key=r.date+'|'+r.shift;
    if(seen.has(key))throw new TypeError('Duplicate R25 shift sample');
    seen.add(key);clean.push(r);
  }
  const sample=sum(clean);
  if(sample!==profile.totalSampled||clean.length!==profile.recordedShifts)
    throw new TypeError('Source profile no longer matches input');
  const days=[...new Set(clean.map(x=>x.date))].sort();
  const middle=Math.ceil(days.length/2);
  const early=clean.filter(x=>days.indexOf(x.date)<middle);
  const late=clean.filter(x=>days.indexOf(x.date)>=middle);
  const a=shiftWeights(early),b=shiftWeights(late);
  const drift=days.length>=2?PCT(R25_SHIFTS.reduce((n,s)=>
    n+Math.abs(a[s]-b[s]),0)/2):null;
  const earlierStaff=sum(early)?rate(source(early,'staff_estimate'),sum(early)):null;
  const laterStaff=sum(late)?rate(source(late,'staff_estimate'),sum(late)):null;
  const staffShift=Math.abs((earlierStaff??0)-(laterStaff??0));
  const staffShare=rate(source(clean,'staff_estimate'),sample);
  const counterShare=rate(source(clean,'anonymous_counter'),sample);
  const unknownShare=rate(count(clean,'unknown'),sample);
  const registeredShifts=R25_SHIFTS.filter(s=>clean.some(r=>r.shift===s));
  const concentration=sample?Math.max(...R25_SHIFTS.map(s=>
    clean.filter(x=>x.shift===s).reduce((n,x)=>n+x.sampled,0)))/sample:0;
  const originalLeader=leader(clean);
  const unstable=days.length>=3&&days.some(day=>{
    const rest=clean.filter(r=>r.date!==day);
    return rest.length>0&&leader(rest)!==originalLeader;
  });
  // Compositional reversal warning: aggregate period trend and multiple
  // comparable *within-shift* trends point in opposite directions.
  const reversalCodes=[];
  if(days.length>=2&&sum(early)>0&&sum(late)>0){
    for(const code of R25_CODES.filter(k=>k!=='unknown')){
      const overall=count(late,code)/sum(late)-count(early,code)/sum(early);
      if(Math.abs(overall)<.0001)continue;
      const comparable=R25_SHIFTS.filter(s=>{
        const x=early.filter(r=>r.shift===s),y=late.filter(r=>r.shift===s);
        return sum(x)>=10&&sum(y)>=10;
      });
      if(comparable.length<2)continue;
      const sameOpposite=comparable.every(s=>{
        const x=early.filter(r=>r.shift===s),y=late.filter(r=>r.shift===s);
        const within=count(y,code)/sum(y)-count(x,code)/sum(x);
        return Math.abs(within)>.0001&&Math.sign(within)===-Math.sign(overall);
      });
      if(sameOpposite)reversalCodes.push(code);
    }
  }
  const warnings=[];
  if(sample<60)warnings.push('LIMITED_ANONYMOUS_SAMPLE');
  if(registeredShifts.length<2)warnings.push('SHIFT_COVERAGE_LIMITED');
  if(concentration>.7)warnings.push('ONE_SHIFT_DOMINATES_SAMPLE');
  if(staffShare!==null&&staffShare>50)
    warnings.push('STAFF_ESTIMATE_DOMINATES_SOURCE');
  if(unknownShare!==null&&unknownShare>=25)
    warnings.push('UNKNOWN_CATEGORY_TOO_LARGE');
  if(drift!==null&&drift>25)warnings.push('SHIFT_COMPOSITION_CHANGED');
  if(earlierStaff!==null&&laterStaff!==null&&staffShift>25)
    warnings.push('SOURCE_COMPOSITION_CHANGED');
  if(unstable)warnings.push('LEADER_UNSTABLE_LEAVE_ONE_DAY_OUT');
  if(reversalCodes.length)warnings.push('POSSIBLE_AGGREGATE_TREND_REVERSAL');
  if(!days.length)warnings.push('NO_ANONYMOUS_TALLIES');
  return {
    schema:R26_BIAS_SCHEMA,
    periods:days.length,shiftsObserved:registeredShifts,
    totalSampled:sample,
    sourceMix:{staffPct:staffShare,counterPct:counterShare},
    unknownPct:unknownShare,
    highestShiftPct:sample?PCT(concentration):null,
    earlyLateShiftDriftPct:drift,
    earlyLateStaffPct:{early:earlierStaff,late:laterStaff},
    dominantCode:sample?originalLeader:null,
    leaveOneDayOutLeaderUnstable:unstable,
    possibleReversalCodes:reversalCodes,
    warnings,
    rawEventsUsed:false,individualMotiveInferred:false,
    representativeSamplingProven:false,
    independentSourceVerification:false,
    causalExplanationProven:false,
    disclaimer:'Проверка состава смен, источников и устойчивости частот. Не устанавливает причину и не подтверждает достоверность первичного учёта.'
  };
}
