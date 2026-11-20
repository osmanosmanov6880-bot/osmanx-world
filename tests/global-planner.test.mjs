import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALCULATOR_RULES, DEFAULT_INPUTS, DRAFT_TTL_MS, SECTORS,
  parsePlanNumber, validateCalculator, calculatePilot, createPilotPlan, pilotPlanText,
  normalizeSector, validEmail, validateBrief, createBrief, briefText, buildBriefMailto,
  encodeDraft, decodeDraft,
} from '../assets/global/planner.js';

const NOW = Date.UTC(2026, 10, 20, 14, 0, 0);
const fields = { sector: 'coffee', task: 'Проверить повторные визиты после первого заказа.', evidence: 'Есть обезличенные итоги за четыре недели.', company: 'Пример компании', name: 'Имя', email: 'owner@example.com' };

test('pilot: default example includes one-time cost and reports a negative three-month result', () => {
  const { valid, results: r } = calculatePilot(DEFAULT_INPUTS);
  assert.equal(valid, true);
  assert.equal(r.monthlyRecoveredOrders, 10);
  assert.equal(r.monthlyContribution, 5000);
  assert.equal(r.monthlyNet, 5000);
  assert.equal(r.periodNet, -10000);
  assert.equal(r.breakEvenOrdersPerMonth, 17);
  assert.equal(r.breakEvenRecoveryPct, 17);
  assert.equal(r.paybackMonths, 5);
  assert.equal(r.outcome, 'negative');
});

test('pilot: recurring costs affect both the period result and break-even, without double-counting setup', () => {
  const { results: r } = calculatePilot({ ...DEFAULT_INPUTS, opportunities: 200, recoverablePct: 15, projectCost: 20000, recurringCost: 5000 });
  assert.equal(r.monthlyRecoveredOrders, 30);
  assert.equal(r.monthlyContribution, 15000);
  assert.equal(r.monthlyNet, 10000);
  assert.equal(r.periodOperatingCost, 15000);
  assert.equal(r.totalCost, 35000);
  assert.equal(r.periodNet, 10000);
  assert.equal(r.breakEvenOrdersPerMonth, 24);
  assert.equal(r.paybackMonths, 2);
});

test('pilot: a recurring loss cannot produce a fictitious payback period', () => {
  const { results: r } = calculatePilot({ ...DEFAULT_INPUTS, recurringCost: 6000 });
  assert.equal(r.monthlyNet, -1000);
  assert.equal(r.periodNet, -28000);
  assert.equal(r.paybackMonths, null);
  assert.equal(r.outcome, 'negative');
});

test('pilot: zero margin, zero opportunities and zero assumed recovery stay finite and explicit', () => {
  const noMargin = calculatePilot({ ...DEFAULT_INPUTS, contributionProfitPerOrder: 0 }).results;
  assert.equal(noMargin.breakEvenOrdersPerMonth, null);
  assert.equal(noMargin.paybackMonths, null);
  assert.equal(noMargin.periodNet, -25000);
  const noOpportunities = calculatePilot({ ...DEFAULT_INPUTS, opportunities: 0 }).results;
  assert.equal(noOpportunities.breakEvenRecoveryPct, null);
  assert.equal(noOpportunities.targetExceedsOpportunities, true);
  const noRecovery = calculatePilot({ ...DEFAULT_INPUTS, recoverablePct: 0 }).results;
  assert.equal(noRecovery.monthlyRecoveredOrders, 0);
  assert.equal(noRecovery.paybackMonths, null);
  const noCosts = calculatePilot({ ...DEFAULT_INPUTS, contributionProfitPerOrder: 0, projectCost: 0 }).results;
  assert.equal(noCosts.breakEvenOrdersPerMonth, 0);
  assert.equal(noCosts.outcome, 'zero');
  assert.ok(!JSON.stringify([noMargin, noOpportunities, noRecovery, noCosts]).includes('Infinity'));
});

test('pilot: decimal contribution is rounded once per month using integer monetary arithmetic', () => {
  const r = calculatePilot({ ...DEFAULT_INPUTS, opportunities: 10, recoverablePct: 12.5, contributionProfitPerOrder: 10.01, projectCost: 0 }).results;
  assert.equal(r.monthlyRecoveredOrders, 1.25);
  assert.equal(r.monthlyContribution, 12.51);
  assert.equal(r.periodContribution, 37.53);
  assert.equal(r.periodNet, 37.53);
  assert.equal(r.paybackMonths, 0);
});

test('pilot: all supported upper bounds remain within safe monetary integer precision', () => {
  const input = Object.fromEntries(Object.entries(CALCULATOR_RULES).map(([key, rule]) => [key, rule.max]));
  const result = calculatePilot(input);
  assert.equal(result.valid, true);
  for (const key of ['monthlyContribution', 'monthlyNet', 'periodContribution', 'periodOperatingCost', 'totalCost', 'periodNet']) {
    assert.equal(Number.isFinite(result.results[key]), true, key);
    assert.equal(Number.isSafeInteger(Math.round(result.results[key] * 100)), true, key);
  }
});

test('numbers: decimal commas and grouped RUB values are accepted; strings cannot inject expressions', () => {
  assert.deepEqual(parsePlanNumber('1\u202f250,50'), { value: 1250.5 });
  assert.deepEqual(parsePlanNumber('0,25'), { value: .25 });
  assert.deepEqual(parsePlanNumber('12.50'), { value: 12.5 });
  for (const invalid of ['1e3', 'Infinity', '10 + 20', '1,2.3', '<img>', '1\n2', {}, []]) assert.ok(parsePlanNumber(invalid).error);
  assert.equal(parsePlanNumber('  ').error, 'required');
  assert.equal(parsePlanNumber(NaN).error, 'number');
  assert.equal(parsePlanNumber(Infinity).error, 'number');
  assert.equal(parsePlanNumber(1.123).error, 'precision');
});

test('calculator validation reports every invalid field and rejects out-of-range assumptions', () => {
  const v = validateCalculator({ opportunities: -1, recoverablePct: 101, contributionProfitPerOrder: 1_000_001, projectCost: '', recurringCost: -1, months: 1.5 });
  assert.equal(v.valid, false);
  assert.deepEqual(v.errors, { opportunities: 'min', recoverablePct: 'max', contributionProfitPerOrder: 'max', projectCost: 'required', recurringCost: 'min', months: 'integer' });
  assert.equal(calculatePilot({ ...DEFAULT_INPUTS, months: 0 }).valid, false);
  assert.throws(() => createPilotPlan({}), /Invalid pilot/);
});

test('plan export is explicitly an assumption, uses RUB and only contains allowed input fields', () => {
  const plan = createPilotPlan({ ...DEFAULT_INPUTS, email: 'private@example.com', secret: 'do-not-copy' }, { sector: 'other', now: NOW });
  assert.equal(plan.sector, 'other');
  assert.equal(plan.currency, 'RUB');
  assert.equal(plan.assumptionsNotForecast, true);
  assert.equal(plan.createdAt, '2026-11-20T14:00:00.000Z');
  assert.ok(!JSON.stringify(plan).includes('private@example.com'));
  assert.match(pilotPlanText(plan, 'ru'), /не прогноз/);
  assert.match(pilotPlanText(plan, 'en'), /not a forecast/);
  assert.match(pilotPlanText(plan, 'en'), /Other industry/);
});

test('industry validation supports four priority sectors and a distinct other option', () => {
  assert.deepEqual(SECTORS, ['coffee', 'restaurants', 'retail', 'dental', 'other']);
  assert.equal(normalizeSector('other'), 'other');
  assert.equal(validateBrief({ ...fields, sector: 'other' }).valid, true);
  assert.equal(validateBrief({ ...fields, sector: 'unpublished-sector' }).errors.sector, 'sector');
});

test('brief steps validate their own fields but final review requires both task and reply contact', () => {
  const taskOnly = { sector: 'retail', task: 'Проверить спрос на отсутствующий размер.' };
  assert.equal(validateBrief(taskOnly, 0).valid, true);
  assert.equal(validateBrief(taskOnly).valid, false);
  assert.equal(validateBrief({ ...fields, evidence: '', name: '' }).valid, true);
  assert.equal(validateBrief({ ...fields, task: 'мало' }).errors.task, 'task');
  assert.equal(validateBrief({ ...fields, evidence: 'a'.repeat(1501) }).errors.evidence, 'length');
  assert.equal(validateBrief({ ...fields, company: 'a' }).errors.company, 'company');
  assert.equal(validateBrief({ ...fields, company: 'Company\nInjected header' }).errors.company, 'text');
  assert.throws(() => createBrief(taskOnly), /Invalid project brief/);
});

test('email validation allows common business addresses and blocks malformed or header-injection input', () => {
  for (const email of ['owner@example.com', 'owner+pilot@sub.example.co.uk', 'a.b@example.world', 'owner@пример.рф', 'owner@xn--e1afmkfd.xn--p1ai']) assert.equal(validEmail(email), true, email);
  for (const email of ['owner', 'owner@localhost', '.a@example.com', 'a..b@example.com', 'owner@-example.com', 'owner@example-.com', 'x@example.com\r\nBcc:y@example.com', 'x@example.com?bcc=y@example.com', 'x@example%2ecom', 'x@example.com/path', 'a'.repeat(65) + '@example.com']) assert.equal(validEmail(email), false, email);
});

test('brief export describes local preparation, preserves user text as data and has no delivery claim', () => {
  const brief = createBrief({ ...fields, task: 'Проверить текст <script>alert(1)</script> как данные.' }, { now: NOW });
  assert.equal(brief.deliveryStatus, 'prepared_locally_not_sent');
  assert.equal(brief.fields.task, 'Проверить текст <script>alert(1)</script> как данные.');
  assert.match(briefText(brief), /Не отправлен/);
  assert.match(briefText(brief, 'en'), /Not sent/);
  assert.equal(brief.pilotPlan, null);
});

test('brief plan attachment recalculates tampered results instead of trusting stored amounts', () => {
  const plan = createPilotPlan(DEFAULT_INPUTS, { now: NOW });
  plan.results.periodNet = 999999999;
  const brief = createBrief(fields, { plan, now: NOW });
  assert.equal(brief.pilotPlan.results.periodNet, -10000);
  assert.equal(createBrief(fields, { plan: { inputs: { opportunities: 'bad' } }, now: NOW }).pilotPlan, null);
});

test('mailto uses only the fixed recipient and percent-encodes all user-controlled text', () => {
  const brief = createBrief({ ...fields, company: 'Компания & subject=другое', task: 'Задача ?bcc=person@example.com — только текст.' }, { now: NOW });
  const mail = buildBriefMailto(brief);
  assert.ok(mail.url.startsWith('mailto:hello@osmanx.world?subject='));
  const query = new URLSearchParams(mail.url.split('?').slice(1).join('?'));
  assert.deepEqual([...query.keys()], ['subject', 'body']);
  assert.ok(query.get('subject').includes('Компания & subject=другое'));
  assert.ok(mail.url.length <= 1800);
});

test('long multilingual briefs get a bounded mail draft and explicit attachment instruction', () => {
  const brief = createBrief({ ...fields, company: 'Я'.repeat(120), task: 'Описание '.repeat(130).slice(0, 1200), evidence: 'Данные '.repeat(200).slice(0, 1500) }, { now: NOW });
  for (const locale of ['ru', 'en']) {
    const mail = buildBriefMailto(brief, locale);
    assert.equal(mail.abbreviated, true);
    assert.ok(mail.url.length <= 1800);
    assert.doesNotThrow(() => decodeURIComponent(mail.url));
    assert.match(decodeURIComponent(mail.url), locale === 'ru' ? /Прикрепите скачанный файл/ : /Attach it before sending/);
  }
});

test('draft can preserve incomplete work, restores for seven days and expires exactly at the deadline', () => {
  const raw = encodeDraft({ sector: 'other', task: 'Не закончил', company: '', email: 'incomplete@' }, null, NOW);
  assert.equal(decodeDraft(raw, NOW).status, 'ready');
  assert.equal(decodeDraft(raw, NOW).fields.email, 'incomplete@');
  assert.equal(decodeDraft(raw, NOW + DRAFT_TTL_MS - 1).status, 'ready');
  assert.equal(decodeDraft(raw, NOW + DRAFT_TTL_MS).status, 'expired');
});

test('draft parser rejects corruption, oversized data, future timestamps and extended retention', () => {
  assert.equal(decodeDraft(null, NOW).status, 'missing');
  assert.equal(decodeDraft('{bad', NOW).status, 'invalid');
  assert.equal(decodeDraft('x'.repeat(25001), NOW).status, 'invalid');
  const value = JSON.parse(encodeDraft(fields, null, NOW));
  value.expiresAt += 1;
  assert.equal(decodeDraft(JSON.stringify(value), NOW).status, 'invalid');
  assert.equal(decodeDraft(encodeDraft(fields, null, NOW + 600000), NOW).status, 'invalid');
});

test('draft boundaries ignore extra fields, bound user text and recompute calculator data', () => {
  const plan = createPilotPlan(DEFAULT_INPUTS, { now: NOW });
  const value = JSON.parse(encodeDraft({ ...fields, password: 'never-store' }, plan, NOW));
  assert.ok(!JSON.stringify(value).includes('never-store'));
  value.fields.evidence = 'x'.repeat(2000);
  value.fields.admin = true;
  value.pilotPlan.results.periodNet = 123456;
  const restored = decodeDraft(JSON.stringify(value), NOW);
  assert.equal(restored.status, 'ready');
  assert.equal(restored.fields.evidence.length, 1500);
  assert.equal(restored.fields.admin, undefined);
  assert.equal(restored.pilotPlan.results.periodNet, -10000);
});
