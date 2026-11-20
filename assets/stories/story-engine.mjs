/**
 * OSMANX CINEMA R2 — проверяемые сценарии, без искусственных метрик и аналитических обещаний.
 * Чистый модуль: не использует DOM, сеть, cookies и локальное хранилище.
 */
export const CHAPTERS = Object.freeze([
  { at: 0, label: 'I · Сигнал', description: 'Клиент хочет получить услугу, но контакт ещё не стал продажей.' },
  { at: 12, label: 'II · Потеря', description: 'Спрос, время или внимание исчезают без записи о причине.' },
  { at: 24, label: 'III · Последствия', description: 'Пустые места и незавершённые заявки не объясняют себя.' },
  { at: 37, label: 'IV · Решение', description: 'Вместо догадки нужна проверяемая гипотеза.' }
]);
export const CASES = Object.freeze([
  {id:'01-restaurant',group:'hospitality',sector:'Ресторан',problem:'Гость не вернулся',hypothesis:'Ожидание внимания персонала может влиять на повторный визит.',evidence:'Отметки повторных визитов, жалобы и анонимные ответы ушедших гостей.',metric:'Доля гостей, совершивших повторный визит за выбранный период.',experiment:'Сравнить сопоставимые группы до и после изменения процесса обслуживания.',offer:'/assets/guest/offer.html'},
  {id:'02-fashion',group:'retail',sector:'Магазин одежды',problem:'Не нашлось нужного размера',hypothesis:'Отсутствие размера может скрывать спрос, не отражённый в продажах.',evidence:'Запросы размеров и доступность по магазинам, без данных о личности покупателя.',metric:'Число зафиксированных запросов отсутствующих размеров и исполненных запросов.',experiment:'Вести учёт отказов по размерам и проверить перенос остатков между точками.',offer:'/assets/sovereign/workspace.html?app=retail'},
  {id:'03-dentistry',group:'health',sector:'Стоматология',problem:'Свободное кресло',hypothesis:'Потенциальные пациенты могут теряться между обращением и записью.',evidence:'Обезличенные входящие обращения, отказы, время ответа и свободные интервалы.',metric:'Доля обращений, завершившихся подтверждённой записью.',experiment:'Проверить скорость ответа и полноту подтверждения для сопоставимых периодов.',offer:'/assets/industry/index.html'},
  {id:'04-auto',group:'service',sector:'Автосервис',problem:'Нет своевременного ответа',hypothesis:'Запрос может исчезнуть, когда подтверждение записи слишком долгое.',evidence:'Агрегированные пропущенные контакты и время реакции сервиса.',metric:'Доля входящих обращений, получивших своевременный ответ.',experiment:'Сравнить повторный контакт по заявкам до и после изменения обработки.',offer:'/assets/industry/index.html'},
  {id:'05-fitness',group:'service',sector:'Фитнес-клуб',problem:'Абонемент не продлён',hypothesis:'Первый опыт занятия может влиять на решение о продлении.',evidence:'Агрегированные продления по когортам и добровольные причины отказа.',metric:'Доля продлений абонементов за фиксированный период.',experiment:'Проверить сопровождение новых участников на сопоставимых группах.',offer:'/assets/industry/index.html'},
  {id:'06-education',group:'education',sector:'Образование',problem:'Курс не завершён',hypothesis:'Сложный старт и отсутствие обратной связи могут снижать завершение обучения.',evidence:'Обезличенные этапы прохождения курса и причины остановки.',metric:'Доля учащихся, завершивших выбранный модуль.',experiment:'Проверить изменение вводного урока в сопоставимых группах.',offer:'/assets/catalog/index.html'},
  {id:'07-coffee',group:'hospitality',sector:'Кофейня',problem:'Гость ушёл без заказа',hypothesis:'Очередь в пиковый период может приводить к несостоявшимся заказам.',evidence:'Подсчёт очереди и уходов по временным интервалам без распознавания лиц.',metric:'Доля посетителей очереди, дошедших до оформления заказа.',experiment:'В ограниченные часы сравнить текущий процесс и добровольный предзаказ.',offer:'/assets/guest/offer.html'},
  {id:'08-return',group:'hospitality',sector:'Ресторан',problem:'Отсутствие повторного визита',hypothesis:'После первого посещения гостю может не хватать повода вернуться.',evidence:'Сопоставимые группы первичных и повторных гостей, данные о согласиях на сообщения.',metric:'Доля повторных визитов в течение выбранного периода.',experiment:'Сравнить нейтральную коммуникацию и контрольную группу без навязчивых рассылок.',offer:'/assets/guest/offer.html'},
  {id:'09-appointment',group:'health',sector:'Клиника',problem:'Пациент пропустил запись',hypothesis:'Способ подтверждения и напоминания может влиять на неявки.',evidence:'Обезличенные интервалы записи, подтверждения и неявки, без медицинских сведений.',metric:'Доля подтверждённых записей с фактическим визитом.',experiment:'Проверить напоминания для согласившихся пациентов с группой сравнения.',offer:'/assets/industry/index.html'},
  {id:'10-construction',group:'service',sector:'Ремонт и строительство',problem:'Заявка не дошла до сметы',hypothesis:'Медленная обработка заявки может снижать вероятность обсуждения проекта.',evidence:'Обезличенные статусы заявок от обращения до сметы и время ответа.',metric:'Доля квалифицированных обращений, дошедших до предложения.',experiment:'Проверить единый регламент первого ответа и контрольную выборку.',offer:'/assets/industry/index.html'},
  {id:'11-logistics',group:'service',sector:'Логистика',problem:'Заказ ушёл конкуренту',hypothesis:'Неясный статус запроса может влиять на выбор перевозчика.',evidence:'Агрегированные обращения, время расчёта стоимости и причины отказов.',metric:'Доля запросов, дошедших до подтверждённой перевозки.',experiment:'Сравнить прозрачное подтверждение статуса и действующий процесс.',offer:'/assets/industry/index.html'},
  {id:'12-shoes',group:'retail',sector:'Магазин обуви',problem:'Не подошёл размер',hypothesis:'Незаписанные запросы по размерам могут скрывать возможность перераспределить остатки.',evidence:'Запросы размеров по моделям и остатки по доступным точкам.',metric:'Доля запросов на отсутствующий размер, закрытых альтернативной поставкой.',experiment:'Проверить выдачу наличия в соседней точке и измерить реальные покупки.',offer:'/assets/sovereign/workspace.html?app=retail'}
]);
export const GROUPS = Object.freeze([
  {id:'hospitality',label:'Рестораны и кофейни'},
  {id:'retail',label:'Магазины'},
  {id:'health',label:'Клиники'},
  {id:'service',label:'Услуги'},
  {id:'education',label:'Образование'}
]);
const index = new Map(CASES.map(item=>[item.id,item]));
export function caseById(id) { return typeof id==='string' ? (index.get(id) ?? null) : null; }
export function casesByGroup(group) {
  return group === 'all' ? [...CASES] : CASES.filter(item=>item.group===group);
}
export function currentChapter(seconds) {
  const value=Number(seconds);
  if(!Number.isFinite(value)||value<0)return CHAPTERS[0];
  return CHAPTERS.reduce((selected,chapter)=>value>=chapter.at?chapter:selected, CHAPTERS[0]);
}
export function tidy(value,max=220) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}
export function storyURL(id) {
  const item=caseById(id);
  if(!item) return 'https://osmanx.world/assets/stories/cinema.html';
  return 'https://osmanx.world/assets/stories/cinema.html?story='+encodeURIComponent(item.id)+'#episodes';
}
export function buildBrief({id,company='',concern='',monthlyVolume='',goal=''}={}) {
  const item=caseById(id);
  if(!item) throw new Error('Выберите конкретный сюжет.');
  const volume=tidy(monthlyVolume,24);
  if(volume && (!/^\d{1,9}$/.test(volume) || Number(volume)<0)) throw new Error('Объём должен быть целым неотрицательным числом.');
  const business=tidy(company,90), note=tidy(concern,340), outcome=tidy(goal,240);
  const lines=[
    'OSMANX WORLD — предварительный запрос на диагностику',
    'Отрасль: '+item.sector,
    'Ситуация: '+item.problem,
    business?'Организация: '+business:'',
    volume?'Ориентир по обращениям или визитам за месяц: '+volume:'',
    note?'Наблюдения: '+note:'',
    outcome?'Цель проверки: '+outcome:'',
    'Возможная гипотеза (не доказанный факт): '+item.hypothesis,
    'Данные для проверки: '+item.evidence,
    'Контрольный показатель: '+item.metric,
    'Возможный эксперимент: '+item.experiment,
    'Источник: '+storyURL(item.id),
    'Это запрос на обсуждение диагностики, не заказ и не обещание результата.'
  ].filter(Boolean);
  return lines.join('\n');
}
export function mailtoBrief(brief,id) {
  const item=caseById(id);
  if(!item || typeof brief!=='string' || brief.length<30)throw new Error('Недостаточно данных для запроса.');
  const subj='OSMANX — диагностика / '+item.sector;
  return 'mailto:hello@osmanx.world?subject='+encodeURIComponent(subj)+'&body='+encodeURIComponent(brief);
}
