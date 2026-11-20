import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('OSMANX main invitation leads to real MARCOSA membership', () => {
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/id="marcosa-membership"/);
  assert.match(html,/href="https:\/\/marcosa\.club\/#join"/);
  assert.match(html,/href="https:\/\/marcosa\.club\/#contact"/);
  assert.doesNotMatch(html,/mailto:hello@osmanx\.world/);
});
test('The 12-episode original cinema routes conversation to MARCOSA', () => {
  const html=readFileSync(new URL('../assets/stories/cinema.html',import.meta.url),'utf8');
  assert.match(html,/id="mc-title"/);
  assert.match(html,/https:\/\/marcosa\.club\/#join/);
  assert.match(html,/https:\/\/marcosa\.club\/#contact/);
  assert.doesNotMatch(html,/mailto:hello@osmanx\.world/);
  assert.match(html,/id="episode-grid"/);
});

test('Business inquiry is routed to MARCOSA instead of direct email', () => {
  const offer=readFileSync(new URL('../assets/guest/offer.html',import.meta.url),'utf8');
  const order=readFileSync(new URL('../assets/guest/order.html',import.meta.url),'utf8');
  assert.match(offer,/https:\/\/marcosa\.club\/#contact/);
  assert.match(order,/marcosaContact/);
  assert.match(order,/#contact/);
  assert.doesNotMatch(order,/mailto:/);
  assert.doesNotMatch(offer,/mailto:/);
});
test('Original stories redirect episode playback to private MARCOSA', () => {
  const js=readFileSync(new URL('../assets/stories/cinema.js',import.meta.url),'utf8');
  const gallery=readFileSync(new URL('../assets/stories/index.html',import.meta.url),'utf8');
  assert.match(js,/window\.location\.assign\('https:\/\/marcosa\.club\/#series'\)/);
  assert.match(gallery,/window\.location\.assign\('https:\/\/marcosa\.club\/#series'\)/);
  assert.match(gallery,/href="https:\/\/marcosa\.club\/#contact"/);
  assert.doesNotMatch(gallery,/mailto:/);
});
