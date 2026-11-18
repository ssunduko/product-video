// paths.mjs captureSpace: boxes and cursor are normalised by the captured frame
// size, which can differ from the viewport the driver logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureSpace } from '../../paths.mjs';

test('uses the captured frame size when it differs from the logged viewport', () => {
  assert.deepEqual(captureSpace({ width: 1440, height: 810 }, { width: 1456, height: 799 }), { width: 1456, height: 799, differs: true });
});

test('matches when the frame size is the viewport', () => {
  assert.deepEqual(captureSpace({ width: 1440, height: 810 }, { width: 1440, height: 810 }), { width: 1440, height: 810, differs: false });
});

test('falls back to the viewport when the frame size is unknown or invalid', () => {
  const v = { width: 1440, height: 810 };
  for (const f of [null, undefined, { width: 0, height: 799 }, { width: NaN, height: 799 }]) {
    assert.deepEqual(captureSpace(v, f), { width: 1440, height: 810, differs: false });
  }
});

test('a box normalised by the frame size lands where the element is drawn', () => {
  // a 445px-wide field at x=363 on a 1456px-wide frame
  const s = captureSpace({ width: 1440, height: 810 }, { width: 1456, height: 799 });
  assert.ok(Math.abs(363 / s.width - 0.2493) < 1e-3);
  assert.notEqual(363 / s.width, 363 / 1440);
});
