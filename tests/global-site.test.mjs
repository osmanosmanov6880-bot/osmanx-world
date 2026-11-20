import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {copy,sectors,sectorIds,films,pageUrl,filterFilms,getFilm,normalizeSearch} from '../assets/global/content.js';
import {openFilmRoute,closeFilmRoute} from '../assets/global/film-route.js';
const root=resolve(import.meta.dirname,'..');
test('G1: 10 distinct RU/EN documents have correct language and all linked local media exist',()=>{
const urls=new Set();for(const locale of ['ru','en'])for(const sector of ['',...sectorIds]){const path=pageUrl(locale,sector);urls.add(path);const html=readFileSync(resolve(root,'.'+path,'index.html'),'utf8');assert.match(html,new RegExp(`<html lang="${locale}"`));assert.match(html,/id="project-brief"/);assert.match(html,/id="pilot-calculator"/);assert.match(html,/name="robots" content="noindex,nofollow"/);for(const m of html.matchAll(/(?:src|href)="(\/assets\/global\/[^"#?]+|\/assets\/stories\/[^"#?]+)"/g)){let p=resolve(root,'.'+m[1]);if(m[1].endsWith('/'))p=resolve(p,'index.html');assert.ok(existsSync(p),'Missing '+m[1]);}}
assert.equal(urls.size,10);
});
test('G1: original video and poster inventory uses the established source hashes',()=>{const manifest=JSON.parse(readFileSync(resolve(root,'assets/stories/manifest.json'),'utf8'));assert.equal(manifest.clips.length,12);for(const clip of manifest.clips){const bytes=readFileSync(resolve(root,'.'+clip.video));assert.equal(createHash('sha256').update(bytes).digest('hex'),clip.sha256,clip.id);assert.ok(statSync(resolve(root,'.'+clip.poster)).size>1000);}assert.ok(statSync(resolve(root,'assets/stories/media/00-osmanx-film.mp4')).size>1000000,'Reject the earlier 3-second placeholder');});
test('G1: Cyrillic, mixed case, empty search and combined category filters',()=>{assert.equal(normalizeSearch('  ЁЖ  '),'еж');assert.equal(filterFilms('').length,12);assert.ok(filterFilms('РАЗМЕР').some(f=>f.id==='02-fashion'));assert.equal(filterFilms('несуществующаяистория').length,0);assert.ok(filterFilms('', 'health').every(f=>f.category==='health'));assert.equal(filterFilms('РАЗМЕР','health').length,0);});
test('G1: film IDs are allowlisted, languages route independently and unknown sectors cannot become paths',()=>{assert.equal(getFilm('../admin'),null);assert.equal(getFilm('<script>'),null);assert.ok(getFilm('feature'));assert.equal(pageUrl('en','retail'),'/assets/global/en/retail/');assert.equal(pageUrl('ru','../../../'),'/assets/global/');assert.equal(new Set(films.map(f=>f.id)).size,12);});
test('G1: films stay illustrations, core industry pages have complete offers in both languages',()=>{for(const locale of ['ru','en']){assert.ok(copy[locale].aiNote.includes('AI'));for(const id of sectorIds){const s=sectors[id][locale];for(const key of ['headline','intro','question','hypothesis','pilot','measurement','expansion'])assert.ok(s[key]?.length>10);assert.equal(s.outputs.length,4);}}});
test('G1: captions are provided for the full film, short silent stories do not invent audio',()=>{assert.ok(existsSync(resolve(root,'.'+getFilm('feature').captions)));for(const f of films)assert.equal(f.captions,undefined);});
test('G1: search includes complete English descriptions, industry labels and long Cyrillic tails',()=>{
assert.deepEqual(filterFilms('COFFEE').map(f=>f.id),['07-coffee']);
assert.deepEqual(filterFilms('queue').map(f=>f.id),['07-coffee']);
assert.deepEqual(filterFilms('dental clinics').map(f=>f.id),['03-dentistry','09-appointment']);
assert.deepEqual(filterFilms('availability').map(f=>f.id),['02-fashion','12-shoes']);
assert.deepEqual(filterFilms('причины отказа').map(f=>f.id),['01-restaurant']);
assert.deepEqual(filterFilms('согласования').map(f=>f.id),['11-logistics']);
assert.equal(filterFilms('coffee','health').length,0);
assert.equal(normalizeSearch('a'.repeat(101)).length,100,'Only the user query has a 100-character limit');
});
test('G1: the general brand film starts a generic brief in both languages',()=>{
assert.equal(getFilm('feature').sector,'other');
assert.equal(pageUrl('ru',getFilm('feature').sector)+'#brief','/assets/global/#brief');
assert.equal(pageUrl('en',getFilm('feature').sector)+'#brief','/assets/global/en/#brief');
for(const id of sectorIds)assert.equal(getFilm(sectors[id].film).sector,id);
});
test('G1: direct links and history restoration never request autoplay, including the film with music',()=>{
for(const id of ['feature',...films.map(f=>f.id)]){
 const route=openFilmRoute(`https://preview.example/assets/global/?film=${id}`,null,id,{owner:'page-A'});
 assert.equal(route.autoplay,false,id);assert.equal(route.method,null,id);
}
const click=openFilmRoute('https://preview.example/assets/global/',null,'feature',{source:'user',owner:'page-A'});
assert.equal(click.autoplay,true);assert.equal(click.method,'pushState');
});
test('G1: repeated button-open and dismiss returns to one original history entry',()=>{
const original={url:'https://preview.example/assets/global/?campaign=owner#cinema',state:{hostContext:'preserved'}};
const stack=[original];let index=0;
for(const id of ['feature','07-coffee','02-fashion']){
 const open=openFilmRoute(stack[index].url,stack[index].state,id,{source:'user',owner:'page-A'});
 assert.equal(open.method,'pushState');assert.equal(open.state.hostContext,'preserved');
 stack.splice(index+1);stack.push({url:new URL(open.url,original.url).href,state:open.state});index++;
 const close=closeFilmRoute(stack[index].url,stack[index].state,{owner:'page-A'});
 assert.equal(close.method,'back');index--;
 assert.deepEqual(stack[index],original);assert.equal(stack.length,2,'A new opening replaces the previous forward branch');
 const forward=openFilmRoute(stack[1].url,stack[1].state,id,{owner:'page-A'});
 assert.equal(forward.method,null);assert.equal(forward.autoplay,false);
}
assert.equal(index,0);
});
test('G1: closing a direct or reloaded film cleans its URL without navigating away',()=>{
const href='https://preview.example/assets/global/en/?campaign=owner&film=feature#cinema';
const direct=closeFilmRoute(href,{hostContext:7},{owner:'page-A'});
assert.equal(direct.method,'replaceState');assert.equal(direct.url,'/assets/global/en/?campaign=owner#cinema');assert.deepEqual(direct.state,{hostContext:7});
const open=openFilmRoute('https://preview.example/assets/global/',null,'feature',{source:'user',owner:'page-A'});
const reload=closeFilmRoute(new URL(open.url,href).href,open.state,{owner:'page-B'});
assert.equal(reload.method,'replaceState');assert.equal(reload.url,'/assets/global/');
});
test('G1: switching an owned film does not accumulate modal history entries',()=>{
const href='https://preview.example/assets/global/#cinema';
const first=openFilmRoute(href,null,'feature',{source:'user',owner:'page-A'});
const next=openFilmRoute(new URL(first.url,href).href,first.state,'07-coffee',{source:'user',owner:'page-A'});
assert.equal(next.method,'replaceState');
const close=closeFilmRoute(new URL(next.url,href).href,next.state,{owner:'page-A'});
assert.equal(close.method,'back');assert.equal(close.url,'/assets/global/#cinema');
});
