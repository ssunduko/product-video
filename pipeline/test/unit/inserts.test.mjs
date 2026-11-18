// Stills inside a part (inserts.mjs): when each shows, where the app window is,
// and how an image fits into it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { insertSchedule, findWindowRect, fitRect, overlayTimes, cardHolds, FADE_S } from '../../inserts.mjs';

const SPANS = [
  { headline: 'One', start: 10, end: 14 },
  { headline: 'Two', start: 30, end: 34 },
  { headline: 'Three', start: 50, end: 54 },
];

describe('insertSchedule', () => {
  test('fills from the end of the card to the start of the next', () => {
    const s = insertSchedule(SPANS, { section: 'Two', images: [{ file: 'a.jpg' }] }, 90);
    assert.equal(s.length, 1);
    assert.equal(s[0].startS, 34);
    assert.equal(s[0].endS, 50);
  });

  test('the last section runs to the given end (the outro start)', () => {
    const s = insertSchedule(SPANS, { section: 'Three', images: [{ file: 'a.jpg' }] }, 70);
    assert.equal(s[0].startS, 54);
    assert.equal(s[0].endS, 70);
  });

  test('splits the span by share, contiguous, ending exactly at the next card', () => {
    const s = insertSchedule(SPANS, { section: 'One', images: [{ file: 'a', share: 0.25 }, { file: 'b', share: 0.75 }] }, 90);
    assert.equal(s[0].startS, 14);
    assert.equal(s[0].endS, 18);
    assert.equal(s[1].startS, 18);
    assert.equal(s[1].endS, 30);
    assert.equal(s[1].file, 'b');
  });

  test('equal shares by default', () => {
    const s = insertSchedule(SPANS, { section: 'One', images: [{ file: 'a' }, { file: 'b' }] }, 90);
    assert.equal(s[0].endS, 22);
  });

  test('names the cards when the section is unknown', () => {
    assert.throws(() => insertSchedule(SPANS, { section: 'Nope', images: [{ file: 'a' }] }, 90), /no section card "Nope".*One, Two, Three/);
  });

  test('refuses a span too short to fade in and out', () => {
    const tight = [{ headline: 'A', start: 0, end: 5 }, { headline: 'B', start: 5 + FADE_S, end: 9 }];
    assert.throws(() => insertSchedule(tight, { section: 'A', images: [{ file: 'a' }] }, 20), /leaves no room/);
  });

  test('refuses a section with no images, or a zero share', () => {
    assert.throws(() => insertSchedule(SPANS, { section: 'One', images: [] }, 90), /no images/);
    assert.throws(() => insertSchedule(SPANS, { section: 'One', images: [{ file: 'a', share: 0 }] }, 90), /share/);
  });
});

describe('overlayTimes and cardHolds', () => {
  const XF = 0.5;
  const slots = insertSchedule(SPANS, { section: 'One', images: [{ file: 'a', share: 0.25 }, { file: 'b', share: 0.75 }] }, 90);

  test('first plate dissolves in over the card for the card dissolve, plate into plate, last out over the next card', () => {
    const t = overlayTimes(slots, XF);
    assert.deepEqual(t[0], { from: 14 - XF, to: 18 + FADE_S, fadeIn: XF, fadeOut: 0 });
    assert.deepEqual(t[1], { from: 18, to: 30 + XF, fadeIn: FADE_S, fadeOut: XF });
    // the first stays fully up until the second has dissolved over it
    assert.ok(t[0].to >= t[1].from + t[1].fadeIn);
  });

  test('card stills cover exactly the two card dissolves, taken from inside each card', () => {
    const h = cardHolds(slots, XF);
    assert.deepEqual(h[0], { from: 14 - XF, to: 14, grabS: 14 - XF - 0.1 });
    assert.deepEqual(h[1], { from: 30, to: 30 + XF, grabS: 30 + XF + 0.1 });
    // each grab is inside its card span (clear of both dissolves)
    assert.ok(h[0].grabS > SPANS[0].start + XF && h[0].grabS < SPANS[0].end - XF);
    assert.ok(h[1].grabS > SPANS[1].start + XF && h[1].grabS < SPANS[1].end - XF);
  });

  test('a single image: in over one card, out over the next', () => {
    const one = insertSchedule(SPANS, { section: 'Two', images: [{ file: 'a' }] }, 90);
    assert.deepEqual(overlayTimes(one, XF)[0], { from: 34 - XF, to: 50 + XF, fadeIn: XF, fadeOut: XF });
  });
});

// a frame of brand blue with a light window at (20,10) 60x40
function frame(w = 100, h = 60, win = { x: 20, y: 10, w: 60, h: 40 }) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const inside = x >= win.x && x < win.x + win.w && y >= win.y && y < win.y + win.h;
      const [r, g, b] = inside ? [245, 247, 250] : [27, 133, 230];
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  return d;
}

describe('findWindowRect', () => {
  test('finds the window inside the brand background', () => {
    assert.deepEqual(findWindowRect(frame(), 100, 60), { x: 20, y: 10, w: 60, h: 40 });
  });

  test('ignores dark content inside the window', () => {
    const d = frame();
    // a dark-blue block inside the window, off the centre lines
    for (let y = 12; y < 20; y++) for (let x = 22; x < 40; x++) { const o = (y * 100 + x) * 4; d[o] = 10; d[o + 1] = 40; d[o + 2] = 200; }
    assert.deepEqual(findWindowRect(d, 100, 60), { x: 20, y: 10, w: 60, h: 40 });
  });

  test('refuses a frame with no window (a title card)', () => {
    assert.throws(() => findWindowRect(frame(100, 60, { x: 0, y: 0, w: 0, h: 0 }), 100, 60), /could not find the app window/);
  });
});

describe('fitRect', () => {
  test('a wider image is letterboxed top and bottom, centred', () => {
    assert.deepEqual(fitRect({ x: 100, y: 50, w: 1600, h: 900 }, 2000, 1000), { x: 100, y: 100, w: 1600, h: 800, scale: 0.8 });
  });

  test('a taller image is pillarboxed', () => {
    const f = fitRect({ x: 0, y: 0, w: 1600, h: 900 }, 900, 900);
    assert.equal(f.h, 900);
    assert.equal(f.w, 900);
    assert.equal(f.x, 350);
  });
});
