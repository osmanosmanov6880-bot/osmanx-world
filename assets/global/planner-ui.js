import {
  CALCULATOR_RULES, DEFAULT_INPUTS, DRAFT_KEY, SECTORS, SECTOR_LABELS,
  calculatePilot, createPilotPlan, pilotPlanText, normalizeSector,
  validateBrief, createBrief, briefText, buildBriefMailto, encodeDraft, decodeDraft,
} from './planner.js';

const COPY = {
  ru: {
    calcTitle: 'Проверьте экономику гипотезы', calcIntro: 'Измените примерные значения на свои. Расчёт показывает условия безубыточности, а не прогноз роста.',
    fields: { opportunities: 'Возможности в месяц', recoverablePct: 'Предполагаемая доля возврата, %', contributionProfitPerOrder: 'Прибыль с дополнительного заказа, ₽', projectCost: 'Разовые затраты на пилот, ₽', recurringCost: 'Регулярные затраты в месяц, ₽', months: 'Период оценки, месяцев' },
    hints: { opportunities: 'Например, обращения или визиты без покупки. Только сопоставимые события.', recoverablePct: 'Ваша гипотеза: какую долю удастся превратить в дополнительные заказы.', contributionProfitPerOrder: 'После переменных затрат на заказ; не средний чек.', projectCost: 'Все первоначальные затраты, которые вы хотите учесть.', recurringCost: 'Поддержка, сервисы и другие повторяющиеся затраты.', months: 'От 1 до 36 месяцев.' },
    resultTitle: 'При введённых допущениях', labels: { monthlyRecoveredOrders: 'Дополнительных заказов / месяц', monthlyNet: 'В месяц после регулярных затрат', periodNet: 'За период после всех указанных затрат', breakEvenOrdersPerMonth: 'Заказов / месяц для безубыточности', paybackMonths: 'Месяцев до покрытия разовых затрат' },
    positive: 'Расчётный результат за период положительный.', zero: 'Расчётный результат за период равен нулю.', negative: 'За выбранный период указанные затраты не покрываются.', impossible: 'Для безубыточности требуется больше заказов, чем введено возможностей. Пересмотрите условия пилота.',
    noPayback: 'Не достигается', notCalculable: 'Не рассчитывается', formula: 'Результат за период = дополнительные заказы × прибыль с заказа × месяцы − разовые затраты − регулярные затраты × месяцы.', exclusions: 'Суммы в рублях. Налоги и стоимость времени собственника не включены. Реальный эффект требует отдельного измерения.',
    usePlan: 'Добавить расчёт в бриф', downloadPlan: 'Скачать план TXT', downloadPlanJSON: 'Скачать план JSON', fixCalc: 'Исправьте отмеченные значения.', downloadReady: 'Файл подготовлен для скачивания.', downloadFailed: 'Создать файл не удалось. Можно скопировать текст брифа или открыть письмо.',
    briefTitle: 'Соберите бриф проекта', briefIntro: 'Опишите одну задачу. На последнем шаге вы сможете скачать бриф или открыть письмо Осману в своей почтовой программе.', steps: ['Задача', 'Контакт', 'Проверка'],
    sector: 'Ваш бизнес', task: 'Какую задачу хотите решить?', taskHint: 'Что происходит сейчас и какое изменение вы хотите проверить? От 10 до 1200 символов.', evidence: 'Какие обезличенные данные уже есть?', evidenceHint: 'Например: количество обращений, записей, возвратов. Не добавляйте данные гостей или пациентов.',
    company: 'Компания или проект', name: 'Как к вам обращаться? Необязательно', email: 'Email для ответа', emailHint: 'Контакт попадёт только в подготовленный вами файл или письмо.',
    remember: 'Сохранить черновик в этом браузере на 7 дней', rememberHint: 'Включает название компании и контакт. Подходит для личного устройства.', clear: 'Очистить черновик', next: 'Продолжить', prepare: 'Проверить бриф', back: 'Назад',
    ready: 'Бриф подготовлен. Отправку выбираете вы.', reviewNotice: 'Эта форма не отправляет сведения на сервер. Скачайте файл или откройте письмо, проверьте его и отправьте из своей почтовой программы.',
    txt: 'Скачать бриф TXT', json: 'Скачать бриф JSON', copy: 'Скопировать бриф', emailAction: 'Открыть письмо', emailHelp: 'Получатель: hello@osmanx.world. Открытие почтовой программы не означает отправку.', shortened: 'В письмо войдёт краткая версия. Прикрепите скачанный TXT или JSON перед отправкой.',
    copied: 'Бриф скопирован.', copyManual: 'Автоматическое копирование недоступно. Выделите и скопируйте текст ниже.', copyLabel: 'Бриф для ручного копирования',
    restored: 'Сохранённый черновик восстановлен.', saved: 'Черновик сохранён в этом браузере на 7 дней.', removed: 'Сохранение отключено. Черновик удалён из этого браузера.', cleared: 'Поля и сохранённый черновик очищены.', partialClear: 'Поля очищены, но удалить сохранённую копию не удалось. Она может восстановиться при следующем открытии.', expired: 'Срок черновика истёк. Подготовьте новый.', invalidDraft: 'Сохранённый черновик не удалось прочитать. Можно подготовить новый.', storageRead: 'Хранилище браузера недоступно. Бриф можно подготовить и скачать без сохранения.', storageWrite: 'Черновик не удалось сохранить. Скачайте бриф, чтобы сохранить введённое.', storageRemove: 'Удалить сохранённый черновик не удалось. Данные в полях сохранены; попробуйте очистить ещё раз.',
    planAdded: 'Расчёт добавлен в бриф. Его значения зафиксированы; новые изменения калькулятора не заменят их автоматически.', attachedPlan: 'К брифу приложены допущения калькулятора.', removePlan: 'Убрать расчёт из брифа', planRemoved: 'Расчёт убран из брифа.', sectorChanged: 'Отрасль изменена. При необходимости добавьте расчёт для выбранной отрасли заново.', requiredErrors: 'Проверьте отмеченные поля.',
    errors: { required: 'Введите значение.', number: 'Введите число, например 1250 или 1250,50.', precision: 'Используйте не более двух знаков после запятой.', integer: 'Введите целое число.', min: 'Значение ниже допустимого.', max: 'Значение выше допустимого.', sector: 'Выберите отрасль.', text: 'Введите обычный текст без служебных символов.', length: 'Текст длиннее допустимого.', task: 'Опишите задачу хотя бы в 10 символах.', company: 'Введите название хотя бы из двух символов.', email: 'Введите корректный email, например name@company.com.' },
  },
  en: {
    calcTitle: 'Test the economics of a hypothesis', calcIntro: 'Replace the example values with your own. This calculation describes break-even conditions, not a growth forecast.',
    fields: { opportunities: 'Opportunities per month', recoverablePct: 'Assumed recovery rate, %', contributionProfitPerOrder: 'Profit per additional order, RUB', projectCost: 'One-time pilot cost, RUB', recurringCost: 'Recurring monthly cost, RUB', months: 'Evaluation period, months' },
    hints: { opportunities: 'For example, enquiries or visits without a purchase. Use comparable events.', recoverablePct: 'Your hypothesis: the share that may become additional orders.', contributionProfitPerOrder: 'After variable order costs; this is not the average order value.', projectCost: 'All initial costs you want to include.', recurringCost: 'Support, services and other recurring costs.', months: 'From 1 to 36 months.' },
    resultTitle: 'With the assumptions entered', labels: { monthlyRecoveredOrders: 'Additional orders / month', monthlyNet: 'Monthly result after recurring costs', periodNet: 'Period result after all entered costs', breakEvenOrdersPerMonth: 'Orders / month needed to break even', paybackMonths: 'Months to cover the one-time cost' },
    positive: 'The calculated period result is positive.', zero: 'The calculated period result is zero.', negative: 'The entered costs are not covered within the selected period.', impossible: 'Break-even requires more orders than the opportunities entered. Reconsider the pilot conditions.',
    noPayback: 'Not reached', notCalculable: 'Not calculable', formula: 'Period result = additional orders × profit per order × months − one-time cost − recurring monthly cost × months.', exclusions: 'All amounts are RUB. Taxes and the owner’s time are excluded. Actual impact needs to be measured separately.',
    usePlan: 'Add calculation to brief', downloadPlan: 'Download plan TXT', downloadPlanJSON: 'Download plan JSON', fixCalc: 'Correct the highlighted values.', downloadReady: 'The file is ready to download.', downloadFailed: 'The file could not be created. You can copy the brief or open an email.',
    briefTitle: 'Build your project brief', briefIntro: 'Describe one business task. At the last step you can download the brief or open an email to Osman in your own mail application.', steps: ['Task', 'Contact', 'Review'],
    sector: 'Your business', task: 'What would you like to improve?', taskHint: 'What happens today, and what change would you like to test? Between 10 and 1200 characters.', evidence: 'What anonymised evidence is available?', evidenceHint: 'For example: enquiries, bookings or returning customers. Do not include guest or patient records.',
    company: 'Company or project', name: 'Your name — optional', email: 'Reply email', emailHint: 'Your contact will only be included in the file or email you prepare.',
    remember: 'Save a draft in this browser for 7 days', rememberHint: 'Includes the company name and contact. Use a personal device.', clear: 'Clear draft', next: 'Continue', prepare: 'Review brief', back: 'Back',
    ready: 'Your brief is prepared. You choose how to send it.', reviewNotice: 'This form does not send information to a server. Download the file or open an email, review it and send it from your own mail application.',
    txt: 'Download brief TXT', json: 'Download brief JSON', copy: 'Copy brief', emailAction: 'Open email', emailHelp: 'Recipient: hello@osmanx.world. Opening a mail application does not send a message.', shortened: 'The email contains a short version. Attach the downloaded TXT or JSON file before sending.',
    copied: 'Brief copied.', copyManual: 'Automatic copy is unavailable. Select and copy the text below.', copyLabel: 'Brief for manual copying',
    restored: 'Your saved draft has been restored.', saved: 'Draft saved in this browser for 7 days.', removed: 'Saving is off. The saved draft was removed from this browser.', cleared: 'Fields and saved draft cleared.', partialClear: 'The fields were cleared, but the stored copy could not be removed. It may reappear when you return.', expired: 'The saved draft has expired. Prepare a new one.', invalidDraft: 'The saved draft could not be read. You can prepare a new one.', storageRead: 'Browser storage is unavailable. You can prepare and download a brief without saving it.', storageWrite: 'The draft could not be saved. Download the brief to keep what you entered.', storageRemove: 'The saved draft could not be removed. Your fields have been kept; try clearing it again.',
    planAdded: 'The calculation was added to the brief as a snapshot. Later calculator changes will not replace it automatically.', attachedPlan: 'Calculator assumptions are attached to the brief.', removePlan: 'Remove calculation from brief', planRemoved: 'Calculation removed from the brief.', sectorChanged: 'The industry changed. Add the calculation again if it applies to the selected industry.', requiredErrors: 'Check the highlighted fields.',
    errors: { required: 'Enter a value.', number: 'Enter a number, for example 1250 or 1250.50.', precision: 'Use no more than two decimal places.', integer: 'Enter a whole number.', min: 'The value is below the allowed minimum.', max: 'The value is above the allowed maximum.', sector: 'Choose an industry.', text: 'Use plain text without control characters.', length: 'The text is too long.', task: 'Describe the task in at least 10 characters.', company: 'Enter a name with at least two characters.', email: 'Enter a valid email, for example name@company.com.' },
  },
};

let mountedCount = 0;
function node(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') element.textContent = value;
    else if (value === true) element.setAttribute(key, '');
    else if (value !== false && value !== null && value !== undefined) element.setAttribute(key, String(value));
  }
  for (const child of [children].flat()) if (child !== null && child !== undefined) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
}
const button = (text, className = 'gplan-button') => node('button', { type: 'button', class: className, text });

export function mountPlanner({ calculatorEl, briefEl, locale = 'ru', sector = 'coffee' }) {
  if (!(calculatorEl instanceof Element) || !(briefEl instanceof Element)) throw new TypeError('Planner requires calculator and brief containers');
  const lang = locale === 'en' ? 'en' : 'ru';
  const t = COPY[lang];
  const initialSector = normalizeSector(sector);
  const prefix = `gplan-${++mountedCount}`;
  const controller = new AbortController();
  const listen = (el, type, handler) => el.addEventListener(type, handler, { signal: controller.signal });
  const format = value => new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'ru-RU', { maximumFractionDigits: 2 }).format(value);
  const money = value => new Intl.NumberFormat(lang === 'en' ? 'en-GB' : 'ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 }).format(value);
  const state = { step: 0, plan: null, remember: false, dirty: false, revision: 0 };
  let saveTimer = null;

  const calcRoot = node('div', { class: 'gplan gplan-calculator' });
  calcRoot.append(node('h3', { class: 'gplan-title', text: t.calcTitle }), node('p', { class: 'gplan-lede', text: t.calcIntro }));
  const calcGrid = node('div', { class: 'gplan-fields' });
  const calcInputs = {};
  const calcErrors = {};
  for (const key of Object.keys(CALCULATOR_RULES)) {
    const id = `${prefix}-calc-${key}`;
    const input = node('input', { id, name: key, type: 'text', inputmode: CALCULATOR_RULES[key].integer ? 'numeric' : 'decimal', autocomplete: 'off', 'aria-describedby': `${id}-hint ${id}-error` });
    input.value = String(DEFAULT_INPUTS[key]);
    const error = node('span', { class: 'gplan-error', id: `${id}-error` });
    calcGrid.append(node('div', { class: 'gplan-field' }, [node('label', { for: id, text: t.fields[key] }), input, node('small', { id: `${id}-hint`, class: 'gplan-hint', text: t.hints[key] }), error]));
    calcInputs[key] = input;
    calcErrors[key] = error;
  }
  const resultBox = node('div', { class: 'gplan-result' });
  const resultGrid = node('dl', { class: 'gplan-results-grid' });
  const resultValues = {};
  for (const key of Object.keys(t.labels)) {
    const output = node('dd');
    resultValues[key] = output;
    resultGrid.append(node('div', {}, [node('dt', { text: t.labels[key] }), output]));
  }
  const calcStatus = node('p', { class: 'gplan-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const calcWarning = node('p', { class: 'gplan-warning', hidden: true });
  resultBox.append(node('h4', { text: t.resultTitle }), resultGrid, calcStatus, calcWarning, node('p', { class: 'gplan-formula', text: t.formula }), node('p', { class: 'gplan-hint', text: t.exclusions }));
  const usePlan = button(t.usePlan, 'gplan-button gplan-primary');
  const planTxt = button(t.downloadPlan);
  const planJSON = button(t.downloadPlanJSON);
  const calcFileStatus = node('p', { class: 'gplan-status', role: 'status' });
  calcRoot.append(calcGrid, resultBox, node('div', { class: 'gplan-actions' }, [usePlan, planTxt, planJSON]), calcFileStatus);
  calculatorEl.replaceChildren(calcRoot);

  const briefRoot = node('div', { class: 'gplan gplan-brief' });
  briefRoot.append(node('h3', { class: 'gplan-title', text: t.briefTitle }), node('p', { class: 'gplan-lede', text: t.briefIntro }));
  const stepList = node('ol', { class: 'gplan-steps', 'aria-label': lang === 'en' ? 'Brief steps' : 'Шаги брифа' });
  const stepItems = t.steps.map((label, index) => node('li', {}, [node('span', { class: 'gplan-step-number', 'aria-hidden': 'true', text: index + 1 }), label]));
  stepList.append(...stepItems);
  briefRoot.append(stepList);
  const form = node('form', { novalidate: true, class: 'gplan-form' });
  const fields = {};
  const fieldErrors = {};
  function field(key, label, { textarea = false, hint = '', max = 120, type = 'text', required = false, autocomplete = 'off' } = {}) {
    const id = `${prefix}-brief-${key}`;
    const control = node(textarea ? 'textarea' : 'input', { id, name: key, type: textarea ? null : type, rows: textarea ? 4 : null, maxlength: max, autocomplete, required, 'aria-describedby': `${id}-hint ${id}-error` });
    const error = node('span', { id: `${id}-error`, class: 'gplan-error' });
    fields[key] = control;
    fieldErrors[key] = error;
    return node('div', { class: 'gplan-field' }, [node('label', { for: id, text: label }), control, node('small', { id: `${id}-hint`, class: 'gplan-hint', text: hint }), error]);
  }
  const sectorId = `${prefix}-brief-sector`;
  const sectorSelect = node('select', { id: sectorId, name: 'sector', 'aria-describedby': `${sectorId}-error` });
  for (const id of SECTORS) sectorSelect.append(node('option', { value: id, text: SECTOR_LABELS[lang][id] }));
  sectorSelect.value = initialSector;
  fields.sector = sectorSelect;
  fieldErrors.sector = node('span', { id: `${sectorId}-error`, class: 'gplan-error' });
  const stepZero = node('fieldset', { class: 'gplan-step' }, [node('legend', { class: 'gplan-sr-only', text: t.steps[0] }), node('div', { class: 'gplan-field' }, [node('label', { for: sectorId, text: t.sector }), sectorSelect, fieldErrors.sector]), field('task', t.task, { textarea: true, max: 1200, required: true, hint: t.taskHint }), field('evidence', t.evidence, { textarea: true, max: 1500, hint: t.evidenceHint })]);
  const stepOne = node('fieldset', { class: 'gplan-step', hidden: true }, [node('legend', { class: 'gplan-sr-only', text: t.steps[1] }), field('company', t.company, { max: 120, required: true, autocomplete: 'organization' }), field('name', t.name, { max: 100, autocomplete: 'name' }), field('email', t.email, { max: 254, type: 'email', required: true, hint: t.emailHint, autocomplete: 'email' })]);
  fields.email.setAttribute('inputmode', 'email');
  const reviewText = node('pre', { class: 'gplan-review' });
  const txtButton = button(t.txt, 'gplan-button gplan-primary');
  const jsonButton = button(t.json);
  const copyButton = button(t.copy);
  const mailButton = node('a', { class: 'gplan-button', text: t.emailAction, href: '#' });
  const shortenedNote = node('p', { class: 'gplan-hint', hidden: true, text: t.shortened });
  const manualCopy = node('textarea', { class: 'gplan-manual-copy', rows: 6, readonly: true, hidden: true, 'aria-label': t.copyLabel });
  const stepTwo = node('fieldset', { class: 'gplan-step', hidden: true }, [node('legend', { class: 'gplan-sr-only', text: t.steps[2] }), node('p', { class: 'gplan-ready', text: t.ready }), node('p', { class: 'gplan-hint', text: t.reviewNotice }), reviewText, node('div', { class: 'gplan-actions' }, [txtButton, jsonButton, copyButton, mailButton]), node('p', { class: 'gplan-hint', text: t.emailHelp }), shortenedNote, manualCopy]);
  const steps = [stepZero, stepOne, stepTwo];
  const attachedNote = node('div', { class: 'gplan-attached', hidden: true });
  const removePlan = button(t.removePlan, 'gplan-text-button');
  attachedNote.append(node('span', { text: t.attachedPlan }), removePlan);
  const backButton = button(t.back);
  const nextButton = node('button', { type: 'submit', class: 'gplan-button gplan-primary', text: t.next });
  const navButtons = node('div', { class: 'gplan-actions gplan-navigation' }, [backButton, nextButton]);
  const remember = node('input', { type: 'checkbox', id: `${prefix}-remember` });
  const rememberLabel = node('label', { class: 'gplan-checkbox', for: `${prefix}-remember` }, [remember, node('span', { text: t.remember })]);
  const storageMessage = node('p', { class: 'gplan-status gplan-storage-status', role: 'status', 'aria-live': 'polite' });
  const briefStatus = node('p', { class: 'gplan-status', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const clearButton = button(t.clear, 'gplan-text-button');
  form.append(...steps, attachedNote, navButtons, briefStatus, node('div', { class: 'gplan-storage' }, [rememberLabel, node('p', { class: 'gplan-hint', text: t.rememberHint }), storageMessage, clearButton]));
  briefRoot.append(form);
  briefEl.replaceChildren(briefRoot);

  function inputValues() { return Object.fromEntries(Object.entries(calcInputs).map(([key, input]) => [key, input.value])); }
  function briefValues() { return Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value])); }
  function calculation() { return calculatePilot(inputValues()); }
  function showCalculator() {
    const result = calculation();
    for (const key of Object.keys(calcInputs)) {
      const error = result.errors?.[key];
      calcInputs[key].setAttribute('aria-invalid', error ? 'true' : 'false');
      calcErrors[key].textContent = error ? `${t.errors[error]} ${error === 'min' || error === 'max' ? `(${format(CALCULATOR_RULES[key].min)}–${format(CALCULATOR_RULES[key].max)})` : ''}`.trim() : '';
    }
    for (const control of [usePlan, planTxt, planJSON]) control.disabled = !result.valid;
    calcWarning.hidden = true;
    if (!result.valid) {
      for (const output of Object.values(resultValues)) output.textContent = '—';
      calcStatus.textContent = t.fixCalc;
      resultBox.dataset.outcome = 'invalid';
      return;
    }
    const r = result.results;
    resultValues.monthlyRecoveredOrders.textContent = format(r.monthlyRecoveredOrders);
    resultValues.monthlyNet.textContent = money(r.monthlyNet);
    resultValues.periodNet.textContent = money(r.periodNet);
    resultValues.breakEvenOrdersPerMonth.textContent = r.breakEvenOrdersPerMonth === null ? t.notCalculable : format(r.breakEvenOrdersPerMonth);
    resultValues.paybackMonths.textContent = r.paybackMonths === null ? t.noPayback : format(r.paybackMonths);
    resultBox.dataset.outcome = r.outcome;
    calcStatus.textContent = t[r.outcome];
    if (r.targetExceedsOpportunities) { calcWarning.textContent = t.impossible; calcWarning.hidden = false; }
  }
  function makePlan() { return createPilotPlan(inputValues(), { sector: fields.sector.value }); }
  function showErrors(errors = {}) {
    for (const key of Object.keys(fields)) {
      fields[key].setAttribute('aria-invalid', errors[key] ? 'true' : 'false');
      fieldErrors[key].textContent = errors[key] ? t.errors[errors[key]] : '';
    }
  }
  function currentBrief() { return createBrief(briefValues(), { plan: state.plan }); }
  function refreshReview() {
    if (state.step !== 2) return;
    const brief = currentBrief();
    reviewText.textContent = briefText(brief, lang);
    const mail = buildBriefMailto(brief, lang);
    mailButton.href = mail.url;
    shortenedNote.hidden = !mail.abbreviated;
  }
  function showStep(step, focus = false) {
    state.step = step;
    steps.forEach((element, index) => { element.hidden = index !== step; });
    stepItems.forEach((element, index) => {
      element.classList.toggle('gplan-current', index === step);
      if (index === step) element.setAttribute('aria-current', 'step'); else element.removeAttribute('aria-current');
    });
    backButton.hidden = step === 0;
    nextButton.hidden = step === 2;
    nextButton.textContent = step === 0 ? t.next : t.prepare;
    attachedNote.hidden = !state.plan;
    manualCopy.hidden = true;
    briefStatus.textContent = '';
    refreshReview();
    if (focus) (step === 0 ? fields.task : step === 1 ? fields.company : txtButton).focus();
  }
  function saveDraft() {
    saveTimer = null;
    if (!state.remember || !state.dirty) return;
    try {
      window.localStorage.setItem(DRAFT_KEY, encodeDraft(briefValues(), state.plan));
      state.dirty = false;
      storageMessage.textContent = t.saved;
    } catch { storageMessage.textContent = t.storageWrite; }
  }
  function changed() {
    state.revision += 1;
    state.dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    if (state.remember) saveTimer = setTimeout(saveDraft, 450);
  }
  function removeDraft() {
    try { window.localStorage.removeItem(DRAFT_KEY); return true; }
    catch { storageMessage.textContent = t.storageRemove; return false; }
  }
  function download(content, extension, kind) {
    try {
      const blob = new Blob([extension === 'json' ? content : '\ufeff' + content], { type: extension === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = node('a', { href: url, download: `OSMANX_${kind}_${new Date().toISOString().slice(0, 10)}.${extension}`, hidden: true });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      return true;
    } catch { return false; }
  }
  for (const input of Object.values(calcInputs)) listen(input, 'input', showCalculator);
  listen(usePlan, 'click', () => {
    if (!calculation().valid) return;
    state.plan = makePlan();
    attachedNote.hidden = false;
    changed();
    if (state.step === 2) refreshReview();
    briefStatus.textContent = t.planAdded;
    briefEl.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    if (state.step === 0) fields.task.focus({ preventScroll: true });
  });
  listen(planTxt, 'click', () => { if (calculation().valid) calcFileStatus.textContent = download(pilotPlanText(makePlan(), lang), 'txt', 'pilot') ? t.downloadReady : t.downloadFailed; });
  listen(planJSON, 'click', () => { if (calculation().valid) calcFileStatus.textContent = download(JSON.stringify(makePlan(), null, 2), 'json', 'pilot') ? t.downloadReady : t.downloadFailed; });
  for (const input of Object.values(fields)) listen(input, 'input', () => {
    changed();
    if (Object.values(fieldErrors).some(error => error.textContent)) showErrors(validateBrief(briefValues(), state.step).errors);
  });
  listen(fields.sector, 'change', () => {
    if (state.plan && state.plan.sector !== fields.sector.value) {
      state.plan = null; attachedNote.hidden = true; changed(); briefStatus.textContent = t.sectorChanged;
    }
  });
  listen(form, 'submit', event => {
    event.preventDefault();
    if (state.step === 2) return;
    const result = validateBrief(briefValues(), state.step === 0 ? 0 : 'all');
    showErrors(result.errors);
    if (!result.valid) {
      const firstKey = Object.keys(result.errors)[0];
      if (['sector', 'task', 'evidence'].includes(firstKey) && state.step === 1) showStep(0);
      briefStatus.textContent = t.requiredErrors;
      fields[firstKey].focus();
      return;
    }
    showStep(state.step + 1, true);
    if (state.remember) saveDraft();
  });
  listen(backButton, 'click', () => { showErrors(); showStep(Math.max(0, state.step - 1), true); });
  listen(remember, 'change', () => {
    state.remember = remember.checked;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (state.remember) { state.dirty = true; saveDraft(); }
    else if (removeDraft()) storageMessage.textContent = t.removed;
  });
  listen(clearButton, 'click', () => {
    const removed = removeDraft();
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    state.remember = false; state.dirty = false; state.plan = null; state.revision += 1;
    remember.checked = false;
    for (const [key, control] of Object.entries(fields)) control.value = key === 'sector' ? initialSector : '';
    reviewText.textContent = ''; manualCopy.value = ''; mailButton.removeAttribute('href');
    showErrors(); showStep(0, true); storageMessage.textContent = removed ? t.cleared : t.partialClear;
  });
  listen(removePlan, 'click', () => { state.plan = null; attachedNote.hidden = true; changed(); refreshReview(); briefStatus.textContent = t.planRemoved; });
  listen(txtButton, 'click', () => { briefStatus.textContent = download(briefText(currentBrief(), lang), 'txt', 'brief') ? t.downloadReady : t.downloadFailed; });
  listen(jsonButton, 'click', () => { briefStatus.textContent = download(JSON.stringify(currentBrief(), null, 2), 'json', 'brief') ? t.downloadReady : t.downloadFailed; });
  listen(copyButton, 'click', async () => {
    const text = briefText(currentBrief(), lang);
    const revision = state.revision;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (!controller.signal.aborted && revision === state.revision) briefStatus.textContent = t.copied;
    } catch {
      if (controller.signal.aborted || revision !== state.revision) return;
      manualCopy.value = text; manualCopy.hidden = false; manualCopy.focus(); manualCopy.select(); briefStatus.textContent = t.copyManual;
    }
  });
  listen(mailButton, 'click', () => { refreshReview(); briefStatus.textContent = t.emailHelp; });
  listen(window, 'pagehide', saveDraft);
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    const draft = decodeDraft(raw);
    if (draft.status === 'ready') {
      for (const [key, value] of Object.entries(draft.fields)) if (fields[key]) fields[key].value = value;
      state.plan = draft.pilotPlan; state.remember = true; remember.checked = true; storageMessage.textContent = t.restored;
    } else if (draft.status === 'expired' || draft.status === 'invalid') {
      if (removeDraft()) storageMessage.textContent = draft.status === 'expired' ? t.expired : t.invalidDraft;
    }
  } catch { storageMessage.textContent = t.storageRead; }
  showCalculator(); showStep(0);
  return {
    destroy() { if (saveTimer) clearTimeout(saveTimer); saveDraft(); controller.abort(); },
    getPlan() { return calculation().valid ? makePlan() : null; },
    getBrief() { return validateBrief(briefValues()).valid ? currentBrief() : null; },
  };
}
