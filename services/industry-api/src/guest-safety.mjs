// R13 deterministic guardrails for aggregate-only Guest pilots.
// These are operational screening rules, NOT evidence of misconduct or causality.
import {createHash} from 'node:crypto';

export const QUALITY_SCHEMA='osmanx.guest.quality.v1';
export const SAFETY_EXPORT='osmanx.guest.safety.export.v1';
export const REASONS=Object.freeze([
  'source_integrity','consent_review','data_quality','operational_incident'
]);
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const millis=value=>Date.parse(String(value));
const severityOrder={high:0,medium:1,low:2};
const LABELS={
  NO_OBSERVATIONS:['medium','Пока нет ни одного агрегированного периода.','Проверьте источник данных и график измерений.'],
  INVALID_COUNTS:['high','Количество возвратов превышает размер группы либо запись некорректна.','Приостановите сбор, проверьте выгрузку и используйте только исправленные агрегаты.'],
  DUPLICATE_DAY:['high','Есть повторяющиеся даты наблюдений.','Проверьте дубли и устраните их через контролируемый отзыв записи.'],
  OUT_OF_PROTOCOL:['high','Наблюдение оказалось за границами заранее зафиксированного периода.','Проверьте источник и протокол, не выдавайте эти записи за подтверждённые.'],
  LATE_REGISTRATION:['high','Протокол был зарегистрирован после начала исследования.','Отметьте ретроспективный риск и рассмотрите новую проспективную проверку.'],
  GROUP_IMBALANCE:['medium','Размеры контрольной и тестовой групп различаются более чем в полтора раза.','Проверьте распределение, покрытие смен и независимость групп.'],
  INSUFFICIENT_SAMPLE:['medium','Размер хотя бы одной группы меньше заранее рассчитанного минимума.','Сравните накопленный размер группы с протоколом до интерпретации результата.'],
  RATE_SWING:['medium','Доля повторных визитов резко изменилась между соседними периодами.','Проверьте периоды, праздники, пересечение гостей и изменения источника.'],
  PERIOD_GAP:['low','Между наблюдаемыми периодами есть перерыв более семи суток.','Проверьте полноту выгрузок и не объединяйте несопоставимые недели без оговорок.'],
  MANUAL_SOURCE:['medium','Ручной подсчёт требует отдельной проверки качества данных.','Проведите независимую сверку методики и выборки.']
};
function signal(code,detail){
  const [severity,title,nextStep]=LABELS[code];
  return {code,severity,title,detail,nextStep};
}
export function assessGuestQuality(pilot,observations,{now=new Date()}={}){
  if(!pilot||!Array.isArray(observations)||observations.length>12||!(now instanceof Date)||
     !Number.isFinite(now.getTime()))throw new TypeError('Invalid quality assessment');
  const rows=observations.map(item=>({
    date:String(item.date),control:Number(item.control),
    controlReturn:Number(item.controlReturn),offer:Number(item.offer),
    offerReturn:Number(item.offerReturn)
  })).sort((a,b)=>a.date.localeCompare(b.date));
  const flags=[];
  const add=(code,detail)=>{if(!flags.some(item=>item.code===code))flags.push(signal(code,detail))};
  if(rows.length===0)add('NO_OBSERVATIONS','Активных периодов: 0.');
  const seen=new Set();
  let ct=0,ot=0;
  for(let i=0;i<rows.length;i++){
    const r=rows[i];
    if(seen.has(r.date))add('DUPLICATE_DAY','Дата '+r.date+' встречается более одного раза.');
    seen.add(r.date);
    if(![r.control,r.controlReturn,r.offer,r.offerReturn].every(
      n=>Number.isSafeInteger(n)&&n>=0)||
      r.control<1||r.offer<1||r.controlReturn>r.control||r.offerReturn>r.offer)
      add('INVALID_COUNTS','Период '+r.date+' не соответствует допустимым агрегированным значениям.');
    if(pilot.protocol&&(r.date<pilot.protocol.startDate||r.date>pilot.protocol.endDate))
      add('OUT_OF_PROTOCOL','Дата '+r.date+' не входит в заявленный протокол.');
    ct+=r.control;ot+=r.offer;
    if(i>0){
      const prev=rows[i-1];
      const gap=(millis(r.date+'T00:00:00Z')-millis(prev.date+'T00:00:00Z'))/86400000;
      if(Number.isFinite(gap)&&gap>7)add('PERIOD_GAP','Перерыв '+gap+' дней.');
      const rates=[r.controlReturn/r.control,prev.controlReturn/prev.control,
        r.offerReturn/r.offer,prev.offerReturn/prev.offer];
      if(rates.every(Number.isFinite) &&
         (Math.abs(rates[0]-rates[1])>0.30||Math.abs(rates[2]-rates[3])>0.30))
        add('RATE_SWING','Изменение более 30 процентных пунктов между периодами.');
    }
  }
  const reg=millis(pilot.protocol_registered_at);
  if(pilot.protocol&&Number.isFinite(reg)&&
    reg>millis(pilot.protocol.startDate+'T00:00:00Z'))
    add('LATE_REGISTRATION','Регистрация протокола произошла после начала периода.');
  if(pilot.protocol?.source==='manual')add('MANUAL_SOURCE','Источник обозначен как manual.');
  if(ct>0&&ot>0){
    const ratio=Math.max(ct,ot)/Math.min(ct,ot);
    if(ratio>1.5)add('GROUP_IMBALANCE','Соотношение размеров групп '+ratio.toFixed(2)+'.');
  }
  const target=Number(pilot.target_per_group);
  if(rows.length>0&&Number.isFinite(target)&&target>0&&(ct<target||ot<target))
    add('INSUFFICIENT_SAMPLE','Контроль '+ct+', предложение '+ot+', минимум '+target+' на группу.');
  flags.sort((a,b)=>severityOrder[a.severity]-severityOrder[b.severity]||
    a.code.localeCompare(b.code));
  return {
    schema:QUALITY_SCHEMA,assessedAt:now.toISOString(),
    pilotId:pilot.id,periods:rows.length,totals:{control:ct,offer:ot},
    flags,highestSeverity:flags[0]?.severity||'none',
    requiresHumanReview:flags.length>0,
    blocksAutomatically:false,
    disclaimer:'Это эвристические предупреждения об агрегатах, а не доказательство ошибки, причинного эффекта, потери прибыли или вины сотрудника. Активная остановка — отдельное решение.'
  };
}
export function buildSafetyExport({pilot,hold,events,quality,evidenceDigest}){
  if(!pilot||!quality||!/^([a-f0-9]{64})$/.test(String(evidenceDigest))||
    !Array.isArray(events)||events.length>100)
    throw new TypeError('Invalid safety bundle');
  const sorted=[...events].sort((a,b)=>Number(a.hold_version)-Number(b.hold_version));
  const snapshot={
    schema:'osmanx.guest.safety.snapshot.v1',
    pilotId:pilot.id,phase:pilot.phase,version:pilot.version,
    originalEvidenceSha256:evidenceDigest,
    hold:hold||null,holdEvents:sorted,quality
  };
  return {
    format:SAFETY_EXPORT,sha256:sha(snapshot),snapshot,
    disclaimer:'Контрольная сумма выявляет изменение файла, но не является цифровой подписью, разрешением на сбор данных или доказательством коммерческого результата.'
  };
}
