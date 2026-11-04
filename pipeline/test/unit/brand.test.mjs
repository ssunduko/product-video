// Brand colour helpers (brand.mjs), shared by the compositor and the cards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbOf, hexOf, mix, shade } from '../../brand.mjs';

test('rgbOf and hexOf round-trip a hex colour', () => {
  assert.deepEqual(rgbOf('#2563eb'), [0x25, 0x63, 0xeb]);
  assert.equal(hexOf([0x25, 0x63, 0xeb]).toLowerCase(), '#2563eb');
});

test('mix returns each end at 0 and 1 and the midpoint between', () => {
  assert.equal(mix('#000000', '#ffffff', 0).toLowerCase(), '#000000');
  assert.equal(mix('#000000', '#ffffff', 1).toLowerCase(), '#ffffff');
  const [r, g, b] = rgbOf(mix('#000000', '#ffffff', 0.5));
  for (const c of [r, g, b]) assert.ok(c >= 127 && c <= 128, String(c));
});

test('shade darkens without changing the colour at 0', () => {
  assert.equal(shade('#2563eb', 0).toLowerCase(), '#2563eb');
  const sum = (hex) => rgbOf(hex).reduce((a, c) => a + c, 0);
  assert.ok(sum(shade('#2563eb', 0.5)) < sum('#2563eb'));
});
