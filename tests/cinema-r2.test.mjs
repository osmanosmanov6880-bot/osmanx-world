import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {CASES,GROUPS,CHAPTERS,caseById,casesByGroup,currentChapter,tidy,storyURL,buildBrief,mailtoBrief} from '../assets/stories/story-engine.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const read=p=>readFileSync(join(root,p),'utf8');

test('R2: all 12 unique stories have grounded metrics, verification plans and matching R1 assets',()=>{
  const manifest=JSON.parse(read('assets/stories/manifest.json'));
  assert.equal(CASES.length,12);
  assert.equal(GROUPS.length,5);
  assert.equal(new Set(CASES.map(x=>x.id)).size,12);
  assert.deepEqual(new Set(manifest.clips.map(x=>x.id)),new Set(CASES.map(x=>x.id)));
  for(const item of CASES){
    assert(item.hypothesis.length>35);
    assert(item.evidence.length>40);
    assert(item.metric.length>30);
    assert(item.experiment.length>35);
    assert(item.offer.startsWith('/assets/'));
    assert(existsSync(join(root,item.offer.split('?')[0].slice(1))));
    assert.equal(caseById(item.id),item);
    assert(casesByGroup(item.group).includes(item));
  }
  assert.equal(caseById('__not-a-story'),null);
});

test('R2: navigation holds 4 ordered chapters within the movie duration',()=>{
  assert.deepEqual(CHAPTERS.map(c=>c.at),[0,12,24,37]);
  assert.equal(currentChapter(0).at,0);
  assert.equal(currentChapter(23.9).at,12);
  assert.equal(currentChapter(37).at,37);
  assert.equal(currentChapter(48.8).at,37);
  assert.equal(currentChapter(Number.NaN).at,0);
});

test('R2: brefs are bounded, escaped for mailto and do not auto-submit',()=>{
  const text=buildBrief({id:'02-fashion',company:'Магазин\nX<script>',concern:'Нет размера\r\n24',goal:'Снизить долю незавершённых покупок',monthlyVolume:'350'});
  assert.match(text,/Магазин одежды/);
  assert.match(text,/350/);
  assert.match(text,/Возможная гипотеза/);
  assert.match(text,/Контрольный показатель/);
  assert.doesNotMatch(text,/\r/);
  assert.doesNotMatch(text,/\n\n\n/);
  const uri=mailtoBrief(text,'02-fashion');
  assert.match(uri,/^mailto:hello@osmanx\.world\?subject=/);
  assert(uri.includes('&body='));
  assert.equal(decodeURIComponent(uri.split('&body=')[1]),text);
  assert.throws(()=>buildBrief({id:'01-restaurant',monthlyVolume:'-1'}));
  assert.throws(()=>buildBrief({id:'01-restaurant',monthlyVolume:'13.7'}));
  assert.throws(()=>buildBrief({id:'x'}));
  assert.throws(()=>mailtoBrief('short','x'));
  assert.equal(tidy(' hi\n \t there  '),'hi there');
});

test('R2: share links whitelist known ids, never copy injected query strings',()=>{
  assert.equal(storyURL('01-restaurant'),'https://osmanx.world/assets/stories/cinema.html?story=01-restaurant#episodes');
  assert.equal(storyURL('hello?redirect=https://bad.com'),'https://osmanx.world/assets/stories/cinema.html');
});

test('R2: frontend has opt-in player, 12 story brief links, safe model imports and low-data controls',()=>{
  const page=read('assets/stories/cinema.html');
  const module=read('assets/stories/cinema-r2.mjs');
  const css=read('assets/stories/cinema-r2.css');
  assert.match(page,/src="\/assets\/stories\/cinema-r2\.mjs"/);
  assert.match(page,/href="\/assets\/stories\/cinema-r2\.css"/);
  assert.match(page,/preload="none"/);
  assert.match(page,/r2-transcript/);
  assert.match(page,/captions-ru\.vtt/);
  assert.match(module,/storyURL\(item\.id\)/);
  assert.match(module,/buildBrief\(/);
  assert.match(module,/mailtoBrief\(/);
  assert.match(module,/visibilitychange/);
  assert.match(module,/IntersectionObserver/);
  assert.match(module,/navigator\.clipboard/);
  assert.match(module,/navigator\.share/);
  assert.match(css,/prefers-reduced-motion/);
  assert.doesNotMatch(page+module+css,/_jwt=|cloudfront\.net|GoogleAnalytics|gtag\(/i);
  assert.doesNotMatch(page,/\sautoplay(?:\s|=|>)/i);
});

test('R2: public SEO files and local soundtrack captions point to real resources',()=>{
  const robots=read('robots.txt'),sitemap=read('sitemap.xml'),page=read('assets/stories/cinema.html'),vtt=read('assets/stories/captions-ru.vtt');
  assert.match(robots,/Sitemap: https:\/\/osmanx\.world\/sitemap\.xml/);
  assert.match(sitemap,/https:\/\/osmanx\.world\/assets\/stories\/cinema\.html/);
  assert.match(page,/<link rel="canonical"/);
  assert.match(page,/"@type":"VideoObject"/);
  assert.match(page,/contentUrl/);
  assert.match(vtt,/^WEBVTT/);
  assert.equal((vtt.match(/-->/g)||[]).length,4);
  assert(existsSync(join(root,'assets/stories/media/00-osmanx-film.mp4')));
});

test('R2: contextual deep links are wired from real commercial pages',()=>{
  for(const p of ['assets/guest/offer.html','assets/catalog/index.html','assets/industry/index.html']){
    const html=read(p);
    assert.match(html,/\/assets\/stories\/cinema\.html\?story=|\/assets\/stories\/cinema\.html\?group=/,p);
  }
});
