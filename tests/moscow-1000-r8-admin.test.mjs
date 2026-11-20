import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto, createHash } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const scope = { crypto: webcrypto, btoa: value => Buffer.from(value, 'binary').toString('base64') };
runInNewContext(readFileSync(new URL('../moscow-1000/admin/ledger-workflow.js', import.meta.url), 'utf8'), { globalThis: scope, URLSearchParams, ArrayBuffer, Uint8Array, Intl, Date, Set, Error });
const flow = scope.OSMANXLedgerWorkflow;
const plain = value => JSON.parse(JSON.stringify(value));
const buffer = text => new TextEncoder().encode(text).buffer;
const digest = bytes => 'sha-256=:' + createHash('sha256').update(new Uint8Array(bytes)).digest('base64') + ':';
const page = overrides => ({ expenses: [{ id: 'a', amountRub: 1.01 }], total: 100, totalKopecks: 1800051, nextOffset: 25, revision: 7, ...overrides });

test('R8 admin: decimal input preserves kopecks including Russian comma and maximum amount', () => {
  for (const [input, expected] of [['0,01', 1], ['1.09', 109], ['0.10', 10], [' 18 400,51 ', null], ['18400,51', 1840051], ['1000000.00', 100000000], ['0001,1', 110]]) assert.equal(flow.parseKopecks(input), expected);
  assert.equal(flow.amountInput(1800051), '18000.51');
  assert.equal(flow.amountInput(1), '0.01');
  assert.match(flow.money(1800051), /18\D000,51/);
  assert.equal(flow.money(null), '—');
});

test('R8 admin: money parser refuses silent rounding, exponents, negatives and non-finite inputs', () => {
  for (const input of ['', '0', '-2', '1.001', '1e3', '1,2.3', '1.0,1', 'Infinity', '1000000.01', 1, null, '9'.repeat(30)]) assert.equal(flow.parseKopecks(input), null, String(input));
  assert.equal(flow.expenseAmount({ amountRub: 1.005 }), null);
  assert.equal(flow.expenseAmount({ amountRub: Infinity }), null);
  assert.equal(flow.expenseAmount({ amountRub: 1.01 }), 101);
  assert.equal(flow.expenseAmount({ amountKopecks: 101, amountRub: 999 }), 101);
});

test('R8 admin: edited payload retains exact amount and all fields without carrying revision or private metadata', () => {
  assert.deepEqual(plain(flow.expenseBody({ day: 10, amount: '145,67', category: ' transport ', note: ' Такси ', actor: 'ignored', expectedRevision: 99 })), { day: 10, amountRub: 145.67, category: 'transport', note: 'Такси' });
  for (const change of [{ day: 0 }, { day: 11 }, { amount: '1.001' }, { category: '' }, { note: '<script>' }, { note: 'a'.repeat(301) }]) assert.equal(flow.expenseBody({ day: 1, amount: '10', category: 'food', note: '', ...change }), null);
});

test('R8 admin: ledger filters distinguish one day from entire expedition and encode custom categories', () => {
  assert.deepEqual(Object.fromEntries(new URLSearchParams(flow.expenseQuery({ day: 4, category: 'Съёмка 100%&' }, 25))), { day: '4', category: 'Съёмка 100%&', offset: '25' });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(flow.expenseQuery({ day: 4, allDays: true }, -1))), { offset: '0' });
});

test('R8 admin: full totals come from server and never from the loaded page', () => {
  const result = flow.expensePage({ records: [], revision: null }, page(), false);
  assert.equal(result.records.length, 1);
  assert.equal(result.total, 100);
  assert.equal(result.totalKopecks, 1800051);
  assert.equal(result.nextOffset, 25);
});

test('R8 admin: pagination invalidates a changed snapshot instead of merging inconsistent records', () => {
  const previous = { records: [{ id: 'first' }], revision: 6 };
  assert.deepEqual(plain(flow.expensePage(previous, page(), true)), { reload: true });
  assert.deepEqual(previous.records, [{ id: 'first' }]);
  const same = flow.expensePage({ records: [{ id: 'a' }], revision: 7 }, page({ expenses: [{ id: 'a' }, { id: 'b' }] }), true);
  assert.deepEqual(plain(same.records), [{ id: 'a' }, { id: 'b' }]);
});

test('R8 admin: missing or malformed full totals cannot be shown as real zero', () => {
  for (const change of [{ total: null }, { totalKopecks: undefined }, { totalKopecks: -1 }, { revision: undefined }, { nextOffset: '25' }, { expenses: null }]) assert.throws(() => flow.expensePage({ records: [] }, page(change), false));
  const zero = flow.expensePage({}, page({ expenses: [], total: 0, totalKopecks: 0, nextOffset: null, revision: 0 }), false);
  assert.equal(zero.totalKopecks, 0);
});

test('R8 admin: valid export digest is checked against exact UTF-8 bytes', async () => {
  const bytes = buffer('\uFEFFимя,сумма\r\n"Кафе",123.45\r\n');
  assert.equal(await flow.verifyExport(bytes, digest(bytes)), true);
});

test('R8 admin: modified, missing-digest, empty and oversized exports fail before download', async () => {
  const bytes = buffer('private payload');
  await assert.rejects(flow.verifyExport(buffer('modified payload'), digest(bytes)), /Проверка файла/);
  for (const invalid of [null, 'sha-256=abc', 'md5=:abc:', digest(bytes) + '\r\nx: y']) await assert.rejects(flow.verifyExport(bytes, invalid), /контрольную сумму/);
  await assert.rejects(flow.verifyExport(new ArrayBuffer(0), digest(bytes)), /Размер/);
  await assert.rejects(flow.verifyExport(new ArrayBuffer(flow.MAX_EXPORT_BYTES + 1), digest(bytes)), /Размер/);
});

test('R8 admin: export metadata rejects omitted totals and preserves complete database counts', () => {
  const headers = new Headers({ 'X-Export-Revision': '12', 'X-Export-Contacts': '27', 'X-Export-Expenses': '102', 'X-Export-Quests': '14', 'X-Export-Count': '102' });
  assert.deepEqual(plain(flow.exportMetadata(headers)), { revision: 12, contacts: 27, expenses: 102, quests: 14, count: 102 });
  headers.delete('X-Export-Contacts'); assert.throws(() => flow.exportMetadata(headers));
  headers.set('X-Export-Contacts', '-1'); assert.throws(() => flow.exportMetadata(headers));
  headers.set('X-Export-Contacts', 'Infinity'); assert.throws(() => flow.exportMetadata(headers));
});

test('R8 admin: download filenames use fixed safe names with no server-supplied paths', () => {
  const date = new Date('2026-11-20T12:34:56.789Z');
  assert.equal(flow.exportFilename('contacts.csv', date), 'OSMANX_20261120T123456Z_CONTACTS.csv');
  assert.equal(flow.exportFilename('json', date), 'OSMANX_20261120T123456Z_COMMAND.json');
  assert.throws(() => flow.exportFilename('../../private', date));
  assert.throws(() => flow.exportFilename('json', new Date(NaN)));
});

test('R8 admin: audit filters encode opaque cursors and never expose query concatenation', () => {
  const cursor = 'token+with/=and&';
  assert.deepEqual(Object.fromEntries(new URLSearchParams(flow.auditQuery('expense', cursor))), { category: 'expense', cursor });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(flow.auditQuery('admin&secret=1', 'x'.repeat(2049)))), { category: 'all' });
  assert.equal(flow.auditLabels.command_expense_updated, 'Изменён расход');
  assert.equal(flow.auditLabels.command_aggregates_unpublished, 'Сводка снята с публикации');
});
