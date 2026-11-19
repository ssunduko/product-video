// diagram.mjs from the command line: a PNG per step plus the final image, the
// size asked for, the example spec in the repo, icon search, and refusals.
// Needs ffmpeg (ffprobe reads the PNG sizes); no network.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasFfmpeg, tempDir, runStage, ROOT, FFPROBE, pixel } from './helpers.mjs';

const size = (png) => execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', png]).toString().trim();

const SPEC = {
  title: 'Test flow',
  nodes: [
    { id: 'a', label: 'Start', icon: 'play' },
    { id: 'b', label: 'Check', icon: 'search', step: 2 },
  ],
  edges: [{ from: 'a', to: 'b', label: 'then', step: 2 }],
};

describe('diagram.mjs', { skip: !hasFfmpeg && 'ffmpeg not found' }, () => {
  let dir;
  let spec;

  before(() => {
    dir = tempDir('diagram');
    spec = path.join(dir, 'flow.diagram.json');
    fs.writeFileSync(spec, JSON.stringify(SPEC));
  });

  test('writes one PNG per step and the final image, at 1920x1080', () => {
    const out = path.join(dir, 'out');
    const r = runStage('diagram.mjs', [spec, '-o', out]);
    assert.equal(r.code, 0, r.out);
    for (const f of ['flow-step-1.png', 'flow-step-2.png', 'flow.png']) {
      assert.ok(fs.existsSync(path.join(out, f)), f);
      assert.equal(size(path.join(out, f)), '1920,1080');
    }
    // the final image is the last step
    assert.ok(fs.readFileSync(path.join(out, 'flow.png')).equals(fs.readFileSync(path.join(out, 'flow-step-2.png'))));
    // the second step draws more than the first
    assert.ok(fs.statSync(path.join(out, 'flow-step-2.png')).size > fs.statSync(path.join(out, 'flow-step-1.png')).size);
  });

  test('--size renders smaller frames; the light theme fills the background', () => {
    const out = path.join(dir, 'small');
    assert.equal(runStage('diagram.mjs', [spec, '-o', out, '--size', '640x360']).code, 0);
    const png = path.join(out, 'flow.png');
    assert.equal(size(png), '640,360');
    const [r, g, b] = pixel(png, 0, 5, 5);
    assert.ok(r > 240 && g > 240 && b > 240, `background ${r},${g},${b}`);
  });

  test('a one-step diagram writes only its image', () => {
    const one = path.join(dir, 'one.json');
    fs.writeFileSync(one, JSON.stringify({ nodes: [{ id: 'x', label: 'Only' }] }));
    const out = path.join(dir, 'one');
    assert.equal(runStage('diagram.mjs', [one, '-o', out]).code, 0);
    assert.deepEqual(fs.readdirSync(out), ['one.png']);
  });

  test('the example spec in the repo renders cleanly', () => {
    const out = path.join(dir, 'example');
    const r = runStage('diagram.mjs', [path.join(ROOT, 'diagrams', 'example-booking.diagram.json'), '-o', out]);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /wider than the frame/);
    assert.ok(fs.existsSync(path.join(out, 'example-booking.png')));
  });

  test('--icons searches the icon names', () => {
    const r = runStage('diagram.mjs', ['--icons', 'calendar']);
    assert.equal(r.code, 0);
    assert.match(r.out, /^calendar-check$/m);
  });

  test('refuses an unknown icon and says how to find one', () => {
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ nodes: [{ id: 'x', icon: 'calendr' }] }));
    const r = runStage('diagram.mjs', [bad, '-o', path.join(dir, 'bad')]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /icon "calendr" is not a Lucide icon.*--icons calendr/);
  });
});
