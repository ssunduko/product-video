// Trace -> script authoring (author.mjs): narration budgeting and the headers
// a trace carries into its .demo.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHARS_PER_SEC, speechMs, budget, demoFromTrace } from '../../author.mjs';
import { parseScript } from '../../script.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The committed example trace: every step op author.mjs understands.
const exampleTrace = () =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'grammar-tour.trace.json'), 'utf8'));

describe('speechMs', () => {
  test('sizes a line at CHARS_PER_SEC', () => {
    assert.equal(speechMs('x'.repeat(25)), Math.round((25 / CHARS_PER_SEC) * 1000));
    assert.equal(speechMs(''), 0);
  });
});

describe('budget', () => {
  test('places every line that fits, with a gap between them', () => {
    const lines = ['a'.repeat(25), 'b'.repeat(25)]; // 2s each
    const b = budget(10000, lines);
    assert.equal(b.placed.length, 2);
    assert.equal(b.placed[0].atMs, 0);
    assert.ok(b.placed[1].atMs >= b.placed[0].durMs + 500, 'second line waits for the first');
    assert.deepEqual(b.unused, []);
  });

  test('keeps the lines that do not fit in the wait', () => {
    const b = budget(2500, ['a'.repeat(25), 'b'.repeat(25)]);
    assert.equal(b.placed.length, 1);
    assert.deepEqual(b.unused, ['b'.repeat(25)]);
  });

  test('offers a fast-forward only for a long uncovered stretch', () => {
    assert.equal(budget(4000, ['a'.repeat(25)]).speedRange, null);
    const long = budget(30000, ['a'.repeat(25)]);
    assert.equal(long.uncoveredMs, 30000 - long.coveredMs);
    assert.deepEqual(long.speedRange, [long.coveredMs + 1500, 30000 - 1500]);
  });

  test('stops talking at the ceiling on a very long wait', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i} `.padEnd(25, '.'));
    const b = budget(120000, lines);
    assert.ok(b.coveredMs <= 22000, `covered ${b.coveredMs}ms`);
    assert.ok(b.unused.length > 0);
  });
});

describe('demoFromTrace', () => {
  test('writes intro-avatar and outro-avatar headers from the trace', () => {
    const trace = { ...exampleTrace(), introAvatar: 'avatar/t-intro.mp4', outroAvatar: 'avatar/t-outro.mp4' };
    const { demo } = demoFromTrace(trace);
    assert.match(demo, /^intro-avatar: avatar\/t-intro\.mp4$/m);
    assert.match(demo, /^outro-avatar: avatar\/t-outro\.mp4$/m);

    // and the script it writes parses back to the same clips
    const { meta } = parseScript(demo, { file: 't.demo' });
    assert.equal(meta.introAvatar, 'avatar/t-intro.mp4');
    assert.equal(meta.outroAvatar, 'avatar/t-outro.mp4');
  });

  test('writes no avatar headers when the trace has none', () => {
    const { demo } = demoFromTrace(exampleTrace());
    assert.doesNotMatch(demo, /-avatar:/);
  });

  test('ends the script on a hold, so the last zoom can settle', () => {
    const { demo } = demoFromTrace(exampleTrace());
    const last = demo.trim().split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).at(-1);
    assert.match(last, /^\s*hold /);
  });

  test('marks a hand-written trace as such in the sidecar', () => {
    const trace = exampleTrace();
    delete trace.resolvedBy;
    const { sidecar } = demoFromTrace(trace);
    assert.match(sidecar.resolvedBy, /hand-authored/);
  });
});
