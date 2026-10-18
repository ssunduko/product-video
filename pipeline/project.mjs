import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// usage: node project.mjs [cursorJsonPath] — defaults to cut.mp4 then raw.mp4
const cursorPath =
  process.argv[2] ??
  [path.join(OUT, 'cut.mp4.cursor.json'), path.join(OUT, 'raw.mp4.cursor.json')].find((p) =>
    fs.existsSync(p),
  );

if (!cursorPath) throw new Error('no cursor.json found; run assemble.mjs first');

const videoPath = path.resolve(cursorPath.replace(/\.cursor\.json$/, ''));
const telemetry = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));

const clicks = telemetry.filter((s) => s.interactionType === 'click');
if (!clicks.length) throw new Error('no clicks in telemetry');

// merge clicks close together (e.g. open menu + pick item) into one region.
// Every click's position is kept, not just the last: a merged region can span
// clicks far apart on screen, and the compositor pans across them rather than
// framing only the final one (which would leave the earlier clicks off screen).
const MERGE_GAP_MS = 2500;
const groups = [];

for (const c of clicks) {
  const point = { atMs: c.timeMs, cx: c.cx, cy: c.cy };
  const g = groups.at(-1);

  if (g && c.timeMs - g.last <= MERGE_GAP_MS) {
    g.last = c.timeMs;
    g.points.push(point);
  } else {
    groups.push({ first: c.timeMs, last: c.timeMs, points: [point] });
  }
}

// avoid zoom flutter: if two regions would sit <800ms apart, hold one zoom
const MIN_REGION_GAP_MS = 800;
for (let i = groups.length - 2; i >= 0; i--) {
  const a = groups[i];
  const b = groups[i + 1];
  if (b.first - 1200 - (a.last + 1600) < MIN_REGION_GAP_MS) {
    a.last = b.last;
    a.points.push(...b.points);
    groups.splice(i + 1, 1);
  }
}

const clamp = (v) => Math.min(0.92, Math.max(0.08, v));
const lastTelemetryMs = telemetry[telemetry.length - 1].timeMs;

const zoomRegions = groups.map((g, i) => ({
  id: `z${i + 1}`,
  startMs: Math.max(0, g.first - 1200),
  endMs: Math.min(g.last + 1600, lastTelemetryMs + 1500),
  // 3 = 1.75x (compose.mjs DEPTH_SCALE). Dense settings pages want 2 (1.5x):
  // at 1.75x a click on a right-hand checkbox crops away the row's label.
  depth: Number(process.env.ZOOM_DEPTH ?? 3),
  // `focus` is the region's framing when nothing pans; `focusTrack` is what the
  // compositor follows when a merged region covers several click positions
  focus: { cx: clamp(g.points[0].cx), cy: clamp(g.points[0].cy) },
  focusTrack: g.points.map((p) => ({
    atMs: p.atMs,
    cx: clamp(p.cx),
    cy: clamp(p.cy),
  })),
  mode: 'manual',
}));

const projectPath = path.join(OUT, 'demo.recordly');
fs.writeFileSync(
  projectPath,
  JSON.stringify({ version: 1, videoPath, editor: { zoomRegions } }, null, 1),
);

console.log(projectPath);
console.log(
  zoomRegions
    .map((z) => {
      const pts = z.focusTrack
        .map((p) => `(${p.cx.toFixed(2)},${p.cy.toFixed(2)})@${p.atMs}ms`)
        .join(' -> ');
      return ` ${z.id}: ${z.startMs}..${z.endMs}ms  ${pts}`;
    })
    .join('\n'),
);

console.log('\nnext: node compose.mjs');