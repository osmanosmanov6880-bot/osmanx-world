import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';

const root = resolve(import.meta.dirname, '..');
const source = path => readFileSync(resolve(root, path), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function modules() {
  const context = {};
  runInNewContext(source('moscow-1000/command-data.js'), {globalThis:context});
  runInNewContext(source('moscow-1000/command-offline.js'), {globalThis:context});
  return context.OSMANXPublicOffline;
}
function storage() {
  let value = null;
  return {getItem:() => value, setItem:(_key, input) => { value=input; }, removeItem:() => {value=null;}, value:() => value};
}
const published = overrides => ({ok:true, status:'published', version:1, reviewedAt:'2026-11-20T10:00:00Z',
  metrics:{contacts:2, dialogues:1, expensesRub:1234.56}, days:[{day:1, metrics:{contacts:2}}],
  quests:[{day:1, questId:'d1-q1', completed:true}], ...overrides});

test('R7 public cache: stores a numeric public projection and strips private fields before persistence', () => {
  const disk=storage(),cache=modules().createStore(disk);
  cache.accept('command', published({email:'private@example.test', contacts:[{person:'Private Person'}],
    metrics:{contacts:2, privateNotes:'secret'}, days:[{day:1, metrics:{contacts:2}, internalEvidence:'secret'}],
    quests:[{day:1, questId:'d1-q1', completed:true, completedBy:'private@example.test'}]}));
  assert.ok(disk.value());
  assert.doesNotMatch(disk.value(), /private|secret|Private Person/);
  assert.equal(cache.read('command').snapshot.metrics.contacts, 2);
});

test('R7 public cache: only normalized public editorial fields survive persistence', () => {
  const disk=storage(),cache=modules().createStore(disk);
  cache.accept('editorial', published({
    markers:[{id:'map1',day:1,lat:55.74,lng:37.62,title:'Публичный ориентир',summary:'Опубликованное описание',phone:'private'}],
    episodes:[{day:1,title:'Первая глава',publishedAt:'2026-11-20T09:00:00Z',privateVideoKey:'secret'}],
  }));
  const value=cache.read('editorial').snapshot;
  assert.equal(value.markers[0].title, 'Публичный ориентир');
  assert.equal(value.episodes[0].day, 1);
  assert.doesNotMatch(disk.value(), /private|secret/);
});

test('R7 public cache: explicit withdrawal destroys the corresponding cached publication', () => {
  const disk=storage(),api=modules(),cache=api.createStore(disk);
  cache.accept('command', published());
  cache.accept('editorial', published());
  assert.equal(cache.accept('command',{ok:true,status:'unpublished'}).status,'unpublished');
  assert.equal(cache.read('command'),null);
  assert.ok(cache.read('editorial'));
  assert.equal(cache.accept('editorial',{schemaVersion:3,status:'unpublished'}).status,'unpublished');
  assert.equal(disk.value(),null);
  assert.equal(api.createStore(disk).read('command'),null);
});

test('R7 public cache: connection errors and malformed responses do not look like a withdrawal', () => {
  const cache=modules().createStore(storage());cache.accept('command',published());
  for(const response of [null, undefined, '<html>sign in</html>', {ok:false}, {status:'unpublished'}, {status:'draft'}, {status:'published',reviewedAt:'broken'}]) {
    assert.equal(cache.accept('command',response).status,'unavailable');
    assert.equal(cache.read('command').snapshot.metrics.contacts,2);
  }
});

test('R7 public cache: 24-hour expiry removes values in memory and on disk', () => {
  const api=modules(),disk=storage();let now=1700000000000;
  const cache=api.createStore(disk,{clock:()=>now});cache.accept('command',published());
  now+=api.ttl-1;assert.ok(cache.read('command'));
  now+=2;assert.equal(cache.read('command'),null);assert.equal(disk.value(),null);
});

test('R7 public cache: a restarted page rejects expired or implausibly future copies', () => {
  const api=modules(),disk=storage();let now=1700000000000;
  api.createStore(disk,{clock:()=>now}).accept('command',published());
  now+=api.ttl+1;
  assert.equal(api.createStore(disk,{clock:()=>now}).read('command'),null);
  api.createStore(disk,{clock:()=>now}).accept('command',published());
  now-=120000;
  assert.equal(api.createStore(disk,{clock:()=>now}).read('command'),null);
});

test('R7 public cache: corrupt, oversized and unknown persisted shapes are discarded without crashing', () => {
  for(const payload of ['broken','x'.repeat(150001),'{"schema":2,"entries":{}}','{"schema":1,"entries":{"contacts":{"email":"private"}}}']){
    const disk=storage();disk.setItem('',payload);
    const cache=modules().createStore(disk);
    assert.equal(cache.read('command'),null);assert.equal(disk.value(),null);
  }
});

test('R7 public cache: blocked or full storage leaves the live in-memory interface usable', () => {
  const denied={getItem(){throw Error('denied');},setItem(){throw Error('quota');},removeItem(){throw Error('denied');}};
  const cache=modules().createStore(denied);
  assert.equal(cache.accept('command',published()).status,'published');
  assert.equal(cache.read('command').snapshot.metrics.contacts,2);
  cache.accept('command',{ok:true,status:'unpublished'});assert.equal(cache.read('command'),null);
});

test('R7 public cache: returned objects cannot mutate the retained approved copy', () => {
  const cache=modules().createStore(storage());cache.accept('command',published());
  const first=cache.read('command');first.snapshot.metrics.contacts=900;first.snapshot.quests[0].completed=false;
  const second=cache.read('command');assert.equal(second.snapshot.metrics.contacts,2);assert.equal(second.snapshot.quests[0].completed,true);
});

test('R7 public cache: an older in-flight response cannot resurrect a withdrawn publication', () => {
  const cache=modules().createStore(storage());const old=cache.begin('command');const current=cache.begin('command');
  cache.accept('command',{ok:true,status:'unpublished'},current);
  assert.equal(cache.accept('command',published(),old).status,'superseded');
  assert.equal(cache.read('command'),null);
  const next=cache.begin('command');cache.accept('command',published({version:2}),next);
  assert.equal(cache.read('command').snapshot.version,2);
});

test('R7 public cache: clearing the cache invalidates every pending response', () => {
  const cache=modules().createStore(storage()),ticket=cache.begin('editorial');cache.clear();
  assert.equal(cache.accept('editorial',published(),ticket).status,'superseded');
  assert.equal(cache.read('editorial'),null);
  for(const kind of ['contacts','expenses','auth','__proto__']){assert.equal(cache.read(kind),null);assert.equal(cache.accept(kind,published()).status,'unavailable');}
});

test('R7 public cache: invalid editorial coordinates and unpublished episode dates are excluded', () => {
  const api=modules();
  const result=api.normalize('editorial',published({markers:[
    {day:1,id:'bad',title:'bad',lat:99,lng:0},{day:1,id:'good',title:'Москва',lat:55.75,lng:37.61}
  ],episodes:[{day:1,title:'draft',publishedAt:'unknown'},{day:2,title:'approved',publishedAt:'2026-11-20T10:00:00Z'}]}));
  assert.deepEqual(plain(result.markers).map(m=>m.id),['good']);
  assert.deepEqual(plain(result.episodes).map(e=>e.day),[2]);
});

test('R7 service worker: only known same-origin public shell requests are cacheable', () => {
  const context={};runInNewContext(source('moscow-1000/command-sw.js'),{globalThis:context,URL});
  const policy=context.OSMANXPublicSWPolicy,origin='https://osmanx.world';
  assert.equal(policy.cachePath(origin+'/moscow-1000/?day=5',origin),'/moscow-1000/');
  assert.equal(policy.cachePath(origin+'/moscow-1000/index.html',origin),'/moscow-1000/');
  assert.equal(policy.cachePath(origin+'/moscow-1000/command.js',origin),'/moscow-1000/command.js');
  for(const path of ['/','/moscow-1000/admin/','/moscow-1000/admin/admin.js','/moscow-1000/api/command/public',
    '/moscow-1000/api/command/contacts','/moscow-1000/api/auth/google/callback','/moscow-1000/episodes/1/',
    '/moscow-1000/../private','/moscow-1000/%2Fadmin/'])assert.equal(policy.cachePath(origin+path,origin),null,path);
  assert.equal(policy.cachePath('https://tile.openstreetmap.org/1/2/3.png',origin),null);
  assert.equal(policy.cachePath('https://other.example/moscow-1000/',origin),null);
  assert.equal(policy.cachePath(origin+'/moscow-1000/',origin,'POST'),null);
  assert.equal(policy.cachePath('https://name:password@osmanx.world/moscow-1000/',origin),null);
});

test('R7 service worker: every precached asset is an existing static public file', () => {
  const context={};runInNewContext(source('moscow-1000/command-sw.js'),{globalThis:context,URL});
  for(const asset of context.OSMANXPublicSWPolicy.assets){
    assert.doesNotMatch(asset,/\/admin\/|\/api\/|oauth|contacts|expenses/);
    assert.ok(readFileSync(resolve(root,'.'+asset+(asset.endsWith('/')?'index.html':''))).length>0,asset);
  }
});
