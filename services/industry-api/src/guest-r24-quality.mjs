/**
 * R24 quality gate for AGGREGATED pilot outcomes only.
 * Flags observable problems; it cannot detect repeated real identities,
 * manipulation of primary records or establish randomization/causality.
 */
export const R24_QUALITY_SCHEMA='osmanx.guest.r24.aggregate-quality.v1';
const DAY=86400000;
const MAX_COUNT=10000000;
function utcDay(raw){
  if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw))return NaN;
  const ms=Date.parse(raw+'T00:00:00.000Z');
  return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===raw?ms:NaN;
}
function num(n){return Number.isSafeInteger(n)&&n>=0&&n<=MAX_COUNT;}
function add(issues,code,severity){
  if(!issues.some(x=>x.code===code))issues.push({code,severity});
}
const rank={blocker:0,warning:1,note:2};
export function inspectR24AggregateQuality({pilot,observations,now=new Date()}={}){
  if(!pilot||!Array.isArray(observations)||observations.length>12||
    !(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isSafeInteger(pilot.target_per_group)||
    pilot.target_per_group<1||pilot.target_per_group>MAX_COUNT)
    throw new TypeError('Invalid bounded R24 pilot input');
  const issues=[],totals={control:0,controlReturn:0,offer:0,offerReturn:0};
  const dates=new Set(),periods=[];
  const p=pilot.protocol;
  const start=utcDay(p?.startDate),end=utcDay(p?.endDate);
  const outcomeDays=p?.outcomeWindowDays;
  const protocolValid=Number.isFinite(start)&&Number.isFinite(end)&&end>=start&&
    end-start<90*DAY&&Number.isSafeInteger(outcomeDays)&&
    outcomeDays>=1&&outcomeDays<=90;
  const registered=pilot.protocol_registered_at?
    Date.parse(pilot.protocol_registered_at):NaN;
  if(!protocolValid)add(issues,'PROTOCOL_MISSING_OR_INVALID','blocker');
  else if(!Number.isFinite(registered)||registered>=start+DAY)
    add(issues,'PROTOCOL_NOT_PREREGISTERED','warning');
  if(p?.allocation!=='random')
    add(issues,'NON_RANDOM_ASSIGNMENT','warning');
  if(p?.source==='manual')
    add(issues,'MANUAL_AGGREGATE_SOURCE','warning');
  if(observations.length===0)add(issues,'NO_OBSERVATIONS','blocker');
  for(const row of observations){
    const date=utcDay(row?.date);
    if(!Number.isFinite(date)||dates.has(row.date)||
      !['control','controlReturn','offer','offerReturn'].every(k=>num(row?.[k]))||
      row.control<1||row.offer<1||
      row.controlReturn>row.control||row.offerReturn>row.offer)
      throw new TypeError('Invalid or duplicate aggregate observation');
    dates.add(row.date);
    for(const k of Object.keys(totals)){
      totals[k]+=row[k];
      if(!Number.isSafeInteger(totals[k])||totals[k]>MAX_COUNT)
        throw new RangeError('Total count out of supported range');
    }
    if(date>now.getTime()+DAY)
      add(issues,'OBSERVATION_IN_FUTURE','blocker');
    if(protocolValid&&(date<start||date>end))
      add(issues,'OBSERVATION_OUTSIDE_PROTOCOL','blocker');
    if(Math.max(row.control,row.offer)/Math.min(row.control,row.offer)>1.25)
      add(issues,'UNBALANCED_PERIOD_GROUPS','warning');
    periods.push({day:row.date,control:row.control,offer:row.offer,
      controlReturns:row.controlReturn,offerReturns:row.offerReturn});
  }
  periods.sort((a,b)=>a.day.localeCompare(b.day));
  const sampleEnough=totals.control>=pilot.target_per_group&&
    totals.offer>=pilot.target_per_group;
  if(observations.length>0&&!sampleEnough)
    add(issues,'TARGET_SAMPLE_NOT_REACHED','warning');
  if(totals.control&&totals.offer&&
    Math.max(totals.control,totals.offer)/Math.min(totals.control,totals.offer)>1.2)
    add(issues,'UNBALANCED_TOTAL_GROUPS','warning');
  const outcomeComplete=protocolValid&&
    now.getTime()>=end+outcomeDays*DAY;
  if(protocolValid&&!outcomeComplete)
    add(issues,'OUTCOME_WINDOW_NOT_COMPLETED','warning');
  issues.sort((a,b)=>rank[a.severity]-rank[b.severity]||
    a.code.localeCompare(b.code));
  return {
    schema:R24_QUALITY_SCHEMA,periodCount:observations.length,
    totals,periods,issues,blocking:issues.some(i=>i.severity==='blocker'),
    sampleEnough,protocolValid,
    protocolProspective:protocolValid&&Number.isFinite(registered)&&
      registered<start+DAY,
    randomizedDeclared:p?.allocation==='random',
    outcomeWindowCompleted:outcomeComplete,
    analysisStatus:issues.some(i=>i.severity==='blocker')?'BLOCKED':
      !sampleEnough||!outcomeComplete?'PRELIMINARY':'REVIEW_ONLY',
    unverifiedAssumptions:[
      'real_guest_identity_deduplication','independent_randomization_audit',
      'source_data_accuracy','customer_legal_basis'
    ],
    disclaimer:'Проверка оценивает агрегированные числа и даты, но не подтверждает качество персональных источников, случайность распределения или причинность.'
  };
}
