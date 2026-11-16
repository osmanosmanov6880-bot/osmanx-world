'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const catalog=require('../catalog.json');
test('catalog contains exactly five selected OSMANX platforms',()=>{
 assert.equal(catalog.length,5);
 assert.deepEqual(catalog.map(p=>p.id),['world','retail','factory','omnichat','senqard']);
 assert.equal(catalog.find(p=>p.id==='omnichat').url,'https://osmanx.world/assets/omnichat/index.html');
 assert.equal(new Set(catalog.map(x=>x.id)).size,catalog.length);
 for(const p of catalog){assert.match(p.id,/^[a-z]+$/);assert.ok(p.name.length>=5);assert.ok(p.status);assert.ok(p.description.length>=35)}
});
test('no private repo is mistakenly linked as public software',()=>{
 for(const p of catalog){if(p.url){const u=new URL(p.url);assert.equal(u.protocol,'https:');assert.ok(['github.com','osmanx.world'].includes(u.hostname))}
  if(p.id==='senqard')assert.ok(p.url.endsWith('?app=senqard'))}
});
test('renderer has explicit restrictive content security policy',()=>{
 const html=readFileSync(path.join(__dirname,'../renderer/index.html'),'utf8');
 assert.match(html,/default-src 'none'/);assert.match(html,/connect-src 'none'/);
});
test('main does not enable node in web content',()=>{
 const js=readFileSync(path.join(__dirname,'../main.cjs'),'utf8');
 assert.match(js,/nodeIntegration:false/);assert.match(js,/contextIsolation:true/);assert.match(js,/sandbox:true/);assert.match(js,/setWindowOpenHandler/);
});
