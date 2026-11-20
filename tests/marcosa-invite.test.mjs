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
