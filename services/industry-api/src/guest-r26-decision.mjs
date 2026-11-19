/**
 * R26 explainable next decision: source audit > bias review > test design.
 * This function never edits a pilot, invoices, schedules work or approves GO.
 */
import {R26_REVIEW_SCHEMA} from './guest-r26-review.mjs';
import {R26_BIAS_SCHEMA} from './guest-r26-bias.mjs';
export const R26_DECISION_SCHEMA='osmanx.guest.r26.owner-decision.v1';
const STEPS=Object.freeze({
  SAFETY_STOP:{priority:1,title:'Разобрать аварийную остановку',
    task:'Проверить причину STOP, источник и соблюдение прав субъектов данных.',
    evidence:'Журнал остановки, законное основание и независимое решение'},
  COLLECT_EVIDENCE:{priority:2,title:'Сверить доступные агрегаты',
    task:'Сначала получить минимальный проверяемый набор смен без персональных записей.',
    evidence:'Анонимные сменные суммы и сохранённый протокол'},
  SOURCE_AUDIT:{priority:3,title:'Завершить две внутренние проверки источника',
    task:'Владелец и управляющий должны отдельно проверить исходные суммы и приложить отпечатки доказательств.',
    evidence:'Два разных агрегатных контрольных документа с SHA-256'},
  EXTERNAL_AUDIT:{priority:4,title:'Независимо подтвердить первичный источник',
    task:'Внешний проверяющий должен удостоверить реальный метод подсчёта и правомерность источника.',
    evidence:'Отдельное внешнее заключение, не заменяемое внутренними кнопками'},
  SHIFT_REBALANCE:{priority:5,title:'Устранить возможный перекос сравнения',
    task:'Проанализировать состав смен, источников и нестабильность частот до нового теста.',
    evidence:'Сопоставимые смены, способ регистрации и независимая проверка'},
  EXPLORATORY_REVIEW:{priority:6,title:'Проверить главную рабочую гипотезу',
    task:'Обсудить возможный барьер и условия его опровержения.',
    evidence:'План проверки и ограничения статистической модели'},
  PROTOCOL_DESIGN:{priority:7,title:'Подготовить отдельный новый эксперимент',
    task:'Рассчитать мощность, предрегистрировать протокол и оформить согласования.',
    evidence:'Контрольная группа, мощность, окно результата, независимый аудит'}
});
export function chooseR26Decision({r25,review,bias,
  stopActive=false}={}){
  if(r25?.schema!=='osmanx.guest.r25.operational-brief.v1'||
    review?.schema!==R26_REVIEW_SCHEMA||bias?.schema!==R26_BIAS_SCHEMA)
    throw new TypeError('R26 requires signed-source-bound aggregate evidence');
  let code='PROTOCOL_DESIGN';
  if(stopActive||r25.emergencyStopActive)code='SAFETY_STOP';
  else if(bias.totalSampled===0)code='COLLECT_EVIDENCE';
  else if(!review.internalDeclarationsComplete)code='SOURCE_AUDIT';
  else if(bias.warnings.some(w=>[
    'SHIFT_COMPOSITION_CHANGED','SOURCE_COMPOSITION_CHANGED',
    'ONE_SHIFT_DOMINATES_SAMPLE','POSSIBLE_AGGREGATE_TREND_REVERSAL',
    'LEADER_UNSTABLE_LEAVE_ONE_DAY_OUT'
  ].includes(w)))code='SHIFT_REBALANCE';
  else if(r25.board.leadingHypothesis===null)code='EXPLORATORY_REVIEW';
  else code='EXTERNAL_AUDIT';
  const order=['SAFETY_STOP','COLLECT_EVIDENCE','SOURCE_AUDIT',
    'EXTERNAL_AUDIT','SHIFT_REBALANCE','EXPLORATORY_REVIEW',
    'PROTOCOL_DESIGN'];
  const reasons=[
    ...review.blockers.map(x=>'review_'+x),
    ...bias.warnings.map(x=>'bias_'+x),
    ...r25.nextExperiment.blockers.map(x=>'experiment_'+x)
  ];
  const candidate=STEPS[code];
  return {
    schema:R26_DECISION_SCHEMA,
    firstAction:{code,...candidate,status:'recommendation_only',
      requiresHumanOwner:true,created:false},
    downstream:order.filter(k=>k!==code).map(k=>({
      code:k,title:STEPS[k].title,requiresSeparateApproval:true
    })),
    reviewBlockers:reasons,
    readyForIndependentExternalAudit:!stopActive&&
      review.internalDeclarationsComplete&&bias.totalSampled>=10,
    experimentDraftAvailable:r25.nextExperiment.eligibleForHumanDesignReview,
    independentExternalAuditVerified:false,
    recordedClientAuthorization:false,
    actionAutomaticallyAssigned:false,
    hypothesisProven:false,causalEffectProven:false,
    experimentStarted:false,customerGo:false,
    productionAuthorized:false,
    disclaimer:'Приоритет задаёт проверяемое следующее действие. Ни внутренние подтверждения, ни обнаруженный перекос не доказывают причину потери гостей.'
  };
}
