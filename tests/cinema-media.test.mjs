import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(join(root, path));
const text = path => read(path).toString('utf8');
const media = 'assets/stories/';
const manifest = JSON.parse(text(media + 'manifest.json'));

test('all 12 cinematic episodes are present, correct and independently hashed', () => {
  assert.equal(manifest.video_count, 12);
  assert.equal(manifest.clips.length, 12);
  const ids = new Set();
  for (const clip of manifest.clips) {
    assert.match(clip.id, /^\d{2}-[a-z-]+$/);
    assert(!ids.has(clip.id), 'Duplicate video id: ' + clip.id);
    ids.add(clip.id);
    assert.equal(clip.video, '/assets/stories/media/' + clip.id + '.mp4');
    assert.equal(clip.poster, '/assets/stories/posters/' + clip.id + '.webp');
    for (const asset of [clip.video, clip.poster]) assert(existsSync(join(root, asset.slice(1))), 'Missing ' + asset);
    const data = read(clip.video.slice(1));
    assert.equal(data.length, clip.bytes, clip.id + ' size');
    assert.equal(createHash('sha256').update(data).digest('hex'), clip.sha256, clip.id + ' SHA-256');
    assert(data.includes(Buffer.from('ftyp')), clip.id + ' MP4 container');
  }
});

test('original soundtrack film and all six scenes exist', () => {
  const file = join(root, media, 'media/00-osmanx-film.mp4');
  assert(statSync(file).size > 2500000);
  assert.equal(createHash('sha256').update(read(media + 'media/00-osmanx-film.mp4')).digest('hex'), 'b287b0dd28eb772e2204c64d977418f9cce95d60d5b5ef02ba6130314d0004df');
  for (let i=1;i<=6;i++) assert(statSync(join(root,media,'slides/scene-'+i+'.webp')).size > 10000);
  for (const name of ['00-intro','01-guest','02-retail','03-time','04-leads','99-outro'])
    assert(statSync(join(root,media,'cards/'+name+'.png')).size > 10000);
});

test('cinema page references only durable local assets and honest examples', () => {
  const html = text(media+'cinema.html');
  const css = text(media+'cinema.css');
  const js = text(media+'cinema.js');
  assert.match(html, /osmanx-cinema-experience-r1/);
  assert.match(html, /\/assets\/stories\/media\/00-osmanx-film\.mp4/);
  assert.match(html, /Постановочные AI-сцены/);
  assert.match(html, /Guest Intelligence/);
  assert.match(html, /Retail Intelligence/);
  assert.match(html, /Industry OS/);
  assert.match(html, /prefers-reduced-motion|cinema\.css/);
  assert.doesNotMatch(html+css+js, /cloudfront\.net|_jwt=|runwayml\.com/i);
  assert.doesNotMatch(html, /\bautoplay\b/i);
  assert.match(js, /const episodes=/);
  assert.equal((js.match(/id:'\d\d-[a-z-]+'/g)||[]).length,12);
  assert(existsSync(join(root,media,'downloads/OSMANX_Invisible_Losses_Presentation.pptx')));
});

test('cinema navigation points to a real page on all entrypoints', () => {
  for(const file of ['index.html','assets/catalog/index.html','assets/guest/offer.html','assets/stories/index.html','assets/industry/index.html','assets/sovereign/site.js'])
    assert.match(text(file), /\/assets\/stories\/cinema\.html/, 'Missing cinema link: '+file);
});
