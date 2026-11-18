/**
 * OSMANX Guest Intelligence R9 — transparent rules, NOT causal attribution or AI.
 * Inputs: tenant-scoped, aggregate-only rows from the existing Guest API.
 * Output: deterministic quality signals and concrete, falsifiable next steps.
 */
export const DIAGNOSTIC_SCHEMA='osmanx.guest.diagnostic.v1';
export const RECOMMENDATIONS=Object.freeze({
  COLLECT_OBSERVATIONS:Object.freeze({
    title:'Собрать обезличенные наблюдения',
    action:'Запишите агрегированные контрольные и тестовые группы за утверждённый период.'
  }),
  RECRUIT_MORE_GUESTS:Object.freeze({
    title:'Проверить достаточность выборки',
    action:'Сопоставьте объём непересекающихся групп с рассчитанным минимумом до итогового вывода.'
  }),
  VERIFY_GROUP_ASSIGNMENT:Object.freeze({
    title:'Проверить распределение групп',
    action:'Зафиксируйте независимость когорт и фактический метод отбора. Сопоставление не является рандомизацией.'
  }),
  CHECK_GROUP_BALANCE:Object.freeze({
    title:'Проверить баланс групп',
    action:'Проверьте источник и правила распределения: группы различаются по размеру более чем на 20%.'
  }),
  VALIDATE_SOURCE:Object.freeze({
    title:'Проверить происхождение показателей',
    action:'Сверьте ручные агрегаты с первичным разрешённым источником и журналом исправлений.'
  }),
  REGISTER_FUTURE_PROTOCOL:Object.freeze({
    title:'Зарегистрировать следующий протокол заранее',
    action:'Зафиксируйте сроки, группы и главный показатель до первого наблюдения нового пилота.'
  }),
  VERIFY_PERIOD_COVERAGE:Object.freeze({
    title:'Проверить полноту периодов',
    action:'Сверьте покрытие дат с планом сбора, не заменяйте отсутствующие периоды нулями.'
  }),
  VERIFY_REPEAT_DEFINITION:Object.freeze({
    title:'Уточнить определение повторного визита',
    action:'Проверьте единую длительность окна возврата и одинаковое правило учёта обеих групп.'
  }),
  INVESTIGATE_GUEST_JOURNEY:Object.freeze({
    title:'Проверить путь возвращения гостей',
    action:'Разберите наблюдаемое снижение без утверждения его причины; проверьте удобство повторного заказа.'
  }),
  REVIEW_CONTROLLED_FOLLOWUP:Object.freeze({
    title:'Предложить следующий контролируемый шаг',
    action:'Обсудите с владельцем повторную проверку в новых независимых группах, без обещаний прибыли.'
  })
});
export const ACTION_CODES=Object.freeze(Object.keys(RECOMMENDATIONS));

const safeCount=n=>Number.isSafeInteger(n)&&n>=0&&n<=100000000;
const round=n=>Math.round(n*100)/100;
function msDay(raw){
  if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw))return NaN;
  const d=Date.parse(raw+'T00:00:00.000Z');
  return Number.isFinite(d)?d:NaN;
}
export function diagnoseAggregates({pilot,observations,now=new Date()}){
  if(!pilot||!Array.isArray(observations)||observations.length>12||
     !Number.isSafeInteger(pilot.target_per_group)||pilot.target_per_group<1)
    throw new TypeError('Invalid aggregate pilot data');
  const totals={control:0,controlReturn:0,offer:0,offerReturn:0};
  const dates=new Set();
  for(const o of observations){
    if(!Number.isFinite(msDay(o.date))||dates.has(o.date)||
       !safeCount(o.control)||!safeCount(o.offer)||!safeCount(o.controlReturn)||
       !safeCount(o.offerReturn)||o.control<1||o.offer<1||
       o.controlReturn>o.control||o.offerReturn>o.offer)
      throw new TypeError('Invalid aggregate observation');
    dates.add(o.date);
    for(const k of Object.keys(totals))totals[k]+=o[k];
    if(Object.values(totals).some(v=>!Number.isSafeInteger(v)))
      throw new RangeError('Aggregate overflow');
  }
  const s=pilot.protocol||null;
  const windowStart=s?.startDate||null,windowEnd=s?.endDate||null;
  const retrospective=!!(s&&pilot.protocol_registered_at&&
    Date.parse(pilot.protocol_registered_at)>msDay(windowStart));
  const w=windowStart&&windowEnd?
    Math.max(1,Math.round((msDay(windowEnd)-msDay(windowStart))/86400000)+1):null;
  const record=(code,severity,why)=>{
    const descriptor=RECOMMENDATIONS[code];
    recommendations.push({code,severity,title:descriptor.title,why,nextStep:descriptor.action});
  };
  const recommendations=[];
  const enough=totals.control>=pilot.target_per_group&&totals.offer>=pilot.target_per_group;
  const imbalance=totals.control>0&&totals.offer>0&&
    Math.max(totals.control,totals.offer)/Math.min(totals.control,totals.offer)>1.2;
  if(observations.length===0)record('COLLECT_OBSERVATIONS','high','Нет ни одного проверяемого периода.');
  else{
    if(!enough)record('RECRUIT_MORE_GUESTS','high',
      'Размеры групп: '+totals.control+' и '+totals.offer+'; целевой минимум: '+pilot.target_per_group+' каждая.');
    if(imbalance)record('CHECK_GROUP_BALANCE','high',
      'Объёмы групп отличаются более чем на 20%; сравнимость требует ручной проверки.');
    if(totals.controlReturn===0||totals.offerReturn===0)
      record('VERIFY_REPEAT_DEFINITION','medium','В одной из групп нет зафиксированных повторных визитов.');
    if(w>=8 && observations.length===1)
      record('VERIFY_PERIOD_COVERAGE','medium','В протоколе '+w+' календарных дней, но загружен один период.');
    if(totals.offerReturn/totals.offer<totals.controlReturn/totals.control)
      record('INVESTIGATE_GUEST_JOURNEY','medium','Наблюдаемая доля возвратов в группе предложения ниже контроля.');
  }
  if(s?.allocation!=='random')record('VERIFY_GROUP_ASSIGNMENT','high',
    'Распределение не подтверждено как случайное. Различия могут отражать исходный состав групп.');
  if(s?.source==='manual')record('VALIDATE_SOURCE','medium',
    'Источник зарегистрирован как ручной подсчёт. Нужно независимое подтверждение первичных агрегатов.');
  if(retrospective)record('REGISTER_FUTURE_PROTOCOL','high',
    'Протокол зарегистрирован после начала периода; предрегистрация отсутствует.');
  if(enough&&observations.length>0)
    record('REVIEW_CONTROLLED_FOLLOWUP','low',
      'Плановый объём групп достигнут. Это не подтверждает причинность и не доказывает прибыль.');
  const ordered=recommendations.sort((a,b)=>{
    const rank={high:0,medium:1,low:2};
    return rank[a.severity]-rank[b.severity]||a.code.localeCompare(b.code);
  });
  return {
    schema:DIAGNOSTIC_SCHEMA,
    phase:pilot.phase,observedPeriods:observations.length,
    sample:{minimumPerGroup:pilot.target_per_group,control:totals.control,offer:totals.offer,
      enough,balanceRatio:totals.control&&totals.offer?
        round(Math.max(totals.control,totals.offer)/Math.min(totals.control,totals.offer)):null},
    rates:{controlPct:totals.control?round(totals.controlReturn/totals.control*100):null,
      offerPct:totals.offer?round(totals.offerReturn/totals.offer*100):null,
      differencePp:totals.control&&totals.offer?
        round((totals.offerReturn/totals.offer-totals.controlReturn/totals.control)*100):null},
    protocol:{registeredBeforeStart:s?(!retrospective&&!!pilot.protocol_registered_at):null,
      source:s?.source||null,allocation:s?.allocation||null,start:windowStart,end:windowEnd,
      outcomeWindowDays:s?.outcomeWindowDays||null,
      outcomeWindowCompleted:s?Number(now)>=msDay(windowEnd)+Number(s.outcomeWindowDays)*86400000:null},
    findingCount:ordered.length,recommendations:ordered,
    disposition:observations.length===0?'NO_DATA':enough?'REVIEW_RECOMMENDED':'INSUFFICIENT_SAMPLE',
    disclaimer:'Сигналы основаны только на агрегатах и правилах качества. Это не поиск доказанных причин, не диагноз бизнесу, не расчёт реальной выручки.'
  };
}
