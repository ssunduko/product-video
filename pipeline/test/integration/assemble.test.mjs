// assemble.mjs: a narration cue carries `leadAtMs`, the start of the first page
// `open` between the previous line and this one, on the same warped clock as
// `atMs`. cards.mjs places section cards there. Needs ffmpeg.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, runStage, ff } from './helpers.mjs';

describe('assemble.mjs', { skip: !hasFfmpeg && 'ffmpeg not found' }, () => {
  test('a line gets the page open that came before it as leadAtMs', () => {
    const dir = tempDir('assemble');
    try {
      const framesDir = path.join(dir, 'frames');
      fs.mkdirSync(framesDir);
      const img = path.join(framesDir, '00000.jpg');
      ff(['-f', 'lavfi', '-i', 'color=c=gray:s=320x180', '-frames:v', '1', img]);

      // 12 frames over 11s, starting at t0
      const t0 = 1_000_000;
      const frames = Array.from({ length: 12 }, (_, i) => {
        const file = path.join(framesDir, `${String(i).padStart(5, '0')}.jpg`);
        if (i) fs.copyFileSync(img, file);
        return { ts: t0 + i, file };
      });
      fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(frames));

      const ms = (s) => (t0 + s) * 1000;
      fs.writeFileSync(path.join(dir, 'actions.json'), JSON.stringify({
        name: 'assemble-test',
        viewport: { width: 320, height: 180 },
        samples: [{ t: ms(0.5), x: 10, y: 10, type: 'move', cursorType: 'arrow' }],
        narration: [
          { t: ms(1), text: 'Line one.' },
          { t: ms(7), text: 'Line two.' },
        ],
        waits: [
          { start: ms(4), end: ms(5), kind: 'open', spec: '/next' },
          { start: ms(5), end: ms(6), kind: 'wait', spec: '#ready' },
        ],
        targets: [],
      }));

      const r = runStage('assemble.mjs', [], { DEMO_OUT: dir, AUTO_SPEED: '', SPEEDS_MS: '', CUTS_MS: '' });
      assert.equal(r.code, 0, r.out);
      const cues = JSON.parse(fs.readFileSync(path.join(dir, 'raw.mp4.narration.json'), 'utf8'));
      assert.deepEqual(cues.map((c) => c.leadAtMs), [undefined, 4000]);
      assert.equal(cues[1].leadEndMs, 5000, 'when the open finished: the take resumes there after a card');
      assert.equal(cues[1].atMs, 7000);
      const opens = JSON.parse(fs.readFileSync(path.join(dir, 'raw.mp4.opens.json'), 'utf8'));
      assert.deepEqual(opens, [{ atMs: 4000, endMs: 5000 }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
