/* Shared public quest catalogue. Plans are not claims of completed work. */
(function (root) {
  'use strict';
  const tasks = [
    ['Проведи 3 содержательных диалога с ЛПР', 'Найди потенциального партнёра для коллаборации', 'Протестируй 2 скрипта переговоров', 'Зафиксируй 5 инсайтов по сегменту дня', 'Сформулируй гипотезу на завтра'],
    ['Собери 3 причины отказа', 'Найди общий запрос независимых проектов', 'Проверь новое начало разговора', 'Сравни наблюдения с первым днём', 'Уточни гипотезу следующего дня'],
    ['Проведи 3 интервью о процессах', 'Найди отраслевого партнёра', 'Проверь предложение для HoReCa', 'Зафиксируй 5 наблюдений', 'Согласуй следующий шаг'],
    ['Обсуди задачу с руководителем', 'Найди точку для совместного пилота', 'Проверь 2 коммерческие гипотезы', 'Зафиксируй ограничения решения', 'Подготовь предложение по итогам'],
    ['Разбери экономику одного запроса', 'Найди партнёра в розничной торговле', 'Проверь ценностное предложение', 'Запиши 5 причин выбора решения', 'Уточни бюджет и критерии пилота'],
    ['Проведи интервью о действующем процессе', 'Найди интеграционного партнёра', 'Сравни 2 варианта решения', 'Запиши ограничения текущих систем', 'Подготовь план проверки'],
    ['Согласуй измеримую цель пилота', 'Найди ответственного за результат', 'Определи критерии успешного теста', 'Запиши исходные показатели', 'Согласуй дату следующей встречи'],
    ['Проведи 3 встречи с авторами проектов', 'Найди партнёра для общей истории', 'Проверь формат интервью', 'Согласуй разрешение на публикацию', 'Подготовь итог дня'],
    ['Проведи итоговые переговоры', 'Сверь договорённости с партнёрами', 'Проверь список следующих шагов', 'Запиши нерешённые вопросы', 'Подготовь финальную сводку'],
    ['Сверь все подтверждённые результаты', 'Согласуй продолжение сотрудничества', 'Сравни гипотезы с наблюдениями', 'Зафиксируй ограничения исследования', 'Составь план следующих 30 дней']
  ];
  const weights = [150, 200, 100, 100, 150];
  const icons = ['link', 'partner', 'target', 'idea', 'flag'];
  function quests(day) {
    const n = Math.max(1, Math.min(10, Math.trunc(Number(day)) || 1));
    return tasks[n - 1].map((title, i) => ({id: `d${n}-q${i+1}`, day:n, title, xp:weights[i], icon:icons[i], description:'Выполнение отмечает автор экспедиции. Зрителям доступен подтверждённый результат.'}));
  }
  function validMetrics(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const allowed = ['researched','visits','dialogues','contacts','decisionMeetings','meetings','proposals','pilots','contracts','expensesRub','questsCompleted','xp'];
    const out = {};
    for (const key of allowed) {
      const n = value[key];
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100000000 && (key === 'expensesRub' || Number.isSafeInteger(n))) out[key] = n;
    }
    return Object.keys(out).length ? out : null;
  }
  function readSnapshot(value) {
    if (!value || value.status !== 'published' || typeof value.reviewedAt !== 'string' || !Number.isFinite(Date.parse(value.reviewedAt))) return null;
    return {
      status:'published', reviewedAt:value.reviewedAt, version: Number.isSafeInteger(value.version) ? value.version : null,
      metrics:validMetrics(value.metrics),
      days: Array.isArray(value.days) ? value.days.filter(d => d && Number.isInteger(d.day) && d.day >= 1 && d.day <= 10).map(d => ({day:d.day, metrics:validMetrics(d.metrics), summary: typeof d.summary === 'string' ? d.summary.slice(0,500) : '', lesson:typeof d.lesson === 'string' ? d.lesson.slice(0,350) : ''})) : [],
      quests: Array.isArray(value.quests) ? value.quests.filter(q => q && q.completed === true && Number.isInteger(q.day) && q.day >= 1 && q.day <= 10 && new RegExp('^d'+q.day+'-q[1-5]$').test(q.questId)).map(q=>({day:q.day,questId:q.questId,completed:true})) : [],
    };
  }
  root.OSMANXCommandData = Object.freeze({quests, validMetrics, readSnapshot});
})(typeof window === 'undefined' ? globalThis : window);
