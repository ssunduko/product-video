// project.mjs: click telemetry -> zoom regions. Clicks a few seconds apart get
// a region each by default; ZOOM_MERGE_MS widens the gap so they share one
// region that pans between them (no zooming in and out at every click).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PIPELINE, tempDir } from './helpers.mjs';

// three clicks 4.2s and 6.6s apart, like tick / Stop / Resume on one panel
const CLICKS = [
  { timeMs: 10000, cx: 0.5, cy: 0.6 },
  { timeMs: 14200, cx: 0.67, cy: 0.7 },
  { timeMs: 20800, cx: 0.67, cy: 0.65 },
];

function zoomRegions(mergeMs, opens) {
  const dir = tempDir('project');
  try {
    const cursor = path.join(dir, 'raw.mp4.cursor.json');
    if (opens) fs.writeFileSync(path.join(dir, 'raw.mp4.opens.json'), JSON.stringify(opens));
    fs.writeFileSync(cursor, JSON.stringify([
      ...CLICKS.map((c) => ({ ...c, interactionType: 'click' })),
      { timeMs: 30000, cx: 0.5, cy: 0.5, interactionType: 'move' },
    ]));
    // '' counts as unset, so a developer's shell cannot change the default case
    const env = { ...process.env, DEMO_OUT: dir, ZOOM_MERGE_MS: mergeMs ?? '' };
    const r = spawnSync(process.execPath, ['project.mjs', cursor], { cwd: PIPELINE, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(path.join(dir, 'demo.recordly'), 'utf8')).editor.zoomRegions;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('clicks seconds apart get a zoom region each by default', () => {
  assert.equal(zoomRegions().length, 3);
});

test('ZOOM_MERGE_MS joins them into one region that pans across every click', () => {
  const r = zoomRegions('7000');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].focusTrack.map((p) => p.atMs), CLICKS.map((c) => c.timeMs));
});

test('a zoom never spans a page open, however wide ZOOM_MERGE_MS is', () => {
  // the page changes between the 2nd and 3rd click: two regions, not one
  const r = zoomRegions('7000', [{ atMs: 17000, endMs: 18000 }]);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0].focusTrack.map((p) => p.atMs), [10000, 14200]);
});
