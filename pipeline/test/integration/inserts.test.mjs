// inserts.mjs end to end on a generated "carded" video: brand-blue background
// with a light app window (the take), red full frames where the section cards
// are, and cards/sections.json naming them. Checks that a diagram builds up
// full-frame after its card and that the take never shows between the card,
// the steps and the next card; and that a screenshot sits in the app window.
// Needs ffmpeg; no network.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, runStage, ff, durationS, pixel, isRed, isBlue } from './helpers.mjs';

const W = 1920;
const H = 1080;
const SECONDS = 14;
// cards: "First" 2-4.5s, "Second" 9-11.5s (the second's dissolve starts at 9)
const SPANS = [
  { headline: 'First', start: 2, end: 4.5 },
  { headline: 'Second', start: 9, end: 11.5 },
];
const WIN = { x: 114, y: 64, w: 1692, h: 952 };

const isLight = ([r, g, b]) => r > 225 && g > 225 && b > 225;

describe('inserts.mjs', { skip: !hasFfmpeg && 'ffmpeg not found' }, () => {
  let dir;
  let carded;
  let diagram;

  before(() => {
    dir = tempDir('inserts');
    carded = path.join(dir, 'final-narrated-tight-carded.mp4');
    const cards = SPANS.map((s) => `between(t,${s.start},${s.end})`).join('+');
    ff([
      '-f', 'lavfi', '-i', `color=c=0x2563eb:s=${W}x${H}:r=25:d=${SECONDS}`,
      '-f', 'lavfi', '-i', `sine=f=300:d=${SECONDS}`,
      '-vf', `drawbox=x=${WIN.x}:y=${WIN.y}:w=${WIN.w}:h=${WIN.h}:color=0xf0f0f0:t=fill,` +
        `drawbox=x=0:y=0:w=${W}:h=${H}:color=red:t=fill:enable='${cards}'`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', carded,
    ]);
    fs.mkdirSync(path.join(dir, 'cards'));
    fs.writeFileSync(path.join(dir, 'cards', 'sections.json'), JSON.stringify({ video: path.basename(carded), spans: SPANS }));
    diagram = path.join(dir, 'flow.diagram.json');
    fs.writeFileSync(diagram, JSON.stringify({
      theme: 'brand',
      nodes: [{ id: 'a', label: 'One', icon: 'play' }, { id: 'b', label: 'Two', icon: 'search', step: 2 }],
      edges: [{ from: 'a', to: 'b', step: 2 }],
    }));
  });

  test('a diagram builds up full-frame after its card; the take never shows', () => {
    const out = path.join(dir, 'diagram.mp4');
    const spec = [{ section: 'First', images: [{ diagram }] }];
    const r = runStage('inserts.mjs', ['--video', carded, '-o', out, '--spec', JSON.stringify(spec)]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /flow-step-1\.png -> .* full frame/);
    assert.match(r.out, /flow-step-2\.png -> .* full frame/);
    assert.ok(Math.abs(durationS(out) - SECONDS) < 0.1);
    // the card is untouched before its dissolve
    assert.ok(isRed(pixel(out, 3, 20, 20)));
    // from the card's dissolve to the next card's, the corner (blue in the take,
    // the brand gradient in a brand-theme diagram too) is checked inside the
    // window, where the take is light grey and the diagram is not
    for (let t = 4.1; t < 9.3; t += 0.2) {
      const p = pixel(out, t, WIN.x + 40, WIN.y + 40);
      assert.ok(!isLight(p), `take visible at ${t.toFixed(1)}s: ${p}`);
    }
    // well inside the span the frame is the diagram: the brand gradient, not red
    assert.ok(isBlue(pixel(out, 6, 20, 20)));
    // and the second card plays again once its dissolve is over
    assert.ok(isRed(pixel(out, 10.5, 20, 20)));
  });

  test('a screenshot sits in the app window, with the frame around it kept', () => {
    const shot = path.join(dir, 'shot.png');
    ff(['-f', 'lavfi', '-i', 'color=c=0x00aa00:s=800x450:d=1', '-frames:v', '1', shot]);
    const out = path.join(dir, 'shot.mp4');
    const spec = [{ section: 'First', images: [{ file: shot }] }];
    const r = runStage('inserts.mjs', ['--video', carded, '-o', out, '--spec', JSON.stringify(spec)]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /in window 1692x952\+114\+64/);
    const centre = pixel(out, 6.5, W / 2, H / 2);
    assert.ok(centre[1] > 120 && centre[0] < 60 && centre[2] < 60, `centre ${centre}`);
    // the brand background outside the window is the take's own
    assert.ok(isBlue(pixel(out, 6.5, 20, 20)));
  });

  test('refuses a section that has no card', () => {
    const r = runStage('inserts.mjs', ['--video', carded, '-o', path.join(dir, 'x.mp4'), '--spec', JSON.stringify([{ section: 'Nope', images: [{ diagram }] }])]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /no section card "Nope"/);
  });
});
