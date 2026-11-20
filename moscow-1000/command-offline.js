/* Only the reviewed public projection may be retained on a spectator device. */
(function (root) {
  'use strict';
  const KEY = 'osmanx-public-approved-r7';
  const TTL = 24 * 60 * 60 * 1000;
  const MAX_BYTES = 150000;
  const kinds = new Set(['command', 'editorial']);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);

  function normalize(kind, raw) {
    if (!kinds.has(kind)) return null;
    const value = root.OSMANXCommandData.readSnapshot(raw);
    if (!value || value.days.length > 10 || value.quests.length > 50) return null;
    if (kind === 'command') return value;
    return {...value,
      markers: Array.isArray(raw.markers) ? raw.markers.slice(0, 1000)
        .filter(m => object(m) && Number.isInteger(m.day) && m.day >= 1 && m.day <= 10 &&
          Number.isFinite(m.lat) && Math.abs(m.lat) <= 85 && Number.isFinite(m.lng) && Math.abs(m.lng) <= 180 &&
          typeof m.id === 'string' && typeof m.title === 'string')
        .map(m => ({id:m.id.slice(0,80), day:m.day, lat:m.lat, lng:m.lng, title:m.title.slice(0,90),
          summary:typeof m.summary === 'string' ? m.summary.slice(0,350) : ''})) : [],
      episodes: Array.isArray(raw.episodes) ? raw.episodes.slice(0,10)
        .filter(e => object(e) && Number.isInteger(e.day) && e.day >= 1 && e.day <= 10 &&
          typeof e.title === 'string' && typeof e.publishedAt === 'string' && Number.isFinite(Date.parse(e.publishedAt)))
        .map(e => ({day:e.day, title:e.title.slice(0,120), publishedAt:e.publishedAt})) : []
    };
  }

  function classify(kind, raw) {
    if (!kinds.has(kind) || !object(raw)) return {status:'unavailable', snapshot:null};
    if (raw.status === 'unpublished' && (kind === 'command' ? raw.ok === true : raw.schemaVersion === 3)) return {status:'unpublished', snapshot:null};
    const snapshot = normalize(kind, raw);
    return {status:snapshot ? 'published' : 'unavailable', snapshot};
  }

  function createStore(storage, {clock = Date.now, ttl = TTL} = {}) {
    let memory = {};
    const tickets = {command:0, editorial:0};
    const safeTime = value => typeof value === 'number' && Number.isFinite(value) && value <= clock() + 60000 && clock() - value <= ttl;
    function decode(raw) {
      if (typeof raw !== 'string' || raw.length > MAX_BYTES) return {};
      try {
        const parsed = JSON.parse(raw), output = {};
        if (parsed.schema !== 1 || !object(parsed.entries)) return output;
        for (const kind of kinds) {
          const entry = parsed.entries[kind];
          if (!object(entry) || !safeTime(entry.savedAt)) continue;
          const snapshot = normalize(kind, entry.snapshot);
          if (snapshot) output[kind] = {savedAt:entry.savedAt, snapshot};
        }
        return output;
      } catch { return {}; }
    }
    try { memory = decode(storage?.getItem(KEY)); } catch { /* Storage is optional. */ }
    function persist() {
      try {
        if (!Object.keys(memory).length) storage?.removeItem(KEY);
        else {
          const serialized = JSON.stringify({schema:1, entries:memory});
          if (serialized.length > MAX_BYTES) return false;
          storage?.setItem(KEY, serialized);
        }
        return !!storage;
      } catch { return false; }
    }
    // Purge rejected or expired persisted entries; a revoked copy is never restored.
    persist();
    function read(kind) {
      if (!kinds.has(kind)) return null;
      const entry = memory[kind];
      if (!entry) return null;
      if (!safeTime(entry.savedAt)) { delete memory[kind]; persist(); return null; }
      const snapshot = normalize(kind, entry.snapshot);
      return snapshot ? {savedAt:entry.savedAt, snapshot} : null;
    }
    function begin(kind) { return kinds.has(kind) ? ++tickets[kind] : null; }
    function accept(kind, raw, ticket) {
      if (ticket !== undefined && (!kinds.has(kind) || ticket !== tickets[kind])) return {status:'superseded', snapshot:null};
      const result = classify(kind, raw);
      if (result.status === 'unpublished') { delete memory[kind]; persist(); }
      if (result.status === 'published') {
        memory[kind] = {savedAt:clock(), snapshot:result.snapshot};
        persist();
      }
      return result;
    }
    function clear() { memory = {}; for (const kind of kinds) tickets[kind]++; persist(); }
    return Object.freeze({read, accept, clear, begin});
  }

  root.OSMANXPublicOffline = Object.freeze({normalize, classify, createStore, ttl:TTL});
})(typeof window === 'undefined' ? globalThis : window);
