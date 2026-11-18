import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const html=await readFile(new URL('../assets/guest/console.html',import.meta.url),'utf8');
const js=await readFile(new URL('../assets/guest/console.js',import.meta.url),'utf8');

test('R4 console runs only same-origin authenticated API, never local storage',()=>{
  assert.match(js,/const API='\/api\/industry\/v1'/);
  assert.match(js,/credentials:'same-origin'/);
  assert.match(js,/X-CSRF-Token/);
  assert.match(js,/cache:'no-store'/);
  assert.doesNotMatch(js,/\blocalStorage\b|\bsessionStorage\b|sendBeacon|eval\(/);
  assert.doesNotMatch(js,/\.innerHTML\s*=/);
});
test('R4 console declares strict Content Security Policy',()=>{
  assert.match(html,/connect-src 'self'/);
  assert.match(html,/object-src 'none'/);
  assert.match(html,/base-uri 'none'/);
  assert.match(html,/script-src 'self'/);
  assert.match(html,/form-action 'self'/);
  assert.match(html,/src="\.\/console\.js"/);
  assert.ok(!html.includes('checkout') && !html.includes('buy.stripe.com'));
});
test('R4 console uses all essential user-facing controls',()=>{
  for(const id of [
    'loginForm','loginPanel','workPanel','tenant','email','password',
    'requestForm','requestsList','requestTitle','requestSource','requestId',
    'pilotForm','pilotTitle','pilotHeading','pilotsList','detailPanel',
    'saveReady','start','observationForm','observationList','submitReview',
    'accept','return','resume','loadReport','downloadReport','globalStatus'
  ])assert.ok(html.includes('id="'+id+'"'),'Missing id '+id);
  assert.match(html,/data-ready="contactConsent"/);
  assert.match(html,/не сохранит введённые сведения/);
});
test('R4 console does not claim payments or success before server confirmation',()=>{
  assert.match(html,/Не демонстрация успешных продаж/);
  assert.match(html,/Не подтверждает причинную связь|не подтверждает причинную связь/);
  assert.match(js,/Нет соединения с Industry API/);
  assert.match(js,/api\('\/guest\/pilots'/);
});
