import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync, existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {validatePublication} from '../editorial/moscow-1000/validate-publication.mjs';
const root=resolve(import.meta.dirname,'..');
const file=p=>readFileSync(join(root,p),'utf8');
const wrap={};runInNewContext(file('moscow-1000/geo.js'),{globalThis:wrap});
const geo=wrap.OSMANX_GEO;
const pub={};runInNewContext(file('moscow-1000/publication.js'),{globalThis:pub});
test('10 public geographic clusters and only approximate area anchors',()=>{
 assert.equal(geo.days.length,10);assert.deepEqual(Array.from(geo.days,d=>d.number),Array.from({length:10},(_,i)=>i+1));
 for(const day of geo.days){assert.equal(day.anchors.length,2);assert.ok(day.title&&day.focus);for(const a of day.anchors){assert.equal(a.kind,'area_anchor');assert.ok(a.lat>55.6&&a.lat<55.9);assert.ok(a.lng>37.4&&a.lng<37.8);assert.ok(!('contact' in a));}}
});
test('slippy map uses visible OSM tiles, attribution, no geolocation or fake routes',()=>{
 const js=file('moscow-1000/map.js'),html=file('moscow-1000/serial/index.html');assert.match(js,/tile.openstreetmap.org/);assert.match(js,/referrerPolicy='strict-origin-when-cross-origin'/);assert.doesNotMatch(js,/geolocation\.getCurrentPosition|watchPosition|bulkFetch\(/i);assert.match(html,/OpenStreetMap contributors/);assert.match(html,/не содержит проверенных пешеходных маршрутов/i);
});
test('public release defaults to unpublished, never zero fake outcomes',()=>{assert.equal(pub.OSMANX_APPROVED_PUBLICATION.status,'unpublished');assert.equal(pub.OSMANX_APPROVED_PUBLICATION.metrics,null);assert.equal(pub.OSMANX_APPROVED_PUBLICATION.days.length,0);});
test('editorial validation rejects private information, unknown fields, false attribution',()=>{
 const good={schemaVersion:2,status:'published',reviewedAt:'2026-11-20T12:00:00Z',reviewer:'OSMANX редактор',method:'Ручная проверка журнала; выборка нерепрезентативна',metrics:{researched:30,visits:10,dialogues:5,decisionMeetings:2,proposals:1,pilots:1,contracts:0},days:[{day:1,summary:'Проведено пять интервью по методике.',lesson:'Гипотезы требуют продолжения проверки.',approvedForWeb:true}]};
 assert.deepEqual(validatePublication(good),[]);
 assert.ok(validatePublication({...good,privateCRM:[{phone:'123'}]}).length>0);
 assert.ok(validatePublication({...good,days:[{...good.days[0],summary:'Пишите на example@mail.com'}]}).length>0);
 assert.ok(validatePublication({...good,reviewedAt:null}).length>0);
 assert.ok(validatePublication({...good,metrics:{...good.metrics,pilots:3}}).length>0);
 assert.ok(validatePublication({...good,days:[{...good.days[0],approvedForWeb:false}]}).length>0);
});
test('public safe link between each episode and an area without private contact state',()=>{
 const frontend=file('moscow-1000/public-r2.js'),geoJs=file('moscow-1000/geo.js'),publication=file('moscow-1000/publication.js');assert.doesNotMatch(frontend+geoJs+publication,/localStorage|\.DB\.prepare|OSMANX_PRIVATE|contactPerson/i);
 for(let i=1;i<=10;i++){const page=file('moscow-1000/episodes/'+String(i).padStart(2,'0')+'/index.html');assert.match(page,/id="episode-r2"/);assert.match(page,/public-r2.js/);}assert.match(frontend,/approvedForWeb===true/);
});
test('form is explicitly fail-closed and only active with configured health and Turnstile',()=>{const js=file('moscow-1000/intake.js'),html=file('moscow-1000/serial/index.html');assert.match(html,/id="r2-lead-form" class="r2-form" hidden/);assert.match(html,/id="r2-subscribe-form" hidden/);assert.match(js,/cfg.leadsEnabled/);assert.match(js,/turnstileToken/);assert.match(js,/window.turnstile.reset/);assert.match(html,/mailto:hello@osmanx.world/);});
test('Cloudflare worker is outside public-deployed web directory',()=>{assert.ok(existsSync(join(root,'services/moscow-1000-api/index.mjs')));assert.ok(!existsSync(join(root,'moscow-1000/worker')));assert.match(file('services/moscow-1000-api/index.mjs'),/siteverify/);});
test('R2 contributes all files needed for site without modifying R1 archive source',()=>{for(const name of ['map.js','geo.js','publication.js','public-r2.js','intake.js','index.html','app.js','content.js','styles.css'])assert.ok(existsSync(join(root,'moscow-1000',name)));assert.ok(existsSync(join(root,'moscow-1000/serial/index.html')));assert.match(file('moscow-1000/serial/index.html'),/id="map-day-list"/);assert.match(file('moscow-1000/serial/index.html'),/id="public-funnel"/);});
