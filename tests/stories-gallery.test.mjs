import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read=(path)=>readFileSync(new URL('../'+path, import.meta.url),'utf8');
test('stories page contains 12 distinct media slots and industry categories',()=>{
  const page=read('assets/stories/index.html');
  const ids=[...page.matchAll(/data-id="([\w-]+)"/g)].map(x=>x[1]);
  assert.equal(ids.length,12);
  assert.equal(new Set(ids).size,12);
  for(const id of ids)assert.match(page,new RegExp('data-play="'+id+'"'));
  for(const filter of ['hospitality','retail','health','service','education'])assert.ok(page.includes('data-filter="'+filter+'"'));
  assert.ok(page.includes('OSMANX STORIES'));
});
test('no expiring Runway links or auto-play on gallery',()=>{
  const page=read('assets/stories/index.html');
  assert.doesNotMatch(page,/_jwt=|cloudfront\.net|autoplay/i);
  assert.match(page,/method:"HEAD"/);
  assert.match(page,/play\.disabled=false/);
  assert.match(page,/preload="none"/);
});
test('all landing pages link to media showcase',()=>{
  for(const path of ['index.html','assets/catalog/index.html','assets/guest/offer.html'])
    assert.match(read(path), /\/assets\/stories\/(?:index|cinema)\.html/);
});
test('all commercial case studies are explicitly illustrative',()=>{
  const page=read('assets/stories/index.html');
  assert.match(page,/Постановочные сцены/);
  assert.match(page,/не съёмки реальных клиентов/);
});
