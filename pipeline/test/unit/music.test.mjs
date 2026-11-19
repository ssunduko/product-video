// Background music (music.mjs): the spec, the speech spans the bed ducks under,
// the gain that sets it under the voice, and the vendored engine itself.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseMusic, speechSpans, bedGainDb, ENGINE_LUFS, DEFAULT_UNDER_DB, MUSIC_STYLES } from '../../music.mjs';
import { renderSoundtrack } from '../../vendor/music-engine/soundtrack.js';

describe('normaliseMusic', () => {
  test('true means the default style at the calibrated volume', () => {
    assert.deepEqual(normaliseMusic(true), { style: 'warm', volume: 0.5, underDb: DEFAULT_UNDER_DB });
  });

  test('nothing means no music', () => {
    assert.equal(normaliseMusic(undefined), null);
    assert.equal(normaliseMusic(false), null);
  });

  test('a file keeps no style', () => {
    const m = normaliseMusic({ src: 'brand/music/a.mp3', volume: 0.3 });
    assert.equal(m.style, undefined);
    assert.equal(m.src, 'brand/music/a.mp3');
  });

  test('refuses a bad style, style with src, and out-of-range numbers', () => {
    assert.throws(() => normaliseMusic({ style: 'disco' }), /unknown style "disco".*warm/);
    assert.throws(() => normaliseMusic({ style: 'tech', src: 'a.mp3' }), /not both/);
    assert.throws(() => normaliseMusic({ volume: 2 }), /volume/);
    assert.throws(() => normaliseMusic({ underDb: 2 }), /underDb/);
  });

  test('every style the engine offers is accepted', () => {
    for (const style of Object.keys(MUSIC_STYLES)) assert.equal(normaliseMusic({ style }).style, style);
  });
});

describe('speechSpans', () => {
  test('the gaps between silences, to the end', () => {
    assert.deepEqual(speechSpans([[0, 1], [3, 4]], 6), [{ start: 1, end: 3 }, { start: 4, end: 6 }]);
  });

  test('speech from the start, silence to the end', () => {
    assert.deepEqual(speechSpans([[2, Infinity]], 5), [{ start: 0, end: 2 }]);
  });

  test('no silence is all speech; unsorted or overlapping silences are fine', () => {
    assert.deepEqual(speechSpans([], 3), [{ start: 0, end: 3 }]);
    assert.deepEqual(speechSpans([[5, 6], [0, 2], [1.5, 3]], 8), [{ start: 3, end: 5 }, { start: 6, end: 8 }]);
  });
});

describe('bedGainDb', () => {
  test('moves the calibrated bed to underDb under the voice', () => {
    assert.equal(bedGainDb(-16, 14), -16 - 14 - ENGINE_LUFS);
    assert.equal(bedGainDb(-20, 12), 0);
  });

  test('refuses an unmeasured voice', () => {
    assert.throws(() => bedGainDb(NaN), /could not be measured/);
  });
});

describe('vendored engine', () => {
  const render = () => renderSoundtrack({ duration: 2, sampleRate: 8000, music: { style: 'tech', seed: 3 }, voiceSpans: [{ start: 0.5, end: 1.2 }] });

  test('the same spec gives the same samples, and not silence', async () => {
    const [a, b] = [await render(), await render()];
    const la = a.getChannelData(0);
    const lb = b.getChannelData(0);
    assert.equal(la.length, 16000);
    assert.deepEqual(la, lb);
    assert.ok(la.some((x) => Math.abs(x) > 1e-4));
  });
});
