import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../moscow-1000/command-map.js', import.meta.url), 'utf8');
const geoSource = readFileSync(new URL('../moscow-1000/geo.js', import.meta.url), 'utf8');
const scope = {};
runInNewContext(source, { globalThis: scope });
const map = scope.OSMANXCommandMap;
const plain = value => JSON.parse(JSON.stringify(value));
const marker = overrides => ({ id: 'published-one', day: 1, title: 'Ёлки на Пятницкой', summary: 'Разговор о кофейне', lat: 55.742, lng: 37.628, ...overrides });

test('R8 map: published points have only public fields, unique stable IDs and bounded text', () => {
  const value = marker({ title: '  Ориентир  ', email: 'private@example.test', privateNote: 'private', url: 'javascript:alert(1)' });
  const safe = map.safeMarkers([value, marker({ title: 'Duplicate' }), marker({ id: 'other', day: 2, title: 'a'.repeat(200), summary: 'b'.repeat(500) })]);
  assert.equal(safe.length, 2);
  assert.deepEqual(plain(safe[0]), { id: 'published-one', day: 1, lat: 55.742, lng: 37.628, label: 'Ориентир', summary: 'Разговор о кофейне', reviewed: true });
  assert.equal(safe[1].label.length, 160);
  assert.equal(safe[1].summary.length, 400);
  assert.equal(value.email, 'private@example.test');
  assert.doesNotMatch(JSON.stringify(safe), /private|javascript/);
});

test('R8 map: invalid coordinates and colliding anchor identities cannot enter the public map', () => {
  const bad = [null, {}, marker({ day: '1' }), marker({ day: 11 }), marker({ lat: Infinity }), marker({ lat: 51 }), marker({ lng: '37.62' }), marker({ id: '../secret' }), marker({ id: 'area-1-0' }), marker({ id: 'x'.repeat(81) }), marker({ title: '   ' })];
  assert.deepEqual(plain(map.safeMarkers(bad)), []);
  assert.equal(map.safeMarkers([marker({ id: 'area-community' })]).length, 1, 'Noncolliding author IDs remain valid.');
  assert.equal(map.safeMarkers(Array.from({ length: 205 }, (_, i) => marker({ id: 'p' + i }))).length, 200);
});

test('R8 map: search folds Cyrillic case and ё, matches all literal words across title and full summary', () => {
  const points = map.safeMarkers([marker(), marker({ id: 'other', title: 'Съёмка', summary: 'a'.repeat(190) + ' подтверждена' })]);
  assert.equal(map.filterPoints(points, ' ЕЛКИ   КОФЕЙНЕ ')[0].id, 'published-one');
  assert.equal(map.filterPoints(points, 'съемка подтверждена')[0].id, 'other');
  assert.equal(map.filterPoints(points, 'елки съемка').length, 0);
  assert.equal(map.filterPoints(points, '%').length, 0);
  assert.equal(map.filterPoints(points, '.*').length, 0);
  assert.equal(map.filterPoints(points, '   ').length, 2);
  assert.equal(map.filterPoints(points, null).length, 2);
});

test('R8 map: OSM links derive solely from finite public coordinates', () => {
  const href = map.osmLink(marker({ url: 'https://attacker.invalid', title: '<script>' }));
  const url = new URL(href);
  assert.equal(url.origin, 'https://www.openstreetmap.org');
  assert.equal(url.searchParams.get('mlat'), '55.742');
  assert.equal(url.searchParams.get('mlon'), '37.628');
  assert.equal(url.hash, '#map=17/55.742/37.628');
  for (const bad of [null, {}, { lat: NaN, lng: 37.62 }, { lat: '55.74', lng: 37.62 }, { lat: 90, lng: 37.62 }]) assert.equal(map.osmLink(bad), null);
});

// Minimal event/element host for lifecycle tests. No layout, network or browser
// identity is simulated; real responsive rendering is checked separately.
function domHost() {
  const document = { activeElement: null };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.parent = null; this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = new Map(); this.className = ''; this.hidden = false; this.value = ''; }
    append(...nodes) { for (const child of nodes) { if (child.parent) child.remove(); this.children.push(child); child.parent = this; } }
    replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    get textContent() { return this._text || this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get classList() { return { toggle: (value, enabled) => { const classes = new Set(this.className.split(/\s+/).filter(Boolean)); if (enabled ?? !classes.has(value)) classes.add(value); else classes.delete(value); this.className = [...classes].join(' '); }, add: value => this.classList.toggle(value, true) }; }
    setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'class') this.className = String(value); if (key === 'hidden') this.hidden = true; if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    matches(selector) { if (selector.includes(',')) return selector.split(',').some(part => this.matches(part)); if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1)); const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector); if (attr) return attr[2] === undefined ? attr[1] in this.attributes : this.attributes[attr[1]] === attr[2]; return this.tagName === selector; }
    querySelectorAll(selector) { if (selector.includes(' ')) { const [first, ...rest] = selector.split(' '); return this.querySelectorAll(first).flatMap(node => node.querySelectorAll(rest.join(' '))); } const found = []; for (const node of this.children) { if (node.matches(selector)) found.push(node); found.push(...node.querySelectorAll(selector)); } return found; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
    contains(node) { return !!node && (this === node || this.children.some(child => child.contains(node))); }
    addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(callback); }
    removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== callback)); }
    dispatch(name, extra = {}) { const event = { target: this, preventDefault() {}, ...extra }; for (const callback of this.listeners.get(name) || []) callback(event); }
    click() { this.dispatch('click'); }
    focus() { document.activeElement = this; }
    getClientRects() { return []; }
    set innerHTML(value) {
      this.replaceChildren(); this._text = '';
      const stack = [this];
      for (const match of value.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*?)>|([^<]+)/g)) {
        if (match[3]) { stack.at(-1)._text = (stack.at(-1)._text || '') + match[3]; continue; }
        if (match[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
        const node = new Element(match[1]);
        for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] || '');
        stack.at(-1).append(node);
        if (!['input','img','br'].includes(match[1]) && !match[2].endsWith('/')) stack.push(node);
      }
    }
  }
  document.createElement = tag => new Element(tag);
  const root = new Element('window');
  const context = { globalThis: root, document, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, clearTimeout() {}, setTimeout: () => 1, ResizeObserver: class { observe() {} disconnect() {} } };
  runInNewContext(geoSource, context); runInNewContext(source, context);
  const container = new Element('div'), events = [];
  const api = root.OSMANXCommandMap.mount(container, { day: 1, onSelect: (...args) => events.push(plain(args)) });
  return { api, container, document, events };
}

test('R8 map: deep-link selection is silent, user selection opens the same actual detail and announces source', () => {
  const { api, container, document, events } = domHost();
  assert.equal(api.selectPoint('area-1-0'), true);
  assert.equal(api.getSelectedPoint().label, 'Пятницкая улица');
  assert.equal(container.querySelector('.ox-map-point-detail').hidden, false);
  assert.equal(container.querySelector('.ox-map-detail-title').textContent, 'Пятницкая улица');
  assert.equal(events.length, 0);
  container.querySelectorAll('.ox-map-point-focus')[1].click();
  assert.equal(api.getSelectedPoint().id, 'area-1-1');
  assert.equal(document.activeElement, container.querySelector('.ox-map-detail-title'));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].slice(1), [1, { reason: 'user' }]);
  assert.equal(api.selectPoint('unknown'), false);
  assert.equal(api.getSelectedPoint().id, 'area-1-1');
});

test('R8 map: marker refresh preserves selection, withdrawal clears visible private-free detail and notifies once', () => {
  const { api, container, document, events } = domHost();
  api.setMarkers([marker()]);
  api.selectPoint('published-one', { focus: true });
  api.setMarkers([marker({ title: '<strong>Обновлено</strong>', summary: 'Новая публичная запись' })]);
  assert.equal(api.getSelectedPoint().id, 'published-one');
  assert.equal(container.querySelector('.ox-map-detail-title').textContent, '<strong>Обновлено</strong>');
  assert.equal(container.querySelector('.ox-map-detail-title').children.length, 0, 'Published strings remain text nodes.');
  assert.equal(events.length, 0);
  api.setMarkers([]);
  assert.equal(api.getSelectedPoint(), null);
  assert.equal(container.querySelector('.ox-map-point-detail').hidden, true);
  assert.equal(container.querySelector('.ox-map-detail-title').textContent, '');
  assert.equal(document.activeElement, container.querySelector('.ox-map-canvas'));
  assert.deepEqual(events, [[null, 1, { reason: 'withdrawn' }]]);
  api.setMarkers([]);
  assert.equal(events.length, 1);
});

test('R8 map: searchable list keeps input focused, resets across days and never marks visits', () => {
  const { api, container, document, events } = domHost();
  const input = container.querySelector('input');
  input.focus(); input.value = 'КЛИМЕНТОВ'; input.dispatch('input');
  assert.equal(container.querySelectorAll('.ox-map-point-focus').length, 1);
  assert.equal(document.activeElement, input);
  assert.equal(container.querySelector('.ox-map-search-status').textContent, 'Найдено: 1 из 2');
  input.value = 'неизвестный'; input.dispatch('input');
  assert.equal(container.querySelectorAll('.ox-map-point-focus').length, 0);
  assert.match(container.querySelector('.ox-map-search-empty').textContent, /Измените запрос/);
  container.querySelector('.ox-map-search-clear').click();
  assert.equal(input.value, '');
  assert.equal(container.querySelectorAll('.ox-map-point-focus').length, 2);
  api.selectPoint('area-1-0'); api.setDay(4);
  assert.equal(api.getSelectedPoint(), null);
  assert.equal(events.length, 0);
  assert.equal(api.selectPoint('area-1-0'), false);
  assert.equal(api.selectPoint('area-4-1'), true);
  assert.equal(api.getSelectedPoint().reviewed, false);
  assert.doesNotMatch(JSON.stringify(api.getSelectedPoint()), /visited|completed|private/);
});

test('R8 map: user clear and destroy release selection and event lifecycle', () => {
  const { api, container, events } = domHost();
  api.selectPoint('area-1-0');
  container.querySelector('.ox-map-detail-close').click();
  assert.equal(api.getSelectedPoint(), null);
  assert.deepEqual(events, [[null, 1, { reason: 'user' }]]);
  api.destroy();
  assert.equal(container.children.length, 0);
  assert.equal(api.selectPoint('area-1-0'), false);
  assert.equal(api.setDay(2), false);
});
