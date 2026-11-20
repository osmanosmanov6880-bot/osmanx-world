/* OSMANX Command: real public area coordinates, visible OSM tiles only. */
(function (root) {
  'use strict';

  const TILE = 256;
  const MIN_ZOOM = 11;
  const MAX_ZOOM = 18;
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  const icons = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 5 9 5 9-5"/>',
    pin: '<path d="M19 10c0 5-7 12-7 12S5 15 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    cross: '<path d="m6 6 12 12M6 18 18 6"/>',
    location: '<path d="m21 3-6 18-4-8-8-4 18-6Z"/>'
  };

  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
  }

  function project(lat, lng, zoom) {
    const size = TILE * 2 ** zoom;
    const sin = Math.sin(clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180);
    return { x: (lng + 180) / 360 * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
  }

  function unproject(x, y, zoom) {
    const size = TILE * 2 ** zoom;
    return { lat: clamp(Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI, -85, 85), lng: ((x / size * 360 % 360) + 360) % 360 - 180 };
  }

  function safeMarkers(markers) {
    if (!Array.isArray(markers)) return [];
    return markers.filter(marker => marker && Number.isInteger(marker.day) && marker.day >= 1 && marker.day <= 10 && Number.isFinite(marker.lat) && Number.isFinite(marker.lng) && marker.lat > 55.5 && marker.lat < 56 && marker.lng > 37 && marker.lng < 38.2 && typeof marker.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(marker.id) && typeof marker.title === 'string').slice(0,200).map(marker => ({ id: marker.id, day: marker.day, lat: marker.lat, lng: marker.lng, label: marker.title.slice(0,160), summary: typeof marker.summary === 'string' ? marker.summary.slice(0,400) : '', reviewed: true }));
  }

  function mount(container, options) {
    options = options || {};
    if (!container || typeof container.replaceChildren !== 'function') throw new TypeError('Map container is required');
    const days = root.OSMANX_GEO && root.OSMANX_GEO.days;
    if (!Array.isArray(days) || !days.length) throw new Error('OSMANX public geography is missing');
    if (container.__osmanxMap) container.__osmanxMap.destroy();

    const state = { day: 1, zoom: 15, lat: 55.75, lng: 37.62, selected: null, dark: true, alive: true };
    let reviewed = safeMarkers(options.markers);
    let frame = 0;
    let fitPending = false;
    let loadTimer = null;
    let dragging = null;
    let pinch = null;
    const pointers = new Map();
    const tiles = new Map();
    const listeners = [];

    const shell = document.createElement('div');
    shell.className = 'ox-command-map';
    shell.innerHTML = '<div class="ox-map-canvas" tabindex="0" role="region" aria-label="Карта Москвы. Перемещение стрелками, масштаб — клавишами плюс и минус.">' +
      '<div class="ox-map-grid" aria-hidden="true"></div><div class="ox-map-tiles" aria-hidden="true"></div>' +
      '<svg class="ox-map-connections" aria-hidden="true"><path class="ox-map-line-glow"></path><path class="ox-map-line"></path></svg>' +
      '<div class="ox-map-pins"></div><span class="ox-map-plan-label">ПЛАН ДНЯ</span>' +
      '<button class="ox-map-layer ox-map-tool" type="button" aria-label="Переключить светлую карту" aria-pressed="true">' + icon('layers') + '</button>' +
      '<div class="ox-map-tools"><div class="ox-map-zoom"><button type="button" class="ox-map-tool" data-map-action="in" aria-label="Приблизить карту">' + icon('plus') + '</button><button type="button" class="ox-map-tool" data-map-action="out" aria-label="Отдалить карту">' + icon('minus') + '</button></div><button type="button" class="ox-map-tool" data-map-action="fit" aria-label="Показать весь план дня">' + icon('target') + '</button></div>' +
      '<div class="ox-map-unavailable" role="status" hidden><strong>Карта не загрузилась</strong><span>Проверьте соединение. Ориентиры доступны в списке ниже.</span><button type="button" data-map-action="retry">Повторить загрузку</button></div>' +
      '<div class="ox-map-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a></div></div>' +
      '<button type="button" class="ox-map-route" aria-expanded="false">' + icon('pin') + '<span><strong class="ox-map-route-title"></strong><small class="ox-map-route-detail"></small></span>' + icon('chevron') + '</button>' +
      '<button type="button" class="ox-map-list-toggle" aria-expanded="false">' + icon('list') + '<span>Список ориентиров</span></button>' +
      '<div class="ox-map-point-list" hidden></div>' +
      '<p class="ox-map-note">Публичные ориентиры района. Линия соединяет точки условно и не содержит проверенных пешеходных маршрутов.</p>';
    container.replaceChildren(shell);

    const canvas = shell.querySelector('.ox-map-canvas');
    const tileLayer = shell.querySelector('.ox-map-tiles');
    const pinsLayer = shell.querySelector('.ox-map-pins');
    const connection = shell.querySelector('.ox-map-connections');
    const unavailable = shell.querySelector('.ox-map-unavailable');
    const routeButton = shell.querySelector('.ox-map-route');
    const routeTitle = shell.querySelector('.ox-map-route-title');
    const routeDetail = shell.querySelector('.ox-map-route-detail');
    const listToggle = shell.querySelector('.ox-map-list-toggle');
    const pointList = shell.querySelector('.ox-map-point-list');
    const layerButton = shell.querySelector('.ox-map-layer');

    function listen(el, event, callback, opts) {
      el.addEventListener(event, callback, opts);
      listeners.push(() => el.removeEventListener(event, callback, opts));
    }

    function route() { return days.find(day => day.number === state.day) || days[0]; }
    function allPoints() {
      return route().anchors.map((anchor, index) => ({ ...anchor, id: 'area-' + state.day + '-' + index, reviewed: false })).concat(reviewed.filter(marker => marker.day === state.day));
    }
    function osmLink(point) {
      return 'https://www.openstreetmap.org/?mlat=' + encodeURIComponent(point.lat) + '&mlon=' + encodeURIComponent(point.lng) + '#map=17/' + point.lat + '/' + point.lng;
    }

    function schedule() {
      if (!state.alive || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; renderMap(); });
    }

    function updateAvailability() {
      if (!state.alive || !tiles.size) return;
      const visible = Array.from(tiles.values());
      const loaded = visible.some(tile => tile.dataset.status === 'loaded');
      const waiting = visible.some(tile => tile.dataset.status === 'loading');
      unavailable.hidden = loaded || waiting;
      canvas.classList.toggle('ox-map-no-tiles', !loaded && !waiting);
    }

    function renderMap() {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!state.alive || !width || !height || !canvas.getClientRects().length) return;
      if (fitPending) { fitPending = false; fit(); return; }
      const center = project(state.lat, state.lng, state.zoom);
      const left = center.x - width / 2;
      const top = center.y - height / 2;
      const extent = 2 ** state.zoom;
      const needed = new Set();
      let budget = 0;
      for (let x = Math.floor(left / TILE); x <= Math.floor((left + width - 1) / TILE); x++) {
        for (let y = Math.floor(top / TILE); y <= Math.floor((top + height - 1) / TILE); y++) {
          if (y < 0 || y >= extent || ++budget > 64) continue;
          const safeX = ((x % extent) + extent) % extent;
          const key = state.zoom + '/' + x + '/' + y;
          needed.add(key);
          let tile = tiles.get(key);
          if (!tile) {
            tile = document.createElement('img');
            tile.className = 'ox-map-tile';
            tile.alt = '';
            tile.width = TILE;
            tile.height = TILE;
            tile.draggable = false;
            tile.decoding = 'async';
            tile.referrerPolicy = 'strict-origin-when-cross-origin';
            tile.dataset.status = 'loading';
            tile.onload = () => { tile.dataset.status = 'loaded'; updateAvailability(); };
            tile.onerror = () => { tile.dataset.status = 'failed'; updateAvailability(); };
            // Browser HTTP cache is respected; no prefetch, proxy, bulk download or offline tile store.
            tile.src = 'https://tile.openstreetmap.org/' + state.zoom + '/' + safeX + '/' + y + '.png';
            tiles.set(key, tile);
            tileLayer.append(tile);
          }
          tile.style.transform = 'translate(' + Math.round(x * TILE - left) + 'px,' + Math.round(y * TILE - top) + 'px)';
        }
      }
      for (const [key, tile] of tiles) {
        if (!needed.has(key)) { tile.onload = null; tile.onerror = null; tile.remove(); tiles.delete(key); }
      }
      clearTimeout(loadTimer);
      loadTimer = setTimeout(() => {
        if (Array.from(tiles.values()).some(tile => tile.dataset.status === 'loaded')) return;
        unavailable.hidden = false;
        canvas.classList.add('ox-map-no-tiles');
      }, 10000);
      updateAvailability();

      connection.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      const coordinates = route().anchors.map(point => project(point.lat, point.lng, state.zoom));
      const path = coordinates.map((point, index) => (index ? 'L' : 'M') + (point.x - left).toFixed(1) + ',' + (point.y - top).toFixed(1)).join(' ');
      connection.querySelectorAll('path').forEach(el => el.setAttribute('d', path));
      const focusedId = pinsLayer.contains(document.activeElement) ? document.activeElement.dataset.pointId : null;
      pinsLayer.replaceChildren();
      for (const point of allPoints()) {
        const position = project(point.lat, point.lng, state.zoom);
        const x = position.x - left;
        const y = position.y - top;
        if (x < -40 || x > width + 40 || y < -40 || y > height + 40) continue;
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'ox-map-pin' + (state.selected === point.id ? ' is-selected' : '') + (point.reviewed ? ' is-reviewed' : '');
        pin.dataset.pointId = point.id;
        pin.style.left = x + 'px';
        pin.style.top = y + 'px';
        pin.setAttribute('aria-label', point.label + (point.reviewed ? ' — опубликованная точка' : ' — ориентир района'));
        pin.setAttribute('aria-pressed', String(state.selected === point.id));
        pin.innerHTML = '<svg viewBox="0 0 28 38" aria-hidden="true"><path d="M14 1C6.8 1 1 6.8 1 14c0 9 13 23 13 23s13-14 13-23C27 6.8 21.2 1 14 1Z"/><circle cx="14" cy="13.5" r="4"/></svg>';
        pin.addEventListener('click', () => selectPoint(point));
        pinsLayer.append(pin);
        if (point.id === focusedId) pin.focus({ preventScroll: true });
      }
      shell.querySelector('[data-map-action="in"]').disabled = state.zoom >= MAX_ZOOM;
      shell.querySelector('[data-map-action="out"]').disabled = state.zoom <= MIN_ZOOM;
    }

    function selectPoint(point) {
      state.selected = point.id;
      routeTitle.textContent = point.label;
      routeDetail.textContent = point.reviewed ? 'Опубликованная точка · день ' + state.day : 'Ориентир района · день ' + state.day;
      renderPointList();
      schedule();
      if (typeof options.onSelect === 'function') options.onSelect({ ...point }, state.day);
    }

    function renderPointList() {
      pointList.replaceChildren();
      const points = allPoints();
      const heading = document.createElement('h3');
      heading.textContent = 'Ориентиры · день ' + state.day;
      pointList.append(heading);
      const list = document.createElement('ol');
      for (const point of points) {
        const row = document.createElement('li');
        row.className = state.selected === point.id ? 'is-selected' : '';
        const focus = document.createElement('button');
        focus.type = 'button';
        focus.className = 'ox-map-point-focus';
        focus.innerHTML = icon('pin');
        const text = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = point.label;
        const meta = document.createElement('small');
        meta.textContent = (point.reviewed ? 'Опубликовано' : 'Ориентир района') + ' · ' + point.lat.toFixed(4) + ', ' + point.lng.toFixed(4);
        text.append(name, meta);
        focus.append(text);
        focus.addEventListener('click', () => {
          state.lat = point.lat;
          state.lng = point.lng;
          state.zoom = 16;
          selectPoint(point);
          canvas.focus({ preventScroll: true });
        });
        const link = document.createElement('a');
        link.href = osmLink(point);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Открыть в OpenStreetMap';
        row.append(focus, link);
        if (point.summary) { const summary = document.createElement('p'); summary.textContent = point.summary; row.append(summary); }
        list.append(row);
      }
      pointList.append(list);
      listToggle.querySelector('span').textContent = (pointList.hidden ? 'Список ориентиров' : 'Скрыть список') + ' (' + points.length + ')';
    }

    function toggleList() {
      pointList.hidden = !pointList.hidden;
      routeButton.setAttribute('aria-expanded', String(!pointList.hidden));
      listToggle.setAttribute('aria-expanded', String(!pointList.hidden));
      renderPointList();
    }

    function fit() {
      const points = allPoints();
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height || !canvas.getClientRects().length) { fitPending = true; return; }
      const lats = points.map(point => point.lat);
      const lngs = points.map(point => point.lng);
      const west = Math.min(...lngs), east = Math.max(...lngs);
      const south = Math.min(...lats), north = Math.max(...lats);
      state.lat = (north + south) / 2;
      state.lng = (east + west) / 2;
      let zoom = 16;
      while (zoom > MIN_ZOOM) {
        const a = project(north, west, zoom), b = project(south, east, zoom);
        if (Math.abs(a.x - b.x) < Math.max(80, width - 150) && Math.abs(a.y - b.y) < Math.max(100, height - 150)) break;
        zoom--;
      }
      state.zoom = zoom;
      schedule();
    }

    function setDay(number) {
      const next = Number(number);
      if (!Number.isInteger(next) || !days.some(day => day.number === next)) return false;
      state.day = next;
      state.selected = null;
      routeTitle.textContent = route().title;
      routeDetail.textContent = allPoints().length + ' ориентира · ' + route().focus;
      renderPointList();
      fit();
      return true;
    }

    function zoomAt(nextZoom, clientX, clientY) {
      nextZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
      if (nextZoom === state.zoom) return;
      const rect = canvas.getBoundingClientRect();
      const x = clientX === undefined ? 0 : clientX - rect.left - rect.width / 2;
      const y = clientY === undefined ? 0 : clientY - rect.top - rect.height / 2;
      const center = project(state.lat, state.lng, state.zoom);
      const point = unproject(center.x + x, center.y + y, state.zoom);
      const scaled = project(point.lat, point.lng, nextZoom);
      const target = unproject(scaled.x - x, scaled.y - y, nextZoom);
      state.zoom = nextZoom;
      state.lat = target.lat;
      state.lng = target.lng;
      schedule();
    }

    function beginGesture() {
      if (pointers.size === 1) {
        const point = Array.from(pointers.values())[0];
        dragging = { x: point.x, y: point.y, lat: state.lat, lng: state.lng };
        pinch = null;
      } else if (pointers.size >= 2) {
        const [a,b] = Array.from(pointers.values());
        pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) };
        dragging = null;
      } else { dragging = null; pinch = null; }
      canvas.classList.toggle('is-dragging', pointers.size > 0);
    }

    listen(canvas, 'pointerdown', event => {
      if (event.target.closest('button,a') || event.button > 0) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);
      beginGesture();
    });
    listen(canvas, 'pointermove', event => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pinch && pointers.size >= 2) {
        const [a,b] = Array.from(pointers.values());
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const ratio = distance / Math.max(1, pinch.distance);
        if (ratio > 1.35 || ratio < 0.74) {
          zoomAt(state.zoom + (ratio > 1 ? 1 : -1), (a.x + b.x) / 2, (a.y + b.y) / 2);
          pinch.distance = distance;
        }
      } else if (dragging) {
        const center = project(dragging.lat, dragging.lng, state.zoom);
        const target = unproject(center.x - (event.clientX - dragging.x), center.y - (event.clientY - dragging.y), state.zoom);
        state.lat = target.lat;
        state.lng = target.lng;
        schedule();
      }
    });
    const endPointer = event => { pointers.delete(event.pointerId); beginGesture(); };
    listen(canvas, 'pointerup', endPointer);
    listen(canvas, 'pointercancel', endPointer);
    listen(canvas, 'lostpointercapture', endPointer);
    listen(canvas, 'wheel', event => { event.preventDefault(); zoomAt(state.zoom + (event.deltaY < 0 ? 1 : -1), event.clientX, event.clientY); }, { passive: false });
    listen(canvas, 'dblclick', event => { if (!event.target.closest('button,a')) zoomAt(state.zoom + 1, event.clientX, event.clientY); });
    listen(canvas, 'keydown', event => {
      if (event.target !== canvas) return;
      const delta = { ArrowLeft: [-72,0], ArrowRight: [72,0], ArrowUp: [0,-72], ArrowDown: [0,72] }[event.key];
      if (delta) {
        event.preventDefault();
        const center = project(state.lat, state.lng, state.zoom);
        const next = unproject(center.x + delta[0], center.y + delta[1], state.zoom);
        state.lat = next.lat; state.lng = next.lng; schedule();
      } else if (event.key === '+' || event.key === '=' || event.key === '-') {
        event.preventDefault(); zoomAt(state.zoom + (event.key === '-' ? -1 : 1));
      } else if (event.key === 'Home') { event.preventDefault(); fit(); }
    });
    listen(shell, 'click', event => {
      const action = event.target.closest('[data-map-action]')?.dataset.mapAction;
      if (action === 'in') zoomAt(state.zoom + 1);
      if (action === 'out') zoomAt(state.zoom - 1);
      if (action === 'fit') fit();
      if (action === 'retry') {
        for (const [key,tile] of tiles) if (tile.dataset.status !== 'loaded') { tile.remove(); tiles.delete(key); }
        unavailable.hidden = true; schedule();
      }
    });
    listen(routeButton, 'click', toggleList);
    listen(listToggle, 'click', toggleList);
    listen(layerButton, 'click', () => {
      state.dark = !state.dark;
      shell.classList.toggle('is-light', !state.dark);
      layerButton.setAttribute('aria-pressed', String(state.dark));
      layerButton.setAttribute('aria-label', state.dark ? 'Переключить светлую карту' : 'Переключить тёмную карту');
    });
    listen(root, 'online', () => { if (!unavailable.hidden) shell.querySelector('[data-map-action="retry"]').click(); });
    const resize = new ResizeObserver(schedule);
    resize.observe(canvas);

    const api = {
      setDay,
      setMarkers(markers) { reviewed = safeMarkers(markers); state.selected = null; setDay(state.day); },
      refresh() { schedule(); },
      getState() { return { day: state.day, zoom: state.zoom, lat: state.lat, lng: state.lng, selected: state.selected }; },
      destroy() {
        state.alive = false;
        cancelAnimationFrame(frame);
        clearTimeout(loadTimer);
        resize.disconnect();
        listeners.forEach(remove => remove());
        tiles.forEach(tile => { tile.onload = null; tile.onerror = null; });
        tiles.clear(); pointers.clear();
        shell.remove();
        if (container.__osmanxMap === api) delete container.__osmanxMap;
      }
    };
    container.__osmanxMap = api;
    setDay(options.day || 1);
    return api;
  }

  root.OSMANXCommandMap = Object.freeze({ mount, project, unproject });
})(typeof window !== 'undefined' ? window : globalThis);
