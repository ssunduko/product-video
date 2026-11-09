// Section cards: the `card` command (script.mjs), finding each card's line
// (sectionCards), and placing a take moment after tighten (timemap.mjs).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, compileScript, sectionCards } from '../../script.mjs';
import { mapTime } from '../../timemap.mjs';

const SRC = `name: sections

beat One
  card "First | The first update"
  say "Line one."
  hold 1s
  say "Line two."
  hold 1s

beat Two
  card "Second | The second update"
  hold 1s
  say "Line three."
  hold 1s
`;

describe('card', () => {
  test('parses and pairs each card with the first say after it', () => {
    const { steps } = parseScript(SRC, { file: 's.demo' });
    assert.deepEqual(sectionCards(steps).map(({ text, line }) => ({ text, line })), [
      { text: 'First | The first update', line: 'Line one.' },
      { text: 'Second | The second update', line: 'Line three.' },
    ]);
  });

  test('does nothing in the take', () => {
    const { source } = compileScript(SRC, { file: 's.demo' });
    assert.match(source, /\/\/ section card: First \| The first update/);
    assert.doesNotMatch(source, /d\.card/);
  });

  test('needs a quoted text', () => {
    assert.throws(() => parseScript('name: x\n\nbeat A\n  card First\n  hold 1s\n', { file: 'x.demo' }), /card takes a quoted/);
  });

  test('refuses a card with no line after it', () => {
    const { steps } = parseScript('name: x\n\nbeat A\n  card "Lonely"\n  hold 1s\n', { file: 'x.demo' });
    assert.throws(() => sectionCards(steps), /has no say after it/);
  });
});

describe('mapTime', () => {
  const map = {
    segments: [
      { from: 0, to: 10, speed: 1, outStart: 0 },
      { from: 10, to: 20, speed: 4, outStart: 9.5 },
      { from: 20, to: 30, speed: 1, outStart: 11.5 },
    ],
  };

  test('keeps time inside a 1x segment', () => assert.equal(mapTime(map, 4), 4));
  test('compresses a sped-up segment', () => assert.equal(mapTime(map, 14), 10.5));
  test('shifts a later segment by what came before', () => assert.equal(mapTime(map, 25), 16.5));
  test('an empty map is the identity', () => assert.equal(mapTime({ segments: [] }, 7.25), 7.25));
});
