import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const file = path => readFileSync(join(root, path), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const scope = {};
runInNewContext(file('moscow-1000/command-data.js'), { globalThis: scope });
const data = scope.OSMANXCommandData;
const mapScope = {};
runInNewContext(file('moscow-1000/command-map.js'), { globalThis: mapScope });
const map = mapScope.OSMANXCommandMap;
const geoScope = {};
runInNewContext(file('moscow-1000/geo.js'), { globalThis: geoScope });
const published = overrides => ({ status: 'published', version: 1, reviewedAt: '2026-11-20T14:00:00Z', metrics: { visits: 0 }, days: [], quests: [], ...overrides });

test('R6 UI: fifty distinct day-bound quests award exactly 700 XP per day', () => {
  const ids = new Set();
  let total = 0;
  for (let day = 1; day <= 10; day++) {
    const quests = data.quests(day);
    assert.equal(quests.length, 5);
    assert.equal(quests.reduce((sum, quest) => sum + quest.xp, 0), 700);
    quests.forEach((quest, index) => {
      assert.equal(quest.id, `d${day}-q${index + 1}`);
      assert.equal(quest.day, day);
      assert.equal(quest.xp, [150, 200, 100, 100, 150][index]);
      assert.ok(quest.title.length > 10 && quest.description.length > 10);
      assert.ok(!ids.has(quest.id));
      ids.add(quest.id); total += quest.xp;
    });
  }
  assert.equal(ids.size, 50);
  assert.equal(total, 7000);
});

test('R6 UI: invalid day input is bounded and returned quest objects cannot corrupt the catalogue', () => {
  assert.equal(data.quests(0)[0].day, 1);
  assert.equal(data.quests(999)[0].day, 10);
  assert.equal(data.quests('bad')[0].day, 1);
  assert.equal(data.quests(2.8)[0].day, 2);
  const original = data.quests(1)[0].title;
  const copy = data.quests(1);
  copy[0].title = 'mutated'; copy.length = 0;
  assert.equal(data.quests(1).length, 5);
  assert.equal(data.quests(1)[0].title, original);
});

test('R6 UI: public metrics are a numeric allowlist and preserve genuine published zero totals', () => {
  const normalized = data.validMetrics({ researched: 0, contacts: 4, expensesRub: 1234.56, xp: 150, privateCRM: [{ email: 'private@example.test' }], email: 'private@example.test', arbitrary: 100 });
  assert.deepEqual(plain(normalized), { researched: 0, contacts: 4, expensesRub: 1234.56, xp: 150 });
  for (const value of [null, undefined, false, [], '4', {}]) assert.equal(data.validMetrics(value), null);
});

test('R6 UI: invalid counts and non-finite values cannot become displayed results', () => {
  for (const invalid of [-1, NaN, Infinity, -Infinity, 100000001, '47', null, true, {}]) {
    assert.equal(data.validMetrics({ visits: invalid }), null, String(invalid));
  }
  assert.equal(data.validMetrics({ contacts: 1.5, questsCompleted: 2.5, xp: .5 }), null);
  assert.deepEqual(plain(data.validMetrics({ contacts: 3, meetings: -2, pilots: '1' })), { contacts: 3 });
});

test('R6 UI: drafts, absent approval dates and invalid snapshots stay unpublished', () => {
  for (const value of [null, {}, { status: 'unpublished' }, published({ status: 'draft' }), published({ reviewedAt: null }), published({ reviewedAt: 'not-a-date' })]) {
    assert.equal(data.readSnapshot(value), null);
  }
  const result = data.readSnapshot(published({ metrics: null }));
  assert.equal(result.metrics, null);
  assert.deepEqual(plain(result.days), []);
  assert.deepEqual(plain(result.quests), []);
});

test('R6 UI: normalized public snapshots discard private extra fields at every supported level', () => {
  const source = published({
    editorEmail: 'private@example.test', contacts: [{ person: 'Private person' }],
    metrics: { visits: 2, channel: 'private-channel' },
    days: [{ day: 1, metrics: { visits: 2, privateNote: 'internal' }, summary: 'Проверенный итог', lesson: 'Следующий шаг', contactName: 'Private person', internalEvidence: 'secret' }],
    quests: [{ day: 1, questId: 'd1-q1', completed: true, completedBy: 'private@example.test' }],
  });
  const result = plain(data.readSnapshot(source));
  assert.deepEqual(Object.keys(result).sort(), ['status', 'version', 'reviewedAt', 'metrics', 'days', 'quests'].sort());
  assert.deepEqual(result.days, [{ day: 1, metrics: { visits: 2 }, summary: 'Проверенный итог', lesson: 'Следующий шаг' }]);
  assert.deepEqual(result.quests, [{ day: 1, questId: 'd1-q1', completed: true }]);
  assert.doesNotMatch(JSON.stringify(result), /private|Private person|internal|secret/);
  assert.equal(source.editorEmail, 'private@example.test', 'Normalization must not mutate the source.');
});

test('R6 UI: invalid day/quest identities and unconfirmed completions are rejected', () => {
  const result = data.readSnapshot(published({
    days: [{ day: 0 }, { day: 11 }, { day: '1' }, { day: 1, summary: 'a'.repeat(600), lesson: 'b'.repeat(400) }],
    quests: [null, { day: 1, questId: 'd2-q1', completed: true }, { day: 1, questId: 'd1-q6', completed: true }, { day: 1, questId: 'd1-q1', completed: 'true' }, { day: 1, questId: 'd1-q1', completed: false }, { day: 1, questId: 'd1-q1', completed: true }],
  }));
  assert.equal(result.days.length, 1);
  assert.equal(result.days[0].summary.length, 500);
  assert.equal(result.days[0].lesson.length, 350);
  assert.deepEqual(plain(result.quests), [{ day: 1, questId: 'd1-q1', completed: true }]);
});

test('R6 UI: map projection round-trips all twenty public Moscow anchors at supported zooms', () => {
  for (const day of geoScope.OSMANX_GEO.days) for (const anchor of day.anchors) for (const zoom of [11, 15, 18]) {
    const point = map.project(anchor.lat, anchor.lng, zoom);
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    const restored = map.unproject(point.x, point.y, zoom);
    assert.ok(Math.abs(restored.lat - anchor.lat) < 1e-7);
    assert.ok(Math.abs(restored.lng - anchor.lng) < 1e-7);
  }
  for (const lat of [-90, 90]) assert.ok(Number.isFinite(map.project(lat, 37.62, 15).y));
});

function attributes(html, name) {
  return [...html.matchAll(new RegExp('\\b' + name + '="([^"]*)"', 'g'))].map(match => match[1]);
}

test('R6 UI: all five viewer screens have matching navigation and accessible headings', () => {
  const html = file('moscow-1000/index.html');
  const ids = attributes(html, 'id');
  assert.equal(new Set(ids).size, ids.length, 'HTML ids must be unique.');
  const nav = attributes(html, 'data-view');
  assert.deepEqual(nav, ['hq', 'map', 'analytics', 'journal', 'quests']);
  for (const name of nav) {
    assert.ok(ids.includes('view-' + name));
    assert.match(html, new RegExp('id="view-' + name + '"[^>]*aria-labelledby="' + name + '-heading"'));
    assert.ok(ids.includes(name + '-heading'));
  }
  assert.match(html, /id="detail-dialog"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /href="\/moscow-1000\/serial\/"/);
});

test('R6 UI: frontend scripts, stylesheets and internal page links resolve to packaged files', () => {
  for (const path of ['moscow-1000/index.html', 'moscow-1000/admin/index.html']) {
    const html = file(path);
    for (const match of html.matchAll(/<(?:script|link|a)\b[^>]*(?:src|href)="([^"]+)"/g)) {
      const href = match[1];
      if (href.startsWith('#') || href.startsWith('mailto:')) continue;
      const url = new URL(href, 'https://osmanx.world/' + path);
      assert.equal(url.protocol, 'https:', href);
      if (url.origin !== 'https://osmanx.world') continue;
      const target = join(root, decodeURIComponent(url.pathname));
      assert.ok(existsSync(target), href);
      if (statSync(target).isDirectory()) assert.ok(existsSync(join(target, 'index.html')), href);
    }
  }
  const reference = readFileSync(join(root, 'moscow-1000/reference/moscow-skyline.png'));
  assert.equal(reference.readUInt32BE(16), 636);
  assert.equal(reference.readUInt32BE(20), 174);
});

test('R6 UI: administrator page starts locked and authentication has no browser-only bypass', () => {
  const html = file('moscow-1000/admin/index.html');
  const source = file('moscow-1000/admin/admin.js');
  assert.match(html, /id="workspace"[^>]*hidden/);
  assert.match(html, /id="googleSignIn"[^>]*disabled/);
  assert.match(html, /id="publishConfirm"[^>]*type="checkbox"/);
  assert.match(html, /id="publish"[^>]*disabled/);
  assert.match(source, /session\.value\.authenticated === true/);
  assert.match(source, /location\.assign\(API \+ '\/auth\/google\/start'\)/);
  assert.match(source, /expectedRevision/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|demoLogin|fakeLogin|authBypass/);
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML\(/, 'Private fields must be rendered as text, not interpreted HTML.');
});

test('R6 UI: interpolation escape handles hostile published text', () => {
  const source = file('moscow-1000/command.js');
  // Execute the actual pure escaping helper used by the rendered public cards.
  const helper = source.match(/^  const esc = (.+);$/m)?.[1];
  assert.ok(helper, 'The public card renderer must expose its source escaping helper.');
  const escape = runInNewContext('(' + helper + ')');
  const hostile = '<img src=x onerror="alert(1)"> & \'quoted\'';
  const rendered = escape(hostile);
  assert.equal(rendered, '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quoted&#39;');
  assert.doesNotMatch(rendered, /[<>]/);
  assert.equal(escape('Москва — день 1'), 'Москва — день 1');
});

test('R6 UI: viewer only fetches public snapshots and never requests private credentials', () => {
  const source = file('moscow-1000/command.js');
  const endpoints = [...source.matchAll(/loadPublic\('([^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual(endpoints, ['/moscow-1000/api/command/public', '/moscow-1000/api/public-release']);
  assert.match(source, /credentials:'omit'/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|\/command\/(?:contacts|expenses)|\/auth\/session/);
  assert.match(source, /open\.href=`\/moscow-1000\/episodes\/\$\{ep\.id\}\//);
  assert.match(file('moscow-1000/command-map.js'), /noopener noreferrer/);
});
