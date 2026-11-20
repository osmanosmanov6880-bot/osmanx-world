/* Public URLs and explicitly saved viewer bookmarks. No CRM or tracking data. */
(function (root) {
  'use strict';
  const VIEWS = ['hq', 'map', 'analytics', 'journal', 'quests'];
  const ANALYSIS = ['summary', 'funnel', 'segments', 'budget'];
  const JOURNAL = ['all', 'published', 'planned'];
  const PATH = '/moscow-1000/';
  const KEY = 'osmanx.viewer.bookmarks.v1';
  const LIMIT = 20;
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  function normalize(value) {
    value = plain(value) ? value : {};
    const day = Number.isInteger(value.day) && value.day >= 1 && value.day <= 10 ? value.day : 1;
    const view = VIEWS.includes(value.view) ? value.view : 'hq';
    let point = view === 'map' && typeof value.point === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value.point) ? value.point : null;
    // Plan anchors belong to a particular day; a copied URL cannot silently select another day.
    if (/^area-\d+-\d+$/.test(point||'') && !new RegExp('^area-' + day + '-\\d{1,2}$').test(point)) point = null;
    return {
      day, view, point,
      analysis: view === 'analytics' && ANALYSIS.includes(value.analysis) ? value.analysis : 'summary',
      journal: view === 'journal' && JOURNAL.includes(value.journal) ? value.journal : 'all'
    };
  }
  function parse(href) {
    try {
      const url = new URL(href, 'https://osmanx.invalid');
      return normalize({day: Number(url.searchParams.get('day')), view: url.hash.slice(1), point: url.searchParams.get('point'), analysis: url.searchParams.get('tab'), journal: url.searchParams.get('tab')});
    } catch { return normalize(null); }
  }
  function path(value) {
    const route = normalize(value), query = new URLSearchParams({day: String(route.day)});
    if (route.view === 'analytics' && route.analysis !== 'summary') query.set('tab', route.analysis);
    if (route.view === 'journal' && route.journal !== 'all') query.set('tab', route.journal);
    if (route.point) query.set('point', route.point);
    return PATH + '?' + query + '#' + route.view;
  }
  function shareURL(value, origin) {
    try {
      const base = new URL(origin);
      if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) return null;
      // Drop unrelated query parameters, fragments, credentials and paths from the base URL.
      return base.origin + path(value);
    } catch { return null; }
  }
  function equal(left, right) { return path(left) === path(right); }
  function createStore(storage) {
    function read() {
      try {
        const raw = storage?.getItem(KEY);
        if (!raw || raw.length > 20000) return [];
        const payload = JSON.parse(raw);
        if (payload?.schema !== 1 || !Array.isArray(payload.items)) return [];
        const items = [], seen = new Set();
        for (const item of payload.items.slice(0, 100)) {
          if (!plain(item) || !plain(item.route) || !VIEWS.includes(item.route.view) || !Number.isInteger(item.route.day) || item.route.day < 1 || item.route.day > 10 || typeof item.savedAt !== 'string' || !Number.isFinite(Date.parse(item.savedAt))) continue;
          const route = normalize(item.route), id = path(route);
          if (seen.has(id)) continue;
          seen.add(id);items.push({id, route, savedAt: item.savedAt});
          if (items.length === LIMIT) break;
        }
        return items;
      } catch { return []; }
    }
    function write(items) {
      try {
        if (!storage) return false;
        storage.setItem(KEY, JSON.stringify({schema:1, items:items.map(item => ({route:normalize(item.route),savedAt:item.savedAt}))}));
        return true;
      } catch { return false; }
    }
    function add(value, now = Date.now()) {
      const route = normalize(value), id = path(route), items = read();
      if (items.some(item => item.id === id)) return {ok:true,status:'exists',items};
      if (items.length >= LIMIT) return {ok:false,status:'full',items};
      const date = new Date(now);
      if (!Number.isFinite(date.getTime())) return {ok:false,status:'unavailable',items};
      const next = [{id,route,savedAt:date.toISOString()},...items];
      return write(next) ? {ok:true,status:'saved',items:next} : {ok:false,status:'unavailable',items};
    }
    function remove(id) {
      const items=read(),next=items.filter(item=>item.id!==id);
      return next.length === items.length || write(next);
    }
    return Object.freeze({read,add,remove});
  }
  root.OSMANXNavigation = Object.freeze({normalize,parse,path,shareURL,equal,createStore,key:KEY,limit:LIMIT});
})(typeof window === 'undefined' ? globalThis : window);
