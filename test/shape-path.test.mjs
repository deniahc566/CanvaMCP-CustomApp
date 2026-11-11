import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeShapePath } from '../dist/canva/shape-path.js';

test('paths Canva already accepts come back unchanged', () => {
  for (const d of ['M0 0 L10 0 L10 10 Z', 'M0 0 H10 V10 C10 20 0 20 0 10 S-10 0 0 0', 'M0,0 10,0 10,10z', 'M0 0 a5 5 0 1010 0 z']) {
    assert.equal(normalizeShapePath(d), d);
  }
});

test('Q curves become the same curves drawn with C', () => {
  // A rounded corner: from (324, 0) through control (330, 0) to (330, 6).
  assert.equal(normalizeShapePath('M6 0 H324 Q330 0 330 6 V98 Z'), 'M6 0 L324 0 C328 0 330 2 330 6 L330 98 Z');
});

test('relative q and t, with t reflecting the previous control point', () => {
  assert.equal(
    normalizeShapePath('M0 0 q5 10 10 0 t10 0 Z'),
    'M0 0 C3.3333 6.6667 6.6667 6.6667 10 0 C13.3333 -6.6667 16.6667 -6.6667 20 0 Z',
  );
  // T with no Q before it uses the current point as its control point.
  assert.equal(normalizeShapePath('M0 0 T10 0 L10 10 Z'), 'M0 0 C0 0 3.3333 0 10 0 L10 10 Z');
});

test('an S after a Q does not reflect the Q control point once rewritten', () => {
  assert.equal(normalizeShapePath('M0 0 Q5 10 10 0 S20 10 20 0 Z'), 'M0 0 C3.3333 6.6667 6.6667 6.6667 10 0 C10 0 20 10 20 0 Z');
});

test('relative m, implicit lines, arcs with packed flags and closing by coordinates', () => {
  assert.equal(normalizeShapePath('m1 1 10 0 0 10 q-5 0 -10 -10'), 'M1 1 L11 1 L11 11 C7.6667 11 4.3333 7.6667 1 1');
  assert.equal(normalizeShapePath('M0 0 a5 5 0 1010 0 q0 5 -10 0 z'), 'M0 0 A5 5 0 1 0 10 0 C10 3.3333 6.6667 3.3333 0 0 Z');
});

test('paths Canva would refuse on save are rejected with the reason', () => {
  assert.throws(() => normalizeShapePath('L0 0 L10 0 Z'), /must start with an M command/);
  assert.throws(() => normalizeShapePath('M0 0 L10 0 L10 10 Z M20 20 L30 20 L30 30 Z'), /only one M command per path/);
  assert.throws(() => normalizeShapePath('M0 0 L10 0 L10 10'), /closed paths/);
  assert.throws(() => normalizeShapePath('M0 0 Q5 5 10 0'), /closed paths/);
  assert.throws(() => normalizeShapePath('M0 0 L10 x Z'), /Expected a number at position 10/);
  assert.throws(() => normalizeShapePath('M0 0 X10 0 Z'), /"X" isn't an SVG path command/);
  assert.throws(() => normalizeShapePath('M0 0 L10 0 Z 5 5'), /Expected a path command at position 14/);
});
