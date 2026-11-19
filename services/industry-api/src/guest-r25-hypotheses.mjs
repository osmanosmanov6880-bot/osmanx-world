/**
 * R25 transparent falsifiable operational hypotheses from staff-coded
 * aggregate flags; NEVER inferred actual customer motives.
 */
import {R25_PROFILE_SCHEMA} from './guest-r25-signals.mjs';
export const R25_HYPOTHESIS_SCHEMA='osmanx.guest.r25.hypothesis-board.v1';
const CATALOG=Object.freeze({
  wait:{title:'Возможно, ожидание мешает покупке',
    test:'Сравнить одинаковые смены с предварительно объявленным быстрым приёмом заказа.',
    metric:'repeat_visit',guardrail:'Среднее время обслуживания и жалобы',
    verification:'Независимая проверка времени обслуживания и счётчика очереди'},
  stockout:{title:'Возможно, нужных позиций нет в наличии',
    test:'На одних сопоставимых сменах проверить пополнение самых частых отсутствующих позиций.',
    metric:'repeat_visit',guardrail:'Списание продукции и доступность ассортимента',
    verification:'Анонимная частота отсутствия позиций и журнал поставок'},
  ordering:{title:'Возможно, заказ слишком сложен',
    test:'Проверить упрощённый сценарий заказа, не меняя одновременно цены и ассортимент.',
    metric:'repeat_visit',guardrail:'Ошибки заказа, время и отмены',
    verification:'Сверка анонимных агрегатов ошибок заказа'},
  price:{title:'Возможно, условия и цены непонятны',
    test:'Сравнить ясное предварительное описание цены с обычной подачей.',
    metric:'repeat_visit',guardrail:'Средний чек и число отказов',
    verification:'Действовавшее меню/прайс и обезличенный счётчик отказов'},
  service:{title:'Возможно, качество общения требует проверки',
    test:'Проверить стандарт обслуживания в одной группе смен и сравнить с неизменным процессом.',
    metric:'repeat_visit',guardrail:'Время обслуживания, жалобы и загрузка команды',
    verification:'Независимая оценка стандарта и анонимные метрики качества'}
});
export function deriveR25Hypotheses(profile){
  if(profile?.schema!==R25_PROFILE_SCHEMA)
    throw new TypeError('R25 hypotheses require verified aggregate profile');
  const observed=profile.totalSampled;
  const canRank=observed>=30;
  const sourceWeak=profile.warningCodes.includes('STAFF_ESTIMATE_NOT_GUEST_REPORTED');
  const unknownHigh=profile.warningCodes.includes('LARGE_UNKNOWN_SHARE');
  const entries=Object.entries(CATALOG).map(([code,ref])=>{
    const data=profile.categoryShares[code];
    const count=data.observed,share=data.sharePct??0;
    const adequate=canRank&&count>=5;
    const score=adequate?Math.round(share*10)/10:0;
    return {code,...ref,observed:count,sharePct:share,
      approximate95Pct:data.approximate95Pct,
      signalAvailable:adequate,
      priorityScore:score,
      confidence:!adequate?'INSUFFICIENT':
        sourceWeak||unknownHigh?'LOW':'REQUIRES_INDEPENDENT_SOURCE',
      proofBeforeTesting:[
        'independent_source_validation',
        'no_overlapping_guest_cohorts',
        'registered_new_protocol',
        'documented_consent_and_retention'
      ],causalExplanation:false};
  });
  entries.sort((a,b)=>b.priorityScore-a.priorityScore||
    b.observed-a.observed||a.code.localeCompare(b.code));
  const leading=entries.filter(x=>x.signalAvailable&&x.sharePct>=10).slice(0,3);
  const warnings=[...new Set([
    ...profile.warningCodes,
    'HYPOTHESES_NOT_CONFIRMED_CAUSES',
    ...(sourceWeak?['STAFF_ASSESSMENT_REQUIRES_VALIDATION']:[])
  ])];
  return {schema:R25_HYPOTHESIS_SCHEMA,
    hypotheses:entries,
    prioritized:leading.map(x=>x.code),
    leadingHypothesis:leading[0]?.code||null,
    warnings,automaticActionCreated:false,
    humanReviewRequired:true,
    observedMotivesEstablished:false,
    causalExplanationProven:false,
    customerGo:false,
    explanation:'Ранжирование основано на доле кодов, поставленных сотрудниками или анонимным счётчиком. Эти сигналы НЕ показывают, почему конкретный человек ушёл и не доказывают влияние на повторные визиты.'
  };
}
