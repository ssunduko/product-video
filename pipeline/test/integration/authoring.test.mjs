// Trace -> script -> scenario, through the CLIs: author.mjs writes a .demo and
// its selector sidecar from a trace, script.mjs compiles that to a scenario
// module, and the module loads with the card copy on it. Output goes to a temp
// folder; nothing in scripts/ or scenarios/ is touched.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, tempDir, runStage } from './helpers.mjs';

describe('authoring pipeline', () => {
  let dir;
  let trace;
  let demo;

  before(() => {
    dir = tempDir('author');
    const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios', 'grammar-tour.trace.json'), 'utf8'));
    trace = path.join(dir, 'unit-trace.trace.json');
    fs.writeFileSync(
      trace,
      JSON.stringify({ ...example, name: 'unit-trace', introAvatar: 'avatar/unit-intro.mp4', outroAvatar: 'avatar/unit-outro.mp4' }, null, 2),
    );
    demo = path.join(dir, 'unit-trace.demo');
  });

  test('author.mjs writes the script and its sidecar from a trace', () => {
    const r = runStage('author.mjs', [trace, '-o', demo]);
    assert.equal(r.code, 0, r.out);
    const text = fs.readFileSync(demo, 'utf8');
    assert.match(text, /^name: unit-trace$/m);
    assert.match(text, /^intro-avatar: avatar\/unit-intro\.mp4$/m);
    assert.match(text, /^outro-avatar: avatar\/unit-outro\.mp4$/m);
    assert.ok(fs.existsSync(path.join(dir, 'unit-trace.selectors.json')), 'sidecar beside the script');
  });

  test('script.mjs compiles it into a scenario module that loads', async () => {
    const mod = path.join(dir, 'unit-trace.mjs');
    const r = runStage('script.mjs', [demo, '-o', mod]);
    assert.equal(r.code, 0, r.out);

    const scenario = await import(pathToFileURL(mod).href);
    assert.equal(typeof scenario.run, 'function');
    assert.equal(typeof scenario.SEL, 'object');
    const { intro, outro } = JSON.parse(fs.readFileSync(trace, 'utf8'));
    assert.equal(scenario.INTRO, intro);
    assert.equal(scenario.OUTRO, outro);
  });

  test('every committed script still matches its trace (author.mjs --check)', () => {
    const r = runStage('author.mjs', ['--check']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /script check passed/);
  });
});
