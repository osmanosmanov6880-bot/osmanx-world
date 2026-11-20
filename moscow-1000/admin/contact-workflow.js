/* Draft storage contains form fields only. It never authenticates a visitor or stores tokens. */
((root) => {
  'use strict';
  const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
  const limits = { name: 120, category: 80, person: 100, channel: 200, problem: 1000, nextStep: 500 };
  const outcomes = new Set(['visited', 'dialogue', 'interest', 'refusal', 'meeting', 'pilot', 'contract']);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function fields(value) {
    if (!plain(value) || !Number.isInteger(value.day) || value.day < 1 || value.day > 10 || !outcomes.has(value.outcome)) return null;
    const result = { day: value.day, outcome: value.outcome };
    for (const [key, max] of Object.entries(limits)) {
      if (typeof value[key] !== 'string' || value[key].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value[key])) return null;
      result[key] = value[key];
    }
    return result;
  }

  function normalizeDraft(value, now = Date.now()) {
    if (!plain(value) || value.schema !== 1 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt > now + 60000 || value.updatedAt <= now - MAX_AGE) return null;
    const body = fields(value.body);
    if (!body || !uuid.test(value.key || '')) return null;
    const editing = value.editing === null ? null : plain(value.editing) && uuid.test(value.editing.id || '') && Number.isSafeInteger(value.editing.revision) && value.editing.revision > 0
      ? { id: value.editing.id, revision: value.editing.revision } : undefined;
    if (editing === undefined) return null;
    let pending = null;
    if (value.pending !== null && value.pending !== undefined) {
      const submitted = fields(value.pending.body);
      if (editing || !submitted || !submitted.name.trim() || !uuid.test(value.pending.key || '') || value.pending.key !== value.key) return null;
      pending = { key: value.pending.key, body: submitted };
    }
    return { schema: 1, updatedAt: value.updatedAt, body, editing, key: value.key, detailed: value.detailed === true, persistent: value.persistent === true, pending };
  }

  function meaningful(body) {
    return Object.keys(limits).some(key => typeof body?.[key] === 'string' && body[key].trim());
  }

  function contactQuery({ day, q = '', outcome = '', followup = 'all' }, offset = 0) {
    const params = new URLSearchParams();
    if (Number.isInteger(day) && day >= 1 && day <= 10) params.set('day', String(day));
    params.set('offset', String(Number.isSafeInteger(offset) && offset >= 0 ? offset : 0));
    if (q.trim()) params.set('q', q.trim().slice(0, 120));
    if (outcomes.has(outcome)) params.set('outcome', outcome);
    if (['pending', 'none'].includes(followup)) params.set('followup', followup);
    return params.toString();
  }

  async function ownerKey(actor, digest = async text => {
    const bytes = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
  }) {
    if (!plain(actor) || typeof actor.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor.email) || !['google', 'access'].includes(actor.provider)) throw Error('Для черновика требуется подтверждённый аккаунт.');
    return 'contact-v1:' + await digest(actor.provider + '\n' + actor.email.trim().toLowerCase());
  }

  function createVault(storage, options = {}) {
    const clock = options.now || Date.now;
    const key = actor => ownerKey(actor, options.digest);
    let writeQueue = Promise.resolve();
    const ordered = task => { const result = writeQueue.catch(() => {}).then(task); writeQueue = result; return result; };
    return Object.freeze({
      read(actor) { return ordered(async () => {
        const owner = await key(actor);
        const stored = await storage.get(owner);
        if (!stored) return null;
        const draft = stored.owner === owner ? normalizeDraft(stored.draft, clock()) : null;
        if (!draft || draft.persistent !== true) {
          if (storage.removeIf) await storage.removeIf(owner, stored);
          else await storage.remove(owner);
          return null;
        }
        return draft;
      }); },
      write(actor, value) { return ordered(async () => {
        const owner = await key(actor);
        const draft = normalizeDraft(value, clock());
        if (!draft || draft.persistent !== true || !meaningful(draft.body)) throw Error('Черновик не сохранён: проверьте поля и разрешение на хранение.');
        await storage.set(owner, { owner, draft });
        return draft;
      }); },
      remove(actor) { return ordered(async () => { const owner = await key(actor); await storage.remove(owner); }); },
    });
  }

  function browserVault() {
    let connection;
    const open = () => {
      if (!connection) connection = new Promise((resolve, reject) => {
        if (!root.indexedDB) { reject(Error('Браузер не поддерживает сохранение черновиков.')); return; }
        const request = root.indexedDB.open('osmanx-private-drafts-v1', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('drafts');
        request.onerror = () => reject(Error('Браузер запретил сохранение черновиков.'));
        request.onblocked = () => reject(Error('Закройте другие вкладки штаба и повторите.'));
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); connection = null; };
          resolve(db);
        };
      }).catch(error => { connection = null; throw error; });
      return connection;
    };
    const transaction = async (mode, action) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('drafts', mode);
        let result;
        const request = action(tx.objectStore('drafts'));
        request.onsuccess = () => { result = request.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(Error('Не удалось сохранить черновик на устройстве. Освободите место или отключите сохранение.'));
      });
    };
    const removeIf = async (id, expected) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('drafts', 'readwrite'), store = tx.objectStore('drafts');
        const request = store.get(id);
        request.onsuccess = () => { if (JSON.stringify(request.result) === JSON.stringify(expected)) store.delete(id); };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(Error('Не удалось очистить устаревший черновик.'));
      });
    };
    return createVault({ get: id => transaction('readonly', store => store.get(id)), set: (id, value) => transaction('readwrite', store => store.put(value, id)), remove: id => transaction('readwrite', store => store.delete(id)), removeIf });
  }

  root.OSMANXContactWorkflow = Object.freeze({ MAX_AGE, fields, meaningful, normalizeDraft, contactQuery, ownerKey, createVault, browserVault });
})(globalThis);
