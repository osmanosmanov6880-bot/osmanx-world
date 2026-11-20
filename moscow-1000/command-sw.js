/* Public shell only. Admin pages, APIs, OAuth, contacts and map tiles are excluded. */
(function (root) {
  'use strict';
  const CACHE = 'osmanx-public-shell-r8.3';
  const HOME = '/moscow-1000/';
  const ASSETS = [HOME, '/moscow-1000/command.css', '/moscow-1000/command-map.css',
    '/moscow-1000/content.js', '/moscow-1000/geo.js', '/moscow-1000/publication.js',
    '/moscow-1000/command-data.js', '/moscow-1000/command-offline.js', '/moscow-1000/command-navigation.js', '/moscow-1000/command-map.js',
    '/moscow-1000/command.js', '/moscow-1000/mark.svg', '/moscow-1000/reference/moscow-skyline.png',
    '/moscow-1000/command.webmanifest'];
  const allowed = new Set(ASSETS);
  function cachePath(requestURL, origin, method = 'GET') {
    try {
      const url = new URL(requestURL, origin);
      if (method !== 'GET' || url.origin !== origin || url.username || url.password) return null;
      const path = url.pathname === '/moscow-1000/index.html' ? HOME : url.pathname;
      return allowed.has(path) ? path : null;
    } catch { return null; }
  }
  root.OSMANXPublicSWPolicy = Object.freeze({cachePath, assets:[...ASSETS]});
  if (typeof root.addEventListener !== 'function' || !root.registration || !root.caches) return;

  async function approvedResponse(path, response) {
    if (!response.ok || response.redirected || response.type === 'opaque') return false;
    const type = response.headers.get('content-type') || '';
    if (path === HOME) {
      if (!type.includes('text/html')) return false;
      const html = await response.clone().text();
      return html.includes('id="view-hq"') && html.includes('command-offline.js');
    }
    if (path.endsWith('.js')) return /javascript/.test(type);
    if (path.endsWith('.css')) return type.includes('text/css');
    if (path.endsWith('.webmanifest')) return /json|manifest/.test(type);
    return type.startsWith('image/');
  }
  root.addEventListener('install', event => {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      for (const path of ASSETS) {
        const response = await fetch(new Request(path, {credentials:'same-origin', cache:'reload'}));
        if (!await approvedResponse(path, response)) throw Error('Public shell unavailable');
        await cache.put(path, response);
      }
      await root.skipWaiting();
    })());
  });
  root.addEventListener('activate', event => {
    event.waitUntil((async () => {
      for (const key of await caches.keys()) if (key.startsWith('osmanx-public-shell-') && key !== CACHE) await caches.delete(key);
      await root.clients.claim();
    })());
  });
  root.addEventListener('fetch', event => {
    const path = cachePath(event.request.url, root.location.origin, event.request.method);
    if (!path) return;
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const saved = await cache.match(path);
      if (saved) return saved;
      return fetch(event.request);
    })());
  });
})(globalThis);
