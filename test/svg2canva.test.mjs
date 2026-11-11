import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { convertSvg, listSlides, parseMapping } from '../scripts/svg2canva.mjs';
import { sampleSvg } from './svg-sample.mjs';

test('mappings send slides to pages', () => {
  const pairs = (jobs) => jobs.map((j) => `${j.slide}:${j.page}`);
  assert.deepEqual(pairs(parseMapping([], 3)), ['1:1', '2:2', '3:3']);
  assert.deepEqual(pairs(parseMapping(['2'], 3)), ['2:2']);
  assert.deepEqual(pairs(parseMapping(['2:5'], 3)), ['2:5']);
  assert.deepEqual(pairs(parseMapping(['1-3:10'], 3)), ['1:10', '2:11', '3:12']);
  assert.deepEqual(pairs(parseMapping(['3', '1-2:7'], 3)), ['3:3', '1:7', '2:8']);
  assert.throws(() => parseMapping(['1-2', '3:1'], 3), /Page 1 is the target of two slides/);
  assert.throws(() => parseMapping(['4'], 3), /no slide 4: found 3 SVG files/);
  assert.throws(() => parseMapping(['3-1'], 3), /runs backwards/);
  assert.throws(() => parseMapping(['x'], 3), /Can't read "x"/);
});

test('slides are the folder\'s SVG files in name order, numbers compared as numbers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svg2canva-'));
  try {
    for (const n of ['a10.svg', 'a2.svg', 'a1.svg', 'notes.txt']) await fs.writeFile(path.join(dir, n), '<svg/>');
    assert.deepEqual(listSlides(dir).map((f) => path.basename(f)), ['a1.svg', 'a2.svg', 'a10.svg']);
    assert.deepEqual(listSlides(path.join(dir, 'a2.svg')).map((f) => path.basename(f)), ['a2.svg']);
    assert.throws(() => listSlides(path.join(dir, 'missing')), /doesn't exist/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a slide becomes Canva operations scaled to the page', () => {
  const { ops, formats, warnings } = convertSvg(sampleSvg);
  const [background, ...rest] = ops;
  assert.deepEqual(background, { op: 'set_background', color: '#075c4b' }, 'the gradient\'s middle color');

  // The gradient: 30 bands in shapes of at most 6 colors, covering the page.
  const bands = rest.slice(0, 5);
  for (const s of bands) {
    assert.deepEqual([s.op, s.top, s.left, s.width, s.height], ['insert_shape', 0, 0, 1920, 1080]);
    assert.ok(new Set(s.paths.map((p) => p.color)).size <= 6);
  }
  assert.equal(bands.flatMap((s) => s.paths).length, 30);

  const [rect, cardFill, cardOutline, circle, line, chevron, curve, title, centered] = rest.slice(5);
  assert.deepEqual(rect, { op: 'insert_rect', top: 150, left: 150, width: 300, height: 75, color: '#ffffff' });
  assert.equal(cardFill.transparency, 0.9);
  assert.equal(cardFill.paths[0].color, '#ffffff');
  assert.equal(cardOutline.transparency, 0.7, 'outline and fill have their own opacity');
  assert.deepEqual(cardOutline.paths[0], { d: cardOutline.paths[0].d, strokeColor: '#ffffff', strokeWeight: 3 });
  assert.deepEqual([circle.top, circle.left, circle.width, circle.transparency, circle.paths[0].color], [90, 75, 30, 0.5, '#f5b301'], 'translated, inherited fill and opacity');
  assert.deepEqual([line.op, line.top, line.left, line.width, line.height, line.transparency], ['insert_rect', 449.3, 96, 1728, 1.5, 0.8]);
  assert.equal(chevron.paths[0].color, '#f5b301', 'a stroked polyline becomes a filled outline');
  assert.match(curve.paths[0].d, /C/);
  assert.doesNotMatch(curve.paths[0].d, /[qt]/i);

  assert.equal(title.text, 'Title\nSecond line');
  assert.equal(title.top, 78.2, 'baseline 70 scaled, less the ascent');
  assert.deepEqual(title.formatting, { fontSize: 28.2, color: '#f5b301', fontWeight: 'bold', textAlign: 'start', lineHeightEm: 1.28, letterSpacingEm: 0.106 });
  assert.deepEqual(formats, [{ insert: rest.indexOf(title), find: 'Second line', formatting: { color: '#ffffff', fontWeight: 'normal' } }]);
  assert.equal(centered.formatting.textAlign, 'center');
  assert.equal(centered.transparency, 0.5);
  assert.equal(centered.left + centered.width / 2, 960);

  assert.ok(warnings.some((w) => /Dashed outlines are drawn solid/.test(w)));
  assert.ok(warnings.some((w) => /Images were left out/.test(w)));
});

test('a slide is scaled to fit and centered on a page of another shape', () => {
  const { ops, warnings } = convertSvg(sampleSvg, { pageWidth: 1080, pageHeight: 1080 });
  const rect = ops.find((o) => o.op === 'insert_rect' && o.color === '#ffffff');
  // 1080/1280 = 0.84375; the slide is 607.5 tall, centered vertically.
  assert.deepEqual([rect.left, rect.top, rect.width], [84.4, 320.6, 168.8]);
  assert.ok(warnings.some((w) => /differ in shape/.test(w)));
});
