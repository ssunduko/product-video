// The .demo script language (script.mjs): headers, selectors, steps, errors,
// and the scenario module it compiles to.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, compileScript, askIntents } from '../../script.mjs';

const SRC = `name: unit-tour
description: a script for the tests
intro: Hello | World
outro: Bye | Thanks | help@example.com
intro-avatar: avatar/unit-intro.mp4
outro-avatar: avatar/unit-outro.mp4

selectors:
  save = button "Save"
  search = css #search

beat One
  say "Hi there."
  click @save
  hold 2s
`;

describe('parseScript', () => {
  test('reads every header, including the avatar clips', () => {
    const { meta } = parseScript(SRC, { file: 'unit.demo' });
    assert.equal(meta.name, 'unit-tour');
    assert.equal(meta.description, 'a script for the tests');
    assert.equal(meta.intro, 'Hello | World');
    assert.equal(meta.outro, 'Bye | Thanks | help@example.com');
    assert.equal(meta.introAvatar, 'avatar/unit-intro.mp4');
    assert.equal(meta.outroAvatar, 'avatar/unit-outro.mp4');
  });

  test('leaves the avatar headers null when a script has none', () => {
    const { meta } = parseScript('name: plain\n\nbeat A\n  hold 1s\n', { file: 'p.demo' });
    assert.equal(meta.introAvatar, null);
    assert.equal(meta.outroAvatar, null);
  });

  test('defines selectors, keeping a css id that starts with #', () => {
    const { sel } = parseScript(SRC, { file: 'unit.demo' });
    assert.equal(sel.save, 'btn:Save');
    assert.match(sel.search, /#search/);
  });

  test('turns beats into ordered steps with line numbers', () => {
    const { steps } = parseScript(SRC, { file: 'unit.demo' });
    assert.deepEqual(
      steps.map(({ op }) => op),
      ['beat', 'say', 'click', 'hold'],
    );
    assert.equal(steps[1].text, 'Hi there.');
    assert.equal(steps[2].sel, 'save');
    assert.equal(steps[3].ms, 2000);
    assert.equal(steps[0].lineNo, 12);
  });

  test('refuses a header after the first beat, naming file and line', () => {
    assert.throws(
      () => parseScript('beat A\n  hold 1s\nintro-avatar: late.mp4\n', { file: 'x.demo' }),
      { name: 'ScriptError', message: /x\.demo:3: "intro-avatar:" must come before the first beat/ },
    );
  });

  test('refuses an unknown command', () => {
    assert.throws(() => parseScript('beat A\n  frobnicate\n', { file: 'x.demo' }), /x\.demo:2: unknown command "frobnicate"/);
  });

  test('refuses a malformed viewport', () => {
    assert.throws(() => parseScript('viewport: big\n', { file: 'x.demo' }), /viewport must look like 1440x810/);
  });
});

describe('compileScript', () => {
  test('emits a scenario module carrying the card copy', () => {
    const { source, meta, warnings } = compileScript(SRC, { file: 'unit.demo' });
    assert.equal(meta.name, 'unit-tour');
    assert.ok(Array.isArray(warnings));
    assert.ok(source.includes("export const INTRO = 'Hello | World';"), source);
    assert.ok(source.includes("export const OUTRO = 'Bye | Thanks | help@example.com';"), source);
  });

  test('refuses an ask selector with no resolution instead of guessing', () => {
    const src = 'selectors:\n  go = ask "the Go button"\n\nbeat A\n  click @go\n  hold 1s\n';
    assert.throws(() => compileScript(src, { file: 'ask.demo', resolved: {} }), /still state an intent and have no resolution/);
  });

  test('uses a resolution it is handed for an ask selector', () => {
    const src = 'selectors:\n  go = ask "the Go button"\n\nbeat A\n  click @go\n  hold 1s\n';
    const { sel } = parseScript(src, { file: 'ask.demo' });
    assert.deepEqual(askIntents(sel).map((a) => a.intent ?? a), ['the Go button']);
    const { source } = compileScript(src, { file: 'ask.demo', resolved: { 'the Go button': 'btn:Go' } });
    assert.match(source, /btn:Go/);
  });
});
