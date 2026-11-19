/**
 * R25 operational-barrier estimates: one mutually-exclusive category per
 * sampled anonymous interaction. NOT a customer's stated motive and NOT
 * evidence of why they stopped visiting. No free text, identity or small rows.
 */
export const R25_TALLY_SCHEMA='osmanx.guest.r25.operational-tally.v1';
export const R25_PROFILE_SCHEMA='osmanx.guest.r25.operational-profile.v1';
export const R25_CODES=Object.freeze([
  'wait','stockout','ordering','price','service','unknown'
]);
export const R25_SHIFTS=Object.freeze(['morning','afternoon','evening']);
const DAY=86400000,COUNT_LIMIT=10000;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&
  Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const day=raw=>{
  if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw))return NaN;
  const time=Date.parse(raw+'T00:00:00.000Z');
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===raw?
    time:NaN;
};
const validCount=n=>Number.isSafeInteger(n)&&n>=0&&n<=COUNT_LIMIT;
const percent=(a,b)=>b?Math.round(a/b*10000)/100:null;
const wilson=(count,total)=>{
  if(total===0)return null;
  const p=count/total,z=1.959963984540054,z2=z*z,d=1+z2/total;
  const center=(p+z2/(2*total))/d;
  const half=z*Math.sqrt(p*(1-p)/total+z2/(4*total*total))/d;
  return [Math.round(Math.max(0,center-half)*10000)/100,
    Math.round(Math.min(1,center+half)*10000)/100];
};
export function parseR25Tally(value,{protocol,now=new Date()}={}){
  if(!exact(value,['date','shift','source','sampled','counts'])||
    !exact(value?.counts,R25_CODES)||
    !R25_SHIFTS.includes(value.shift)||
    !['staff_estimate','anonymous_counter'].includes(value.source)||
    !validCount(value.sampled)||value.sampled<10||
    !R25_CODES.every(k=>validCount(value.counts[k]))||
    R25_CODES.reduce((sum,k)=>sum+value.counts[k],0)!==value.sampled)
    throw new RangeError('R25 expects an anonymous exclusive bounded tally');
  const observed=day(value.date),start=day(protocol?.startDate),
    end=day(protocol?.endDate);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(observed)||!Number.isFinite(start)||!Number.isFinite(end)||
    start>end||end-start>=90*DAY||observed<start||observed>end||
    observed>now.getTime())
    throw new RangeError('R25 date outside signed pilot or future');
  return {
    date:value.date,shift:value.shift,source:value.source,
    sampled:value.sampled,
    counts:Object.fromEntries(R25_CODES.map(k=>[k,value.counts[k]]))
  };
}
function totalsOf(rows){
  const totals={sampled:0,...Object.fromEntries(R25_CODES.map(k=>[k,0]))};
  for(const row of rows){
    totals.sampled+=row.sampled;
    for(const key of R25_CODES)totals[key]+=row.counts[key];
  }
  return totals;
}
function measures(totals){
  return Object.fromEntries(R25_CODES.map(code=>[code,{
    observed:totals[code],
    sharePct:percent(totals[code],totals.sampled),
    approximate95Pct:wilson(totals[code],totals.sampled)
  }]));
}
export function summarizeR25Operational(rows,{protocol,now=new Date()}={}){
  if(!Array.isArray(rows)||rows.length>36)
    throw new TypeError('R25 maximum of 36 recorded shift aggregates');
  const keys=new Set(),normalized=[];
  for(const item of rows){
    const row=parseR25Tally(item,{protocol,now});
    const key=row.date+'|'+row.shift;
    if(keys.has(key))throw new TypeError('R25 duplicate period and shift');
    keys.add(key);normalized.push(row);
  }
  normalized.sort((a,b)=>a.date.localeCompare(b.date)||
    R25_SHIFTS.indexOf(a.shift)-R25_SHIFTS.indexOf(b.shift));
  const total=totalsOf(normalized);
  const shifts=R25_SHIFTS.map(shift=>{
    const t=totalsOf(normalized.filter(row=>row.shift===shift));
    return {shift,periods:normalized.filter(r=>r.shift===shift).length,
      sampled:t.sampled,categories:measures(t)};
  });
  const dates=[...new Set(normalized.map(x=>x.date))];
  const midpoint=Math.ceil(dates.length/2);
  const early=normalized.filter(r=>dates.indexOf(r.date)<midpoint);
  const late=normalized.filter(r=>dates.indexOf(r.date)>=midpoint);
  const e=totalsOf(early),l=totalsOf(late);
  const comparable=dates.length>=2&&e.sampled>=20&&l.sampled>=20;
  const changes=Object.fromEntries(R25_CODES.map(code=>[code,{
    earlyPct:percent(e[code],e.sampled),
    latePct:percent(l[code],l.sampled),
    changePp:comparable?Math.round(
      (l[code]/l.sampled-e[code]/e.sampled)*10000)/100:null
  }]));
  const warningCodes=[];
  if(!rows.length)warningCodes.push('NO_OPERATIONAL_TALLIES');
  if(!comparable)warningCodes.push('PERIOD_COMPARISON_INSUFFICIENT');
  if(normalized.some(row=>row.source==='staff_estimate'))
    warningCodes.push('STAFF_ESTIMATE_NOT_GUEST_REPORTED');
  if(total.sampled&&total.unknown/total.sampled>=.25)
    warningCodes.push('LARGE_UNKNOWN_SHARE');
  if(comparable)warningCodes.push('EXPLORATORY_PERIOD_SPLIT_ONLY');
  const top=R25_CODES.filter(code=>code!=='unknown')
    .map(code=>({code,count:total[code],
      sharePct:percent(total[code],total.sampled)}))
    .sort((a,b)=>b.count-a.count||a.code.localeCompare(b.code))[0]||null;
  return {schema:R25_PROFILE_SCHEMA,recordedShifts:normalized.length,
    recordedDays:dates.length,totalSampled:total.sampled,
    categorizedTotal:total,categoryShares:measures(total),
    shifts,periodComparison:{
      comparable,early:{days:dates.slice(0,midpoint).length,sampled:e.sampled},
      late:{days:dates.slice(midpoint).length,sampled:l.sampled},
      changes
    },dominantObservedBarrier:top&&top.count>=5?top:null,
    warningCodes,
    dataOrigin:'staff-coded-or-anonymous-counter-aggregate-only',
    customerReportedReasonsVerified:false,individualReasonsKnown:false,
    causalExplanationProven:false,guestIdentifiersIncluded:false};
}
