/** Local, assumption-based pilot planning. No transport or browser state in this module. */
export const SECTORS = Object.freeze(['coffee', 'restaurants', 'retail', 'dental', 'other']);
export const DRAFT_KEY = 'osmanx.global.brief.v1';
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CALCULATOR_RULES = Object.freeze({
  opportunities: { min: 0, max: 1_000_000, integer: true },
  recoverablePct: { min: 0, max: 100 },
  contributionProfitPerOrder: { min: 0, max: 1_000_000 },
  projectCost: { min: 0, max: 1_000_000_000 },
  recurringCost: { min: 0, max: 1_000_000_000 },
  months: { min: 1, max: 36, integer: true },
});
export const DEFAULT_INPUTS = Object.freeze({
  opportunities: 100,
  recoverablePct: 10,
  contributionProfitPerOrder: 500,
  projectCost: 25_000,
  recurringCost: 0,
  months: 3,
});

export function normalizeSector(value) {
  return SECTORS.includes(value) ? value : 'coffee';
}

export function parsePlanNumber(value, rule = {}) {
  if (value === '' || value === null || value === undefined) return { error: 'required' };
  let number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { error: 'number' };
    number = value;
    if (Math.abs(number * 100 - Math.round(number * 100)) > 0.00001) return { error: 'precision' };
  } else if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return { error: 'required' };
    if (raw.length > 64 || /[\r\n\t]/.test(raw)) return { error: 'number' };
    const clean = raw.replace(/[ \u00a0\u202f]/g, '');
    if (!/^[+-]?(?:\d+(?:[.,]\d{1,2})?|[.,]\d{1,2})$/.test(clean)) return { error: 'number' };
    number = Number(clean.replace(',', '.'));
  } else return { error: 'number' };
  if (!Number.isFinite(number)) return { error: 'number' };
  if (rule.integer && !Number.isInteger(number)) return { error: 'integer' };
  if (rule.min !== undefined && number < rule.min) return { error: 'min' };
  if (rule.max !== undefined && number > rule.max) return { error: 'max' };
  return { value: Object.is(number, -0) ? 0 : number };
}

export function validateCalculator(input) {
  const errors = {};
  const values = {};
  for (const [key, rule] of Object.entries(CALCULATOR_RULES)) {
    const result = parsePlanNumber(input?.[key], rule);
    if (result.error) errors[key] = result.error;
    else values[key] = result.value;
  }
  return { valid: Object.keys(errors).length === 0, values, errors };
}

const cents = number => BigInt(Math.round(number * 100));
const rubles = value => Number(value) / 100;
const ceilRatio = (a, b) => Number((a + b - 1n) / b);

export function calculatePilot(input) {
  const validation = validateCalculator(input);
  if (!validation.valid) return { valid: false, errors: validation.errors };
  const v = validation.values;
  const basisPoints = BigInt(Math.round(v.recoverablePct * 100));
  const orderUnits = BigInt(v.opportunities) * basisPoints;
  const profit = cents(v.contributionProfitPerOrder);
  // Round only the monthly monetary result, using exact decimal integer arithmetic.
  const monthlyContribution = (orderUnits * profit + 5_000n) / 10_000n;
  const recurring = cents(v.recurringCost);
  const project = cents(v.projectCost);
  const months = BigInt(v.months);
  const monthlyNet = monthlyContribution - recurring;
  const totalCost = project + recurring * months;
  const periodNet = monthlyContribution * months - totalCost;
  const breakEvenOrdersPerMonth = totalCost === 0n ? 0 : profit > 0n ? ceilRatio(totalCost, profit * months) : null;
  const breakEvenRecoveryPct = breakEvenOrdersPerMonth === null || v.opportunities === 0
    ? null : breakEvenOrdersPerMonth / v.opportunities * 100;
  return {
    valid: true,
    inputs: v,
    results: {
      monthlyRecoveredOrders: Number(orderUnits) / 10_000,
      monthlyContribution: rubles(monthlyContribution),
      monthlyNet: rubles(monthlyNet),
      periodContribution: rubles(monthlyContribution * months),
      periodOperatingCost: rubles(recurring * months),
      totalCost: rubles(totalCost),
      periodNet: rubles(periodNet),
      breakEvenOrdersPerMonth,
      breakEvenRecoveryPct,
      paybackMonths: monthlyNet > 0n ? Number(project) / Number(monthlyNet) : null,
      outcome: periodNet > 0n ? 'positive' : periodNet < 0n ? 'negative' : 'zero',
      targetExceedsOpportunities: breakEvenOrdersPerMonth !== null && breakEvenOrdersPerMonth > v.opportunities,
    },
  };
}

export function createPilotPlan(input, { sector = 'coffee', now = Date.now() } = {}) {
  const result = calculatePilot(input);
  if (!result.valid) throw new TypeError('Invalid pilot assumptions');
  if (!Number.isFinite(now)) throw new TypeError('Invalid plan date');
  return {
    schemaVersion: 1,
    kind: 'osmanx_pilot_plan',
    createdAt: new Date(now).toISOString(),
    sector: normalizeSector(sector),
    currency: 'RUB',
    assumptionsNotForecast: true,
    inputs: result.inputs,
    results: result.results,
  };
}

export const SECTOR_LABELS = Object.freeze({
  ru: { coffee: 'Кофейня', restaurants: 'Ресторан', retail: 'Магазин одежды', dental: 'Стоматология', other: 'Другая отрасль' },
  en: { coffee: 'Coffee shop', restaurants: 'Restaurant', retail: 'Fashion retail', dental: 'Dental practice', other: 'Other industry' },
});
const TEXT_LABELS = {
  ru: {
    heading: 'OSMANX — условный план пилота', assumption: 'Сценарий основан на введённых допущениях. Это не прогноз и не обещание результата.',
    sector: 'Отрасль', date: 'Создан', opportunities: 'Возможности в месяц', recoverablePct: 'Предполагаемая доля возврата, %',
    contributionProfitPerOrder: 'Маржинальная прибыль одного заказа, ₽', projectCost: 'Разовые затраты, ₽', recurringCost: 'Ежемесячные затраты, ₽', months: 'Горизонт, месяцев',
    monthlyRecoveredOrders: 'Дополнительные заказы в месяц (расчёт)', monthlyContribution: 'Маржинальная прибыль в месяц, ₽', monthlyNet: 'Результат в месяц после регулярных затрат, ₽',
    periodNet: 'Результат за период после всех указанных затрат, ₽', totalCost: 'Все указанные затраты за период, ₽', breakEvenOrdersPerMonth: 'Заказов в месяц для безубыточности за выбранный период',
    paybackMonths: 'Срок покрытия разовых затрат, месяцев', absent: 'Не рассчитывается при текущих допущениях', excludes: 'Не включает выручку, налоги и стоимость времени собственника. Их необходимо учитывать отдельно.',
  },
  en: {
    heading: 'OSMANX — assumption-based pilot plan', assumption: 'This scenario uses your assumptions. It is not a forecast or a promise of results.',
    sector: 'Industry', date: 'Created', opportunities: 'Opportunities per month', recoverablePct: 'Assumed recovery rate, %',
    contributionProfitPerOrder: 'Contribution profit per order, RUB', projectCost: 'One-time cost, RUB', recurringCost: 'Recurring monthly cost, RUB', months: 'Period, months',
    monthlyRecoveredOrders: 'Additional orders per month (calculated)', monthlyContribution: 'Monthly contribution profit, RUB', monthlyNet: 'Monthly result after recurring costs, RUB',
    periodNet: 'Period result after all entered costs, RUB', totalCost: 'Total entered costs for the period, RUB', breakEvenOrdersPerMonth: 'Orders per month to break even within the selected period',
    paybackMonths: 'Months to cover the one-time cost', absent: 'Not calculable with these assumptions', excludes: 'Revenue, taxes and the owner’s time are not included. Account for them separately.',
  },
};
const langOf = locale => locale === 'en' ? 'en' : 'ru';
const numberText = (value, locale) => value === null ? TEXT_LABELS[langOf(locale)].absent : new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'ru-RU', { maximumFractionDigits: 2 }).format(value);

export function pilotPlanText(plan, locale = 'ru') {
  const lang = langOf(locale);
  const l = TEXT_LABELS[lang];
  const lines = [l.heading, l.assumption, `${l.sector}: ${SECTOR_LABELS[lang][normalizeSector(plan.sector)]}`, `${l.date}: ${plan.createdAt}`, ''];
  for (const key of Object.keys(CALCULATOR_RULES)) lines.push(`${l[key]}: ${numberText(plan.inputs[key], lang)}`);
  lines.push('');
  for (const key of ['monthlyRecoveredOrders', 'monthlyContribution', 'monthlyNet', 'totalCost', 'periodNet', 'breakEvenOrdersPerMonth', 'paybackMonths']) lines.push(`${l[key]}: ${numberText(plan.results[key], lang)}`);
  lines.push('', l.excludes);
  return lines.join('\n');
}

const BRIEF_LIMITS = Object.freeze({ task: 1200, evidence: 1500, company: 120, name: 100, email: 254 });
export function validEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\s\x00-\x1f\x7f]/.test(value)) return false;
  const at = value.lastIndexOf('@');
  if (at < 1 || at !== value.indexOf('@')) return false;
  const local = value.slice(0, at);
  const rawDomain = value.slice(at + 1);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  if (/[\/%?#:\[\]\\]/.test(rawDomain)) return false;
  let domain;
  try { domain = new URL(`https://${rawDomain}`).hostname; } catch { return false; }
  const labels = domain.split('.');
  return labels.length >= 2 && labels.every(label => label.length >= 1 && label.length <= 63 && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)) && /^(?:[a-zA-Z]{2,63}|xn--[a-zA-Z0-9-]{2,59})$/.test(labels.at(-1));
}

export function validateBrief(input, step = 'all') {
  const fields = {};
  const errors = {};
  fields.sector = normalizeSector(input?.sector);
  if (!SECTORS.includes(input?.sector)) errors.sector = 'sector';
  for (const [key, limit] of Object.entries(BRIEF_LIMITS)) {
    const raw = input?.[key];
    fields[key] = typeof raw === 'string' ? raw.trim() : '';
    if (raw !== undefined && typeof raw !== 'string') errors[key] = 'text';
    else if (fields[key].length > limit) errors[key] = 'length';
    else if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(fields[key])) errors[key] = 'text';
    else if (['name', 'company', 'email'].includes(key) && /[\r\n]/.test(String(raw ?? ''))) errors[key] = 'text';
  }
  if (fields.task.length < 10 && !errors.task) errors.task = 'task';
  if (fields.company.length < 2 && !errors.company) errors.company = 'company';
  if (!validEmail(fields.email) && !errors.email) errors.email = 'email';
  const keys = step === 0 ? ['sector', 'task', 'evidence'] : step === 1 ? ['company', 'name', 'email'] : Object.keys(errors);
  const selected = Object.fromEntries(Object.entries(errors).filter(([key]) => keys.includes(key)));
  return { valid: Object.keys(selected).length === 0, fields, errors: selected };
}

function safePlan(plan, now) {
  if (!plan || typeof plan !== 'object') return null;
  try {
    const date = Date.parse(plan.createdAt);
    return createPilotPlan(plan.inputs, { sector: plan.sector, now: Number.isFinite(date) && date <= now + 300_000 ? date : now });
  } catch { return null; }
}

export function createBrief(input, { plan = null, now = Date.now() } = {}) {
  const result = validateBrief(input);
  if (!result.valid) throw new TypeError('Invalid project brief');
  if (!Number.isFinite(now)) throw new TypeError('Invalid brief date');
  return {
    schemaVersion: 1,
    kind: 'osmanx_project_brief',
    createdAt: new Date(now).toISOString(),
    deliveryStatus: 'prepared_locally_not_sent',
    fields: result.fields,
    pilotPlan: safePlan(plan, now),
  };
}

export function briefText(brief, locale = 'ru') {
  const lang = langOf(locale);
  const en = lang === 'en';
  const f = brief.fields;
  const lines = [en ? 'OSMANX — project brief' : 'OSMANX — бриф проекта', en ? 'Prepared locally. Not sent.' : 'Подготовлен локально. Не отправлен.', '',
    `${en ? 'Industry' : 'Отрасль'}: ${SECTOR_LABELS[lang][f.sector]}`,
    `${en ? 'Company' : 'Компания'}: ${f.company}`,
    `${en ? 'Contact name' : 'Имя'}: ${f.name || '—'}`,
    `Email: ${f.email}`, '', en ? 'Business task:' : 'Задача бизнеса:', f.task, '', en ? 'Available anonymised evidence:' : 'Доступные обезличенные данные:', f.evidence || (en ? 'Not provided yet.' : 'Пока не указаны.'), '',
    `${en ? 'Created' : 'Создан'}: ${brief.createdAt}`];
  if (brief.pilotPlan) lines.push('', pilotPlanText(brief.pilotPlan, lang));
  return lines.join('\n');
}

export function buildBriefMailto(brief, locale = 'ru') {
  const lang = langOf(locale);
  const subject = `${lang === 'en' ? 'OSMANX project brief' : 'Бриф проекта OSMANX'} — ${brief.fields.company}`;
  const start = `mailto:hello@osmanx.world?subject=${encodeURIComponent(subject)}&body=`;
  let body = briefText(brief, lang);
  let abbreviated = false;
  const ending = lang === 'en' ? '\n\nPlease see the full brief in the attached TXT or JSON file. Attach it before sending.' : '\n\nПолный бриф — в файле TXT или JSON. Прикрепите скачанный файл перед отправкой.';
  if ((start + encodeURIComponent(body)).length > 1800) {
    abbreviated = true;
    const points = Array.from(body);
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((start + encodeURIComponent(points.slice(0, middle).join('') + ending)).length <= 1800) low = middle;
      else high = middle - 1;
    }
    body = points.slice(0, low).join('') + ending;
  }
  return { url: start + encodeURIComponent(body), abbreviated };
}

export function encodeDraft(fields, plan = null, now = Date.now()) {
  if (!Number.isFinite(now)) throw new TypeError('Invalid draft date');
  const clean = { sector: normalizeSector(fields?.sector) };
  for (const [key, limit] of Object.entries(BRIEF_LIMITS)) clean[key] = typeof fields?.[key] === 'string' ? fields[key].slice(0, limit) : '';
  return JSON.stringify({ schemaVersion: 1, savedAt: now, expiresAt: now + DRAFT_TTL_MS, fields: clean, pilotPlan: safePlan(plan, now) });
}

export function decodeDraft(raw, now = Date.now()) {
  if (raw === null || raw === undefined) return { status: 'missing' };
  if (typeof raw !== 'string' || raw.length > 25_000 || !Number.isFinite(now)) return { status: 'invalid' };
  let value;
  try { value = JSON.parse(raw); } catch { return { status: 'invalid' }; }
  if (!value || value.schemaVersion !== 1 || !Number.isFinite(value.savedAt) || !Number.isFinite(value.expiresAt) || value.savedAt > now + 300_000 || value.expiresAt !== value.savedAt + DRAFT_TTL_MS || typeof value.fields !== 'object' || !value.fields) return { status: 'invalid' };
  if (now >= value.expiresAt) return { status: 'expired' };
  const fields = { sector: normalizeSector(value.fields.sector) };
  for (const [key, limit] of Object.entries(BRIEF_LIMITS)) fields[key] = typeof value.fields[key] === 'string' ? value.fields[key].slice(0, limit) : '';
  return { status: 'ready', fields, pilotPlan: safePlan(value.pilotPlan, now), savedAt: value.savedAt, expiresAt: value.expiresAt };
}
