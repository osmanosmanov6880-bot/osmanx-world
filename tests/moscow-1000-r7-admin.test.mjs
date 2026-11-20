import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const scope = { crypto: webcrypto };
runInNewContext(readFileSync(new URL('../moscow-1000/admin/contact-workflow.js', import.meta.url), 'utf8'), { globalThis: scope, URLSearchParams, TextEncoder, Uint8Array, Date, Promise, Set, Error });
const flow = scope.OSMANXContactWorkflow;
const plain = value => JSON.parse(JSON.stringify(value));
const instant = Date.parse('2026-11-20T12:00:00Z');
const a = { email: 'owner@example.test', provider: 'google' };
const b = { email: 'another@example.test', provider: 'google' };
const requestKey = 'ba15bb8f-fc37-41aa-9990-06de9dc1b150';
const body = { day: 2, name: 'Кафе Маяк', category: 'HoReCa', person: 'Анна', channel: '@private', outcome: 'interest', problem: 'Теряют повторных гостей\nНужно проверить причины', nextStep: 'Отправить предложение' };
const draft = overrides => ({ schema: 1, updatedAt: instant, key: requestKey, body: { ...body }, editing: null, detailed: false, persistent: true, pending: null, ...overrides });
function storage() {
  const entries = new Map();
  return { entries, get: async key => entries.get(key), set: async (key, value) => { entries.set(key, structuredClone(plain(value))); }, remove: async key => { entries.delete(key); } };
}
function vault(db, options = {}) { return flow.createVault(db, { now: () => instant, ...options }); }

test('R7 admin: saved draft is restored only to the same verified account and provider', async () => {
  const db = storage(); const store = vault(db);
  await store.write(a, draft());
  assert.deepEqual(plain((await store.read(a)).body), body);
  assert.equal(await store.read(b), null);
  assert.equal(await store.read({ ...a, provider: 'access' }), null);
  assert.equal((await store.read({ ...a, email: 'OWNER@EXAMPLE.TEST' })).body.name, body.name);
  const key = [...db.entries.keys()][0];
  assert.match(key, /^contact-v1:[a-f0-9]{64}$/);
  assert.ok(!key.includes(a.email));
});

test('R7 admin: persistent saving requires explicit opt-in and meaningful form data', async () => {
  const db = storage(); const store = vault(db);
  await assert.rejects(store.write(a, draft({ persistent: false })));
  await assert.rejects(store.write(a, draft({ body: { ...body, name: '', category: '', person: '', channel: '', problem: '', nextStep: '' } })));
  assert.equal(db.entries.size, 0);
});

test('R7 admin: logout erases only the active account draft', async () => {
  const db = storage(); const store = vault(db);
  await store.write(a, draft()); await store.write(b, draft({ body: { ...body, name: 'Другой владелец' } }));
  await store.remove(a);
  assert.equal(await store.read(a), null);
  assert.equal((await store.read(b)).body.name, 'Другой владелец');
});

test('R7 admin: an in-flight autosave cannot resurrect a draft after logout', async () => {
  const db = storage(); let release;
  const wait = new Promise(resolve => { release = resolve; });
  const original = db.set;
  db.set = async (...args) => { await wait; return original(...args); };
  const store = vault(db);
  const saving = store.write(a, draft());
  const clearing = store.remove(a);
  release(); await Promise.all([saving, clearing]);
  assert.equal(await store.read(a), null);
  assert.equal(db.entries.size, 0);
});

test('R7 admin: expired and transplanted drafts are removed without exposing their fields', async () => {
  const db = storage(); const store = vault(db);
  await store.write(a, draft());
  const key = [...db.entries.keys()][0];
  db.entries.get(key).draft.updatedAt = instant - flow.MAX_AGE;
  assert.equal(await store.read(a), null); assert.equal(db.entries.size, 0);
  await store.write(a, draft());
  db.entries.get(key).owner = await flow.ownerKey(b);
  assert.equal(await store.read(a), null); assert.equal(db.entries.size, 0);
});

test('R7 admin: lost-response recovery preserves the original body and idempotency key', async () => {
  const db = storage(); const store = vault(db);
  const pending = { key: requestKey, body: { ...body } };
  await store.write(a, draft({ pending }));
  const restored = await vault(db).read(a);
  assert.deepEqual(plain(restored.pending), pending);
  assert.equal(restored.key, requestKey);
  assert.equal(restored.pending.body.name, body.name);
  assert.equal(db.entries.size, 1);
});

test('R7 admin: malformed pending operations cannot become replayable drafts', () => {
  for (const value of [
    draft({ pending: { key: 'not-a-key', body } }),
    draft({ pending: { key: webcrypto.randomUUID(), body } }),
    draft({ pending: { key: requestKey, body: { ...body, name: '' } } }),
    draft({ editing: { id: webcrypto.randomUUID(), revision: 1 }, pending: { key: requestKey, body } }),
  ]) assert.equal(flow.normalizeDraft(value, instant), null);
});

test('R7 admin: persisted contact data uses a field allowlist and never retains token properties', async () => {
  const db = storage(); const store = vault(db);
  await store.write(a, draft({ accessToken: 'secret', cookie: 'secret', body: { ...body, authToken: 'secret', ownerEmail: 'secret' }, pending: { key: requestKey, body: { ...body, token: 'secret' }, bearer: 'secret' } }));
  const serialized = JSON.stringify([...db.entries.values()]);
  assert.doesNotMatch(serialized, /accessToken|authToken|bearer|cookie|ownerEmail|secret/);
  assert.equal((await store.read(a)).body.channel, '@private', 'The opted-in contact field itself must survive recovery.');
});

test('R7 admin: damaged, oversized, future or anonymous draft inputs fail closed', async () => {
  for (const value of [draft({ schema: 0 }), draft({ updatedAt: instant + 60001 }), draft({ body: { ...body, day: 11 } }), draft({ body: { ...body, name: 'x'.repeat(121) } }), draft({ body: { ...body, outcome: 'admin' } }), draft({ editing: { id: webcrypto.randomUUID(), revision: 0 } })]) assert.equal(flow.normalizeDraft(value, instant), null);
  await assert.rejects(vault(storage()).read({ email: a.email }));
  await assert.rejects(vault(storage()).write({}, draft()));
});

test('R7 admin: a quota failure is surfaced and does not poison subsequent logout', async () => {
  const db = storage(); const store = vault(db);
  db.set = async () => { throw Error('quota exceeded'); };
  await assert.rejects(store.write(a, draft()), /quota exceeded/);
  await store.remove(a);
  assert.equal(db.entries.size, 0);
});

test('R7 admin: search query preserves Russian text and literal wildcard characters', () => {
  const value = flow.contactQuery({ day: 4, q: '  Кофе 100%_Москва  ', outcome: 'interest', followup: 'pending' }, 25);
  const query = new URLSearchParams(value);
  assert.deepEqual(Object.fromEntries(query), { day: '4', offset: '25', q: 'Кофе 100%_Москва', outcome: 'interest', followup: 'pending' });
  assert.equal(new URLSearchParams(flow.contactQuery({ day: 1, q: '', outcome: 'unknown', followup: 'all' }, -1)).get('offset'), '0');
});

test('R7 admin: editing draft retains optimistic revision for conflict detection', async () => {
  const db = storage(); const store = vault(db);
  const editing = { id: webcrypto.randomUUID(), revision: 7 };
  await store.write(a, draft({ editing }));
  assert.deepEqual(plain((await store.read(a)).editing), editing);
});

test('R7 admin: expired-read cleanup cannot erase a newer queued autosave', async () => {
  const db = storage(); const store = vault(db);
  await store.write(a, draft());
  const key = [...db.entries.keys()][0];
  db.entries.get(key).draft.updatedAt = instant - flow.MAX_AGE;
  const reading = store.read(a);
  const saving = store.write(a, draft({ body: { ...body, name: 'Новая запись' } }));
  assert.equal(await reading, null);
  await saving;
  assert.equal((await store.read(a)).body.name, 'Новая запись');
});
