// OSMANX Guest Intelligence. Pure functions: no personal data, network or persistence.
// Scenario calculations do not establish causality or guarantee financial outcomes.
export const SCHEMA = 'osmanx.guest.experiment.v1';
export const INPUT_KEYS = Object.freeze(['control','controlReturn','offer','offerReturn','margin','discount','fixed','fee']);

export function count(value, name, {positive=false}={}) {
  const raw = String(value ?? '').trim();
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new RangeError(name + ': укажите целое неотрицательное число');
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n > 10000000 || (positive && n < 1)) {
    throw new RangeError(name + ': допустимо от ' + (positive ? 1 : 0) + ' до 10 000 000');
  }
  return n;
}
export function money(value, name) {
  const raw = String(value ?? '').trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(raw)) {
    throw new RangeError(name + ': укажите рубли и не более двух знаков после точки');
  }
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount > 100000000) throw new RangeError(name + ': максимум 100 млн ₽');
  return Math.round(amount * 100) / 100;
}
export function cohort(input) {
  const control = count(input.control, 'Группа сравнения', {positive:true});
  const controlReturn = count(input.controlReturn, 'Возвраты в группе сравнения');
  const offer = count(input.offer, 'Группа с предложением', {positive:true});
  const offerReturn = count(input.offerReturn, 'Возвраты с предложением');
  if (controlReturn > control || offerReturn > offer) throw new RangeError('Число возвратов не может превышать размер группы');
  const controlRate=controlReturn/control;
  const offerRate=offerReturn/offer;
  const difference=offerRate-controlRate;
  // Newcombe-Wilson score interval for difference of independent proportions.
  // Approximate: does not account for clustering, matching or nonrandom assignment.
  const wilson=(x,n)=>{
    const p=x/n, z=1.959963984540054, z2=z*z, denom=1+z2/n;
    const center=(p+z2/(2*n))/denom;
    const half=z*Math.sqrt(p*(1-p)/n+z2/(4*n*n))/denom;
    return [Math.max(0,center-half),Math.min(1,center+half)];
  };
  const [al,ah]=wilson(controlReturn,control);
  const [bl,bh]=wilson(offerReturn,offer);
  const lower=Math.max(-1,difference-Math.hypot(offerRate-bl,ah-controlRate));
  const upper=Math.min(1,difference+Math.hypot(bh-offerRate,controlRate-al));
  const small=control < 30 || offer < 30 || Math.min(controlReturn,control-controlReturn,offerReturn,offer-offerReturn)<5;
  return {controlSize:control,controlReturn,offerSize:offer,offerReturn,controlRate,offerRate,difference,
    range:[lower,upper],uncertain:lower<=0&&upper>=0,small};
}
export function economics(input, result) {
  const margin=money(input.margin,'Маржа дополнительного визита');
  const discount=money(input.discount,'Стоимость предложения на гостя');
  const fixed=money(input.fixed,'Прочие расходы');
  const fee=money(input.fee,'Стоимость услуги');
  const costs=result.offerSize*discount+fixed+fee;
  const incrementalVisits=result.difference*result.offerSize;
  const net=incrementalVisits*margin-costs;
  const lower=result.range[0]*result.offerSize*margin-costs;
  const upper=result.range[1]*result.offerSize*margin-costs;
  const breakEven=margin>0?Math.ceil((costs*100)/(margin*100)):null;
  return {margin,discount,fixed,fee,costs,incrementalVisits,net,rangeNet:[lower,upper],breakEven,
    assumption:'Сценарий, не причинная оценка. Стоимость предложения берётся на всю группу с предложением.'};
}
function dateToUtc(raw, name) {
  if (typeof raw!=='string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(raw)) throw new RangeError(name+': укажите дату в формате ГГГГ-ММ-ДД');
  const [year,month,day]=raw.split('-').map(Number);
  const ms=Date.UTC(year,month-1,day);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10)!==raw) throw new RangeError(name+': дата не существует');
  return ms;
}
export function protocol(input) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw new RangeError('Протокол пилота не заполнен');
  const startDate=String(input.startDate??'');
  const endDate=String(input.endDate??'');
  const allocation=String(input.allocation??'unknown');
  const outcomeWindowDays=count(input.outcomeWindowDays??30,'Окно возврата',{positive:true});
  if (outcomeWindowDays>90) throw new RangeError('Окно возврата не может превышать 90 дней');
  const start=dateToUtc(startDate,'Начало');
  const end=dateToUtc(endDate,'Окончание');
  const days=(end-start)/86400000+1;
  if (days<1 || days>90) throw new RangeError('Период наблюдения должен быть от 1 до 90 календарных дней');
  if (!['random','matched','unknown'].includes(allocation)) throw new RangeError('Неизвестный способ формирования групп');
  return {startDate,endDate,allocation,outcomeWindowDays,days,randomized:allocation==='random'};
}
export function riskFlags(cohortResult, protocolResult) {
  const flags=[];
  if (cohortResult.small) flags.push('Малая выборка или редкие исходы: результат особенно нестабилен.');
  if (cohortResult.uncertain) flags.push('Интервал включает ноль: положительный эффект не подтверждён даже приблизительным интервалом.');
  if (!protocolResult.randomized) flags.push('Группы не заявлены как случайно распределённые: возможны систематические различия.');
  flags.push('Интервал не учитывает разные дни, пересечения гостей, кластеризацию и множественные проверки.');
  return flags;
}
export function createSnapshot(inputs, protocolInput) {
  const cleanInputs={};
  for (const key of INPUT_KEYS) {
    if (!(key in inputs)) throw new RangeError('Отсутствует параметр '+key);
    cleanInputs[key]=String(inputs[key]);
  }
  const c=cohort(cleanInputs);
  economics(cleanInputs,c);
  const p=protocol(protocolInput);
  return {schema:SCHEMA,inputs:cleanInputs,protocol:{startDate:p.startDate,endDate:p.endDate,allocation:p.allocation,outcomeWindowDays:p.outcomeWindowDays}};
}
export function readSnapshot(text) {
  if (typeof text!=='string' || text.length>16384) throw new RangeError('Файл должен быть JSON не более 16 КБ');
  let data;
  try {data=JSON.parse(text);} catch {throw new RangeError('Не удалось прочитать JSON');}
  if (!data || typeof data!=='object' || Array.isArray(data) || data.schema!==SCHEMA ||
      !data.inputs || !data.protocol || typeof data.inputs!=='object' || typeof data.protocol!=='object') {
    throw new RangeError('Неверная версия или структура сценария');
  }
  if (Object.keys(data).sort().join(',')!=='inputs,protocol,schema') throw new RangeError('Файл содержит лишние поля');
  if (Object.keys(data.inputs).sort().join(',')!==[...INPUT_KEYS].sort().join(',')) throw new RangeError('Неверные поля сценария');
  if (Object.keys(data.protocol).sort().join(',')!=='allocation,endDate,outcomeWindowDays,startDate') throw new RangeError('Неверные поля протокола');
  return createSnapshot(data.inputs,data.protocol);
}
export function pilotBrief(snapshot) {
  const c=cohort(snapshot.inputs),e=economics(snapshot.inputs,c),p=protocol(snapshot.protocol);
  const allocation={random:'случайное',matched:'сопоставление',unknown:'не определено'}[p.allocation];
  return [
    'OSMANX GUEST INTELLIGENCE — ПАСПОРТ ПИЛОТА (ЧЕРНОВИК)',
    'Период: '+p.startDate+' — '+p.endDate+' ('+p.days+' дней).',
    'Метрика: повторный визит в течение '+p.outcomeWindowDays+' дней.',
    'Группы: '+allocation+'. Требуется независимая проверка сопоставимости и пересечений.',
    'Контроль: '+c.controlReturn+' / '+c.controlSize+'; предложение: '+c.offerReturn+' / '+c.offerSize+'.',
    'Разница долей: '+(100*c.difference).toFixed(2)+' п.п. Приблизительный интервал: '+(100*c.range[0]).toFixed(2)+' — '+(100*c.range[1]).toFixed(2)+' п.п.',
    'Сценарный итог: '+e.net.toFixed(2)+' ₽; диапазон при заданной модели: '+e.rangeNet.map(v=>v.toFixed(2)).join(' — ')+' ₽.',
    'Прежде чем запускать: согласовать цель, разделение групп, окно наблюдения, затраты, источник агрегированных данных, согласия и критерий завершения.',
    ...riskFlags(c,p).map(flag=>'Ограничение: '+flag),
    'НЕ ЯВЛЯЕТСЯ ДОКАЗАТЕЛЬСТВОМ ПРИЧИННОГО ЭФФЕКТА ИЛИ ГАРАНТИЕЙ ПРИБЫЛИ.'
  ].join('\n');
}
export function csv(rows) {
  if (!Array.isArray(rows) || rows.some(row=>!Array.isArray(row))) throw new TypeError('CSV: ожидается таблица');
  const cell=value=>{
    const raw=String(value??'');
    // Protect spreadsheet users even when an injection starts after whitespace.
    const safe=/^[\s\u200b\ufeff]*[=+\-@]/u.test(raw) || /^[\r\n\t]/u.test(raw) ? "'"+raw : raw;
    return '"'+safe.replaceAll('"','""')+'"';
  };
  return '\uFEFF'+rows.map(row=>row.map(cell).join(';')).join('\r\n')+'\r\n';
}
