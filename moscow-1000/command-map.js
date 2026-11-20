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

  const validCoordinates = point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng) && point.lat > 55.5 && point.lat < 56 && point.lng > 37 && point.lng < 38.2;
  const normalizeSearch = value => typeof value === 'string' ? value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').trim().replace(/\s+/g,' ') : '';

  function safeMarkers(markers) {
    if (!Array.isArray(markers)) return [];
    const seen = new Set(), result = [];
    for (const marker of markers) {
      if (!marker || !Number.isInteger(marker.day) || marker.day < 1 || marker.day > 10 || !validCoordinates(marker) || typeof marker.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(marker.id) || /^area-(?:[1-9]|10)-\d+$/.test(marker.id) || seen.has(marker.id) || typeof marker.title !== 'string' || !marker.title.trim()) continue;
      seen.add(marker.id);
      result.push({ id: marker.id, day: marker.day, lat: marker.lat, lng: marker.lng, label: marker.title.trim().slice(0,160), summary: typeof marker.summary === 'string' ? marker.summary.trim().slice(0,400) : '', reviewed: true });
      if (result.length === 200) break;
    }
    return result;
  }

  function filterPoints(points, query) {
    const terms = normalizeSearch(query).slice(0,160).split(' ').filter(Boolean);
    return points.filter(point => {
      const text = normalizeSearch(point.label) + ' ' + normalizeSearch(point.summary);
      return terms.every(term => text.includes(term));
    });
  }

  function osmLink(point) {
    if (!validCoordinates(point)) return null;
    return 'https://www.openstreetmap.org/?mlat=' + encodeURIComponent(point.lat) + '&mlon=' + encodeURIComponent(point.lng) + '#map=17/' + point.lat + '/' + point.lng;
  }

  function mount(container, options) {
    options = options || {};
    if (!container || typeof container.replaceChildren !== 'function') throw new TypeError('Map container is required');
    const days = root.OSMANX_GEO && root.OSMANX_GEO.days;
    if (!Array.isArray(days) || !days.length) throw new Error('OSMANX public geography is missing');
    if (container.__osmanxMap) container.__osmanxMap.destroy();

    const state = { day: 1, zoom: 15, lat: 55.75, lng: 37.62, selected: null, query: '', dark: true, alive: true };
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
      '<section class="ox-map-point-detail" hidden><div class="ox-map-detail-top"><span class="ox-map-point-status"></span><button type="button" class="ox-map-detail-close" aria-label="Закрыть выбранный ориентир">' + icon('cross') + '</button></div><h3 class="ox-map-detail-title" tabindex="-1"></h3><p class="ox-map-detail-summary"></p><p class="ox-map-detail-coordinates"></p><a class="ox-map-detail-link" target="_blank" rel="noopener noreferrer">Открыть точку в OpenStreetMap</a><p class="ox-map-detail-note">Внешняя карта откроется в новой вкладке.</p></section>' +
      '<button type="button" class="ox-map-list-toggle" aria-expanded="false">' + icon('list') + '<span>Список ориентиров</span></button>' +
      '<div class="ox-map-point-list" hidden><h3 class="ox-map-list-heading" tabindex="-1"></h3><form class="ox-map-search" role="search" aria-label="Поиск ориентиров выбранного дня"><label>Найти ориентир<input type="search" maxlength="160" placeholder="Название или описание" autocomplete="off" spellcheck="false"></label><button type="button" class="ox-map-search-clear" hidden>Сбросить поиск</button></form><p class="ox-map-search-status" role="status" aria-live="polite"></p><div class="ox-map-search-results"></div></div>' +
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
    const pointResults = shell.querySelector('.ox-map-search-results');
    const searchInput = shell.querySelector('.ox-map-search input');
    const searchClear = shell.querySelector('.ox-map-search-clear');
    const pointDetail = shell.querySelector('.ox-map-point-detail');
    const detailTitle = shell.querySelector('.ox-map-detail-title');
    const detailClose = shell.querySelector('.ox-map-detail-close');
    const layerButton = shell.querySelector('.ox-map-layer');

    function listen(el, event, callback, opts) {
      el.addEventListener(event, callback, opts);
      listeners.push(() => el.removeEventListener(event, callback, opts));
    }

    function route() { return days.find(day => day.number === state.day) || days[0]; }
    function allPoints() {
      return route().anchors.map((anchor, index) => ({ ...anchor, id: 'area-' + state.day + '-' + index, reviewed: false })).concat(reviewed.filter(marker => marker.day === state.day));
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
        pin.addEventListener('click', () => selectPoint(point.id, { notify: true, focus: true }));
        pinsLayer.append(pin);
        if (point.id === focusedId) pin.focus({ preventScroll: true });
      }
      shell.querySelector('[data-map-action="in"]').disabled = state.zoom >= MAX_ZOOM;
      shell.querySelector('[data-map-action="out"]').disabled = state.zoom <= MIN_ZOOM;
    }

    function getSelectedPoint() {
      if (!state.alive) return null;
      const point = allPoints().find(item => item.id === state.selected);
      return point ? { ...point } : null;
    }

    function renderSelection() {
      const point = getSelectedPoint();
      routeTitle.textContent = route().title;
      routeDetail.textContent = allPoints().length + ' ориентира · ' + route().focus;
      pointDetail.hidden = !point;
      if (!point) {
        shell.querySelector('.ox-map-point-status').textContent = '';
        detailTitle.textContent = '';
        shell.querySelector('.ox-map-detail-summary').textContent = '';
        shell.querySelector('.ox-map-detail-coordinates').textContent = '';
        shell.querySelector('.ox-map-detail-link').removeAttribute('href');
        return;
      }
      shell.querySelector('.ox-map-point-status').textContent = (point.reviewed ? 'Опубликованная точка' : 'Ориентир района') + ' · день ' + state.day;
      detailTitle.textContent = point.label;
      shell.querySelector('.ox-map-detail-summary').textContent = point.summary || (point.reviewed ? 'Публичная точка, одобренная автором экспедиции.' : 'Ориентир для знакомства с районом. Это часть плана дня, а не отметка о состоявшейся встрече.');
      shell.querySelector('.ox-map-detail-coordinates').textContent = point.lat.toFixed(5) + ', ' + point.lng.toFixed(5);
      shell.querySelector('.ox-map-detail-link').href = osmLink(point);
    }

    function selectPoint(id, behavior = {}) {
      if (!state.alive || typeof id !== 'string') return false;
      const point = allPoints().find(item => item.id === id);
      if (!point) return false;
      state.selected = point.id;
      fitPending = false;
      state.lat = point.lat;
      state.lng = point.lng;
      state.zoom = Math.max(state.zoom, 16);
      renderSelection();
      renderPointList();
      schedule();
      if (behavior.notify === true && typeof options.onSelect === 'function') options.onSelect({ ...point }, state.day, { reason: 'user' });
      if (behavior.focus === true) detailTitle.focus();
      return true;
    }

    function clearSelection(behavior = {}) {
      if (!state.alive) return;
      const hadSelection = state.selected !== null;
      const restoreFocus = pointDetail.contains(document.activeElement);
      state.selected = null;
      renderSelection(); renderPointList(); schedule();
      if (hadSelection && behavior.notify === true && typeof options.onSelect === 'function') options.onSelect(null, state.day, { reason: behavior.reason === 'withdrawn' ? 'withdrawn' : 'user' });
      if (behavior.focus === true || restoreFocus) canvas.focus({ preventScroll: true });
    }

    function renderPointList() {
      pointResults.replaceChildren();
      const all = allPoints(), points = filterPoints(all, state.query);
      shell.querySelector('.ox-map-list-heading').textContent = 'Ориентиры · день ' + state.day;
      shell.querySelector('.ox-map-search-status').textContent = state.query.trim() ? 'Найдено: ' + points.length + ' из ' + all.length : 'Ориентиров в плане: ' + all.length;
      searchClear.hidden = !state.query;
      const list = document.createElement('ol');
      for (const point of points) {
        const row = document.createElement('li');
        row.className = state.selected === point.id ? 'is-selected' : '';
        const focus = document.createElement('button');
        focus.type = 'button';
        focus.className = 'ox-map-point-focus';
        focus.setAttribute('aria-pressed', String(state.selected === point.id));
        focus.innerHTML = icon('pin');
        const text = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = point.label;
        const meta = document.createElement('small');
        meta.textContent = (point.reviewed ? 'Опубликовано' : 'Ориентир района') + ' · ' + point.lat.toFixed(4) + ', ' + point.lng.toFixed(4);
        text.append(name, meta);
        focus.append(text);
        focus.addEventListener('click', () => {
          selectPoint(point.id, { notify: true, focus: true });
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
      if (!points.length) {
        const empty = document.createElement('p');
        empty.className = 'ox-map-search-empty';
        empty.textContent = 'В этом дне такого ориентира нет. Измените запрос или сбросьте поиск.';
        pointResults.append(empty);
      } else pointResults.append(list);
      listToggle.querySelector('span').textContent = (pointList.hidden ? 'Список ориентиров' : 'Скрыть список') + ' (' + all.length + ')';
    }

    function toggleList() {
      pointList.hidden = !pointList.hidden;
      routeButton.setAttribute('aria-expanded', String(!pointList.hidden));
      listToggle.setAttribute('aria-expanded', String(!pointList.hidden));
      renderPointList();
      if (!pointList.hidden) shell.querySelector('.ox-map-list-heading').focus();
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
      if (!state.alive || !Number.isInteger(next) || !days.some(day => day.number === next)) return false;
      state.day = next;
      state.selected = null;
      state.query = ''; searchInput.value = '';
      renderSelection();
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
      else if (event.key === 'Escape' && state.selected) { event.preventDefault(); clearSelection({ notify: true, focus: true }); }
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
    listen(detailClose, 'click', () => clearSelection({ notify: true, focus: true }));
    listen(pointDetail, 'keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); clearSelection({ notify: true, focus: true }); }
    });
    listen(shell.querySelector('.ox-map-search'), 'submit', event => event.preventDefault());
    listen(searchInput, 'input', () => { state.query = searchInput.value.slice(0,160); renderPointList(); });
    listen(searchClear, 'click', () => { state.query = ''; searchInput.value = ''; renderPointList(); searchInput.focus({ preventScroll: true }); });
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
      selectPoint,
      getSelectedPoint,
      clearSelection,
      setMarkers(markers) {
        if (!state.alive) return;
        reviewed = safeMarkers(markers);
        if (state.selected && !getSelectedPoint()) clearSelection({ notify: true, reason: 'withdrawn' });
        else { renderSelection(); renderPointList(); schedule(); }
      },
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

  root.OSMANXCommandMap = Object.freeze({ mount, project, unproject, safeMarkers, filterPoints, normalizeSearch, osmLink });
})(typeof window !== 'undefined' ? window : globalThis);
