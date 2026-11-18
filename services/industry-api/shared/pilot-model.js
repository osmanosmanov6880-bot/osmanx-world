/**
 * OSMANX Guest Intelligence R3 — deterministic, privacy-first pilot operations.
 * Only aggregated counts, booleans and protocol parameters. No browser storage or API calls.
 * Power estimates are planning approximations; interim results are descriptive.
 */
import {count, money, cohort, economics, csv} from './experiment-model.js';

export const R3_SCHEMA = 'osmanx.guest.pilot.v1';
export const READINESS_KEYS = Object.freeze([
  'repeatDefinition','sameWindow','independentGroups','marginVerified','contactConsent','ownerAgreed'
]);
export const WEEK_KEYS = Object.freeze(['date','control','controlReturn','offer','offerReturn']);
export const PLAN_KEYS = Object.freeze(['baselinePct','liftPp','margin','discount','fixed','fee']);
export const MAX_WEEKS = 12;
const fail = message => { throw new RangeError(message); };
const only = (object, keys, name) => {
  if (!object || typeof object!=='object' || Array.isArray(object)) fail(name+': требуется объект');
  if (Object.keys(object).sort().join('|') !== [...keys].sort().join('|')) fail(name+': непредусмотренные или отсутствующие поля');
};
const bool = (v,name) => {
  if (typeof v!=='boolean') fail(name+': требуется да/нет');
  return v;
};
const number = (v,name,min,max) => {
  const raw=String(v ?? '').trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(raw)) fail(name+': нужно число с максимум двумя знаками после точки');
  const n=Number(raw);
  if (!Number.isFinite(n) || n<min || n>max) fail(name+': допустимое значение от '+min+' до '+max);
  return n;
};
const date = (raw,name) => {
  if (typeof raw!=='string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(raw)) fail(name+': формат ГГГГ-ММ-ДД');
  const y=Number(raw.slice(0,4)),m=Number(raw.slice(5,7)),d=Number(raw.slice(8,10));
  const ms=Date.UTC(y,m-1,d);
  if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==raw)fail(name+': несуществующая дата');
  return ms;
};

/** 1. Client readiness — blocked claims are displayed rather than inferred. */
export function readiness(value){
  only(value,READINESS_KEYS,'Проверка готовности');
  const checked=Object.fromEntries(READINESS_KEYS.map(k=>[k,bool(value[k],k)]));
  const labels={
    repeatDefinition:'Определение повторного визита ещё не согласовано.',
    sameWindow:'Нет сопоставимого окна наблюдения у обеих групп.',
    independentGroups:'Не подтверждена независимость групп (возможны пересечения гостей).',
    marginVerified:'Не подтверждена маржа после переменных затрат и скидок.',
    contactConsent:'Нет подтверждения законности использования данных и согласий на коммуникации.',
    ownerAgreed:'Не согласованы ответственный, сроки и критерий завершения пилота.'
  };
  const blocking=READINESS_KEYS.filter(k=>!checked[k]).map(k=>labels[k]);
  return {checked,passed:READINESS_KEYS.length-blocking.length,total:READINESS_KEYS.length,blocking,ready:blocking.length===0};
}

/** 2. Approximate two-sided independent-proportions sample-size planning. */
export function planSampleSize(baselinePct,liftPp){
  const baseline=number(baselinePct,'Базовый возврат, %',1,98)/100;
  const lift=number(liftPp,'Минимальная разница, п.п.',0.5,50)/100;
  const target=baseline+lift;
  if(target>=1)fail('Ожидаемая доля с предложением должна быть меньше 100%.');
  const alphaZ=1.95996398454, powerZ=0.84162123357, midpoint=(baseline+target)/2;
  const numerator=alphaZ*Math.sqrt(2*midpoint*(1-midpoint))
    + powerZ*Math.sqrt(baseline*(1-baseline)+target*(1-target));
  const perGroup=Math.ceil((numerator*numerator)/(lift*lift));
  if (!Number.isSafeInteger(perGroup)||perGroup>10000000)fail('Для такой разницы оценка выборки чрезмерна.');
  return {baseline,target,lift,perGroup,total:perGroup*2,alpha:0.05,power:0.8,
    method:'Приближение для двух независимых пропорций, двусторонний α=0,05, мощность около 80%; не гарантия.', 
    warning:'Предполагает независимые группы, один заранее объявленный показатель и одну окончательную проверку. Нет поправки на кластеры, пересечения и многократный анализ.'};
}

/** 3. Strict weekly aggregate ledger, disallowing duplicates and row ambiguity. */
export function weeklyLedger(rows){
  if(!Array.isArray(rows)||rows.length<1||rows.length>MAX_WEEKS)fail('Нужно от 1 до '+MAX_WEEKS+' периодов.');
  const used=new Set();
  const weeks=rows.map((raw,i)=>{
    only(raw,WEEK_KEYS,'Период '+(i+1));
    const ms=date(raw.date,'Дата периода '+(i+1));
    if (used.has(raw.date))fail('Дата периода повторяется: '+raw.date);
    used.add(raw.date);
    const control=count(raw.control,'Контроль',{positive:true});
    const controlReturn=count(raw.controlReturn,'Вернулось в контроле');
    const offer=count(raw.offer,'Предложение',{positive:true});
    const offerReturn=count(raw.offerReturn,'Вернулось с предложением');
    if(controlReturn>control||offerReturn>offer)fail('Возвраты превышают размер группы в периоде '+raw.date);
    return {date:raw.date,_ms:ms,control,controlReturn,offer,offerReturn,
      controlRate:controlReturn/control,offerRate:offerReturn/offer,
      difference:offerReturn/offer-controlReturn/control};
  }).sort((a,b)=>a._ms-b._ms);
  const aggregate=weeks.reduce((acc,w)=>{
    for(const k of ['control','controlReturn','offer','offerReturn'])acc[k]+=w[k];
    return acc;
  },{control:0,controlReturn:0,offer:0,offerReturn:0});
  // Do not average weekly percentages: use weighted totals.
  const c=cohort(aggregate);
  return {weeks:weeks.map(({_ms,...rest})=>rest),aggregate,c,
    warning:'Недельные цифры должны относиться к непересекающимся когортам. Если один гость учитывается в нескольких неделях, суммарная доля не является оценкой по уникальным гостям.'};
}

/** 4. Precommitted interpretation: progress is NEVER an automatic claim of verified lift. */
export function decision(input){
  const {ledger,readinessResult,minimumPerGroup,finalized,margin,discount,fixed,fee}=input;
  if(typeof finalized!=='boolean')fail('Статус завершения должен быть да/нет.');
  const required=count(minimumPerGroup,'Целевой размер группы',{positive:true});
  const financial=economics({margin,discount,fixed,fee},ledger.c);
  const enough=ledger.aggregate.control>=required&&ledger.aggregate.offer>=required;
  const warnings=[ledger.warning,...readinessResult.blocking];
  if(!finalized)warnings.push('Данные промежуточные: нельзя делать окончательный вывод после просмотра нескольких периодов.');
  if(!enough)warnings.push('Не достигнут заранее рассчитанный объём групп.');
  if(ledger.c.uncertain)warnings.push('95%-й интервал включает ноль: наблюдаемое отличие неубедительно.');
  if(ledger.c.small)warnings.push('Редкие исходы или малая выборка: оценка нестабильна.');
  if(ledger.weeks.length>1)warnings.push('Последовательный просмотр и повторные проверки увеличивают вероятность ложноположительного результата.');
  let status='ПРОМЕЖУТОЧНО';
  if(finalized){
    status=readinessResult.ready&&enough ? 'ГОТОВО К ЭКСПЕРТНОМУ РАЗБОРУ' : 'НЕДОСТАТОЧНО ОСНОВАНИЙ';
  }
  return {status,financial,enough,required,finalized,warnings,associationOnly:true};
}

/** 4. Printable/shareable owner report, based only on validated aggregated data. */
export function ownerReport(bundle){
  const {inputs,ledger,readinessResult,sample,assessment}=bundle;
  const pp=n=>(n*100).toFixed(2)+' п.п.';
  const rub=n=>n.toFixed(2)+' ₽';
  return [
    'OSMANX GUEST INTELLIGENCE — ОТЧЁТ ДЛЯ ВЛАДЕЛЬЦА',
    'Статус: '+assessment.status+'.',
    'Это сценарий по агрегированным данным, не подтверждение выручки или причинного эффекта.',
    'Проверка готовности: '+readinessResult.passed+' из '+readinessResult.total+'.',
    'План: исходный возврат '+(sample.baseline*100).toFixed(2)+'%, минимальная ожидаемая разница '+pp(sample.lift)+'.',
    'Рекомендуемая оценка выборки: '+sample.perGroup+' человек на группу (80% мощность, α=0,05).',
    'Учтено '+ledger.weeks.length+' периодов: контроль '+ledger.aggregate.controlReturn+'/'+ledger.aggregate.control+
      ', предложение '+ledger.aggregate.offerReturn+'/'+ledger.aggregate.offer+'.',
    'Наблюдаемая разница: '+pp(ledger.c.difference)+'. Ориентировочный интервал: '+
      pp(ledger.c.range[0])+' — '+pp(ledger.c.range[1])+'.',
    'Сценарный результат: '+rub(assessment.financial.net)+
      '. Сценарный диапазон: '+rub(assessment.financial.rangeNet[0])+' — '+rub(assessment.financial.rangeNet[1])+'.',
    'Расходы: '+rub(assessment.financial.costs)+'. Данные не подтверждены платёжной системой.',
    'Периоды:',
    ...ledger.weeks.map(w=>w.date+': '+w.controlReturn+'/'+w.control+' vs '+w.offerReturn+'/'+w.offer),
    'ОГРАНИЧЕНИЯ:',
    ...assessment.warnings.map(w=>'- '+w),
    'Решение и продление принимаются только после согласования с владельцем и проверки первичных данных.',
    'НЕТ ГАРАНТИРОВАННОЙ ПРИБЫЛИ, АВТОМАТИЧЕСКОЙ ОПЛАТЫ ИЛИ АКТИВАЦИИ ПОДПИСКИ.'
  ].join('\n');
}

/** 5. Repeatable privacy-checked JSON artifact. Never include customer names or contacts. */
export function createBundle(input){
  only(input,['plan','readiness','rows','finalized'],'Пакет');
  only(input.plan,PLAN_KEYS,'План');
  const plan={
    baselinePct:number(input.plan.baselinePct,'Базовая доля',1,98),
    liftPp:number(input.plan.liftPp,'Ожидаемая разница',0.5,50),
    margin:money(input.plan.margin,'Маржа'),
    discount:money(input.plan.discount,'Расход на предложение'),
    fixed:money(input.plan.fixed,'Прочие затраты'),
    fee:money(input.plan.fee,'Цена услуги')
  };
  planSampleSize(plan.baselinePct,plan.liftPp);
  const checked=readiness(input.readiness).checked;
  const ledger=weeklyLedger(input.rows);
  if(typeof input.finalized!=='boolean')fail('Окончательный статус: требуется да/нет');
  return {schema:R3_SCHEMA,plan,readiness:checked,rows:ledger.weeks.map(w=>Object.fromEntries(WEEK_KEYS.map(k=>[k,w[k]]))),finalized:input.finalized};
}
export function readBundle(raw){
  if(typeof raw!=='string'||raw.length>32768)fail('Файл должен быть JSON размером до 32 КБ');
  let parsed;try{parsed=JSON.parse(raw)}catch{fail('Повреждённый JSON');}
  only(parsed,['schema','plan','readiness','rows','finalized'],'Файл');
  if(parsed.schema!==R3_SCHEMA)fail('Неподдерживаемая версия JSON');
  return createBundle({plan:parsed.plan,readiness:parsed.readiness,rows:parsed.rows,finalized:parsed.finalized});
}
export function evaluate(bundle){
  const data=createBundle(bundle);
  const sample=planSampleSize(data.plan.baselinePct,data.plan.liftPp);
  const readinessResult=readiness(data.readiness);
  const ledger=weeklyLedger(data.rows);
  const assessment=decision({
    ledger,readinessResult,minimumPerGroup:sample.perGroup,finalized:data.finalized,
    margin:data.plan.margin,discount:data.plan.discount,fixed:data.plan.fixed,fee:data.plan.fee
  });
  return {data,sample,readinessResult,ledger,assessment,report:ownerReport({inputs:data.plan,ledger,readinessResult,sample,assessment})};
}
export function reportCsv(result){
  const {data,ledger,assessment}=result;
  return csv([
    ['OSMANX R3','Демонстрация/анализ, не подтверждённый результат'],
    ['Период','Контроль','Вернулось контроль','Предложение','Вернулось предложение','Разница долей'],
    ...ledger.weeks.map(w=>[w.date,w.control,w.controlReturn,w.offer,w.offerReturn,w.difference]),
    ['Итого',ledger.aggregate.control,ledger.aggregate.controlReturn,ledger.aggregate.offer,ledger.aggregate.offerReturn,ledger.c.difference],
    ['Финансовый сценарий (₽)',assessment.financial.net],
    ['Предупреждение','Не подтверждает причину возвратов, выручку и оплату'],
    ['Предварительные данные',!data.finalized?'Да':'Нет']
  ]);
}
