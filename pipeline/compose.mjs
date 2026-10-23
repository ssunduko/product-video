// Compositor: raw take -> polished demo video.
//
// Replaces the macOS-only Recordly step. Reads the same <take>.recordly project
// and <video>.cursor.json telemetry, then renders every frame itself:
//   * eased zoom/pan per zoom region
//   * a synthesized cursor (arrow / pointing hand) with click ripples
//   * a styled window frame — padding, rounded corners, shadow, background
//
// Frames stream through: ffmpeg decodes to raw RGBA on a pipe, we draw, and
// the result is piped straight back into ffmpeg to encode. Nothing hits disk.
//
// usage: node compose.mjs [project.recordly] [-o final.mp4]

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { readStyleGuide, shade } from './brand.mjs';
import { OUT, projectPath as projectFile } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STYLE = readStyleGuide();

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE =
  process.env.FFPROBE ||
  (process.env.FFMPEG
    ? path.join(
        path.dirname(process.env.FFMPEG),
        process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe',
      )
    : 'ffprobe');

// ---- args ----
const argv = process.argv.slice(2);
let projectPath = null;
let outputPath = null;

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-o' || argv[i] === '--output') outputPath = argv[++i];
  else if (!projectPath) projectPath = argv[i];
}

projectPath ??= projectFile();
if (!fs.existsSync(projectPath)) {
  throw new Error(`no project at ${projectPath}; run project.mjs first`);
}

// Windows editors like to prepend a BOM; JSON.parse chokes on it
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

const project = readJson(projectPath);
const zoomRegions = project.editor?.zoomRegions ?? [];

// videoPath is absolute in the project file, but the project may have moved
// between machines; fall back to a sibling of the project file
let videoPath = project.videoPath;
if (!fs.existsSync(videoPath)) {
  const sibling = path.join(path.dirname(projectPath), path.basename(videoPath));
  if (!fs.existsSync(sibling)) {
    throw new Error(
      `video not found: ${videoPath}\n` +
        `(also tried ${sibling}) — fix "videoPath" in ${projectPath}`,
    );
  }
  videoPath = sibling;
}

outputPath ??= path.join(path.dirname(videoPath), 'final.mp4');

const cursorPath = `${videoPath}.cursor.json`;
const telemetry = fs.existsSync(cursorPath) ? readJson(cursorPath) : [];

if (!telemetry.length) {
  console.warn(`warning: no telemetry at ${cursorPath} — rendering without a cursor`);
}

// ---- look ----
// The mat the browser window sits on is most of what the viewer sees for the
// length of the demo, so it is the brand colour or the brand colour is not in
// the video. It was a neutral near-black before, which meant the style-guide
// blue appeared only on the title cards — under ten percent of the runtime.
//
// Top-left is the style-guide hex verbatim; it deepens toward the far corner so
// the white window still separates from it.
const BRAND_BG = [STYLE.blue, shade(STYLE.blue, 0.72)];

const F = project.editor?.frame ?? {};
const LOOK = {
  padding: F.padding ?? 64,
  radius: F.radius ?? 16,
  shadow: F.shadow ?? true,
  background: F.background ?? BRAND_BG,
  showCursor: F.cursor?.show ?? true,
  cursorScale: F.cursor?.scale ?? 1,
  rampMs: F.rampMs ?? 500,
  panMs: F.panMs ?? 700,
};

if (process.env.NO_FRAME === '1') {
  LOOK.padding = 0;
  LOOK.radius = 0;
  LOOK.shadow = false;
}
if (process.env.PADDING) LOOK.padding = Number(process.env.PADDING);

// zoom "depth" from the project file -> a scale factor
const DEPTH_SCALE = { 1: 1.25, 2: 1.5, 3: 1.75, 4: 2.0, 5: 2.5 };
const zoomFor = (depth) =>
  DEPTH_SCALE[depth] ?? (Number(depth) > 0 ? Math.min(4, 1 + 0.25 * Number(depth)) : 1.75);

// ---- probe ----
function probe() {
  let raw;
  try {
    raw = execFileSync(
      FFPROBE,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,nb_frames:format=duration',
        '-of', 'json',
        videoPath,
      ],
      { encoding: 'utf8' },
    );
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `ffprobe not found (tried "${FFPROBE}"). It ships with ffmpeg — ` +
          'install it or set FFPROBE.',
      );
    }
    throw err;
  }

  const j = JSON.parse(raw);
  const s = j.streams?.[0];
  if (!s) throw new Error(`no video stream in ${videoPath}`);

  const [num, den] = String(s.r_frame_rate).split('/').map(Number);
  const fps = den ? num / den : num;
  const duration = Number(j.format?.duration) || 0;
  const frameCount = Number(s.nb_frames) || Math.round(duration * fps);

  return { width: s.width, height: s.height, fps, frameCount, duration };
}

const V = probe();
const W = V.width;
const H = V.height;
console.log(
  `source ${W}x${H} @ ${V.fps.toFixed(2)}fps, ~${V.frameCount} frames (${V.duration.toFixed(1)}s)`,
);
console.log(`zoom regions: ${zoomRegions.length}, telemetry points: ${telemetry.length}`);

// ---- cursor track ----
const moves = telemetry.filter((s) => s.interactionType !== 'mouseup');
const clicks = telemetry.filter((s) => s.interactionType === 'click');
const CLICK_MS = 450; // ripple lifetime

// A held zoom that jumps between click positions leaves the cursor off screen
// while it travels. These find when the cursor actually left one point and
// settled on the next, so the pan can follow it instead of guessing.
const NEAR = 0.02; // normalised radius counting as "still at that point"
const near = (s, p) => Math.hypot(s.cx - p.cx, s.cy - p.cy) <= NEAR;

function leaveTime(p) {
  let t = p.atMs;
  for (const s of moves) {
    if (s.timeMs < p.atMs) continue;
    if (!near(s, p)) break;
    t = s.timeMs;
  }
  return t;
}

function arriveTime(p) {
  let t = p.atMs;
  for (let i = moves.length - 1; i >= 0; i--) {
    const s = moves[i];
    if (s.timeMs > p.atMs) continue;
    if (!near(s, p)) break;
    t = s.timeMs;
  }
  return t;
}

// ---- zoom keyframe track ----
// Each region becomes 4 keyframes: ramp up, hold, hold, ramp down. Between
// regions the track sits at z=1, where focus is irrelevant (it clamps to
// centre anyway), so plain interpolation across the gap is safe.
const regions = zoomRegions
  .map((r) => {
    const fallback = [{ atMs: Number(r.startMs) || 0, cx: r.focus?.cx ?? 0.5, cy: r.focus?.cy ?? 0.5 }];
    const track = Array.isArray(r.focusTrack) && r.focusTrack.length
      ? r.focusTrack
          .map((p) => ({ atMs: Number(p.atMs) || 0, cx: p.cx ?? 0.5, cy: p.cy ?? 0.5 }))
          .sort((a, b) => a.atMs - b.atMs)
      : fallback;

    return {
      startMs: Number(r.startMs) || 0,
      endMs: Number(r.endMs) || 0,
      z: zoomFor(r.depth),
      track,
    };
  })
  .filter((r) => r.endMs > r.startMs)
  .sort((a, b) => a.startMs - b.startMs);

// overlapping regions would make the track non-monotonic; clip to the previous
for (let i = 1; i < regions.length; i++) {
  if (regions[i].startMs < regions[i - 1].endMs) {
    regions[i].startMs = regions[i - 1].endMs;
  }
}

const keys = [];
// keyframe times must never go backwards, or interpolation flips direction
const pushKey = (t, z, cx, cy) => {
  const at = keys.length ? Math.max(t, keys[keys.length - 1].t) : t;
  keys.push({ t: at, z, cx, cy });
};

for (const r of regions) {
  if (r.endMs <= r.startMs) continue;

  const ramp = Math.min(LOOK.rampMs, (r.endMs - r.startMs) / 2);
  const holdFrom = r.startMs + ramp;
  const holdTo = r.endMs - ramp;

  const pts = r.track.filter((p) => p.atMs >= r.startMs && p.atMs <= r.endMs);
  const first = pts[0] ?? r.track[0];

  pushKey(r.startMs, 1, first.cx, first.cy);
  pushKey(holdFrom, r.z, first.cx, first.cy);

  // pan across each later click while the cursor is travelling to it, so the
  // view moves with the cursor rather than jumping after it
  let prev = first;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const clampT = (t) => Math.min(Math.max(t, holdFrom), holdTo);

    let depart = clampT(moves.length ? leaveTime(prev) : p.atMs - LOOK.panMs);
    let arrive = clampT(moves.length ? arriveTime(p) : p.atMs);

    // degenerate telemetry (cursor teleports, or the whole trip is outside the
    // hold window) — fall back to a fixed pan ending at the click
    if (arrive <= depart) {
      arrive = clampT(p.atMs);
      depart = Math.max(holdFrom, arrive - LOOK.panMs);
    }
    if (arrive <= depart) arrive = depart + 1;

    pushKey(depart, r.z, prev.cx, prev.cy);
    pushKey(arrive, r.z, p.cx, p.cy);
    prev = p;
  }

  pushKey(holdTo, r.z, prev.cx, prev.cy);
  pushKey(r.endMs, 1, prev.cx, prev.cy);
}

const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

function zoomAt(ms) {
  if (!keys.length) return { z: 1, cx: 0.5, cy: 0.5 };
  if (ms <= keys[0].t) return keys[0];
  if (ms >= keys[keys.length - 1].t) return keys[keys.length - 1];

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t < ms) i++;

  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  const k = span <= 0 ? 1 : easeInOutCubic((ms - a.t) / span);

  return {
    z: a.z + (b.z - a.z) * k,
    cx: a.cx + (b.cx - a.cx) * k,
    cy: a.cy + (b.cy - a.cy) * k,
  };
}

function cursorAt(ms) {
  if (!moves.length) return null;
  if (ms <= moves[0].timeMs) return moves[0];

  const last = moves[moves.length - 1];
  // the cursor stays put after the final sample rather than vanishing
  if (ms >= last.timeMs) return last;

  let i = 0;
  while (i < moves.length - 1 && moves[i + 1].timeMs < ms) i++;

  const a = moves[i];
  const b = moves[i + 1];
  const span = b.timeMs - a.timeMs;
  const k = span <= 0 ? 1 : (ms - a.timeMs) / span;

  return {
    cx: a.cx + (b.cx - a.cx) * k,
    cy: a.cy + (b.cy - a.cy) * k,
    cursorType: b.cursorType ?? a.cursorType,
  };
}

// ---- canvases ----
// Every per-frame buffer is allocated once. Allocating a fresh 8 MB frame each
// time costs more in GC than all the drawing put together.
const src = createCanvas(W, H);
const sctx = src.getContext('2d');

// ImageData copies whatever array it is constructed with, so the frame has to
// be written into its own `.data`, not into an array handed to the constructor
const srcImage = new ImageData(W, H);
const srcView = Buffer.from(
  srcImage.data.buffer,
  srcImage.data.byteOffset,
  srcImage.data.byteLength,
);

const dst = createCanvas(W, H);
const dctx = dst.getContext('2d');
dctx.imageSmoothingEnabled = true;
dctx.imageSmoothingQuality = 'high';

// window rect: the video, inset by padding, aspect preserved
const availW = W - LOOK.padding * 2;
const availH = H - LOOK.padding * 2;
const fit = Math.min(availW / W, availH / H);
const ww = Math.round(W * fit);
const wh = Math.round(H * fit);
const wx = Math.round((W - ww) / 2);
const wy = Math.round((H - wh) / 2);

// The background and its drop shadow never change, and every later frame paints
// the window area opaquely on top, so this is drawn straight into the output
// canvas once. Only the window interior is touched per frame.
{
  const stops = Array.isArray(LOOK.background) ? LOOK.background : [LOOK.background];

  if (stops.length === 1) {
    dctx.fillStyle = stops[0];
  } else {
    const g = dctx.createLinearGradient(0, 0, W, H);
    stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
    dctx.fillStyle = g;
  }
  dctx.fillRect(0, 0, W, H);

  if (LOOK.shadow && LOOK.padding > 0) {
    dctx.save();
    dctx.shadowColor = 'rgba(0,0,0,0.55)';
    dctx.shadowBlur = Math.max(24, LOOK.padding * 0.7);
    dctx.shadowOffsetY = Math.max(8, LOOK.padding * 0.25);
    dctx.fillStyle = '#000';
    dctx.beginPath();
    dctx.roundRect(wx, wy, ww, wh, LOOK.radius);
    dctx.fill();
    dctx.restore();
  }
}

function drawArrow(ctx) {
  // classic arrow pointer in a 24-unit space, hotspot at (0,0)
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17.5);
  ctx.lineTo(4.4, 13.4);
  ctx.lineTo(7.3, 19.8);
  ctx.lineTo(10.2, 18.4);
  ctx.lineTo(7.4, 12.2);
  ctx.lineTo(13.1, 12.1);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawHand(ctx) {
  // pointing hand; hotspot at the fingertip, so shift the shape under it
  ctx.save();
  ctx.translate(-8.5, -1);

  const parts = [
    [6.4, 8.5, 11.6, 13.8, 4.6], // palm
    [7.0, 1.0, 3.4, 9.5, 1.7], // index
    [10.2, 5.2, 3.3, 6.0, 1.65], // middle
    [13.2, 6.0, 3.2, 5.6, 1.6], // ring
    [15.9, 7.2, 3.0, 5.0, 1.5], // little
  ];

  // fill the union first, then outline it, so inner seams do not show
  ctx.beginPath();
  for (const [x, y, w, h, r] of parts) ctx.roundRect(x, y, w, h, r);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// The cursors are baked into sprites once. Drawing them live costs ~330 ms per
// frame: a drop shadow inside the window's rounded clip makes Skia allocate and
// composite a clip-sized offscreen layer for every shadowed draw.
const SS = 4; // sprite supersampling
const ART = 36; // sprite side, in cursor-art units
const HOT = { x: 9, y: 6 }; // hotspot position inside the sprite, in art units

function makeSprite(type) {
  const c = createCanvas(ART * SS, ART * SS);
  const x = c.getContext('2d');

  x.scale(SS, SS);
  x.translate(HOT.x, HOT.y);
  x.shadowColor = 'rgba(0,0,0,0.45)';
  x.shadowBlur = 3;
  x.shadowOffsetY = 1.2;
  x.fillStyle = '#ffffff';
  x.strokeStyle = 'rgba(20,22,28,0.92)';
  x.lineWidth = 1.15;
  x.lineJoin = 'round';

  if (type === 'pointer') drawHand(x);
  else drawArrow(x);

  return c;
}

const SPRITES = { arrow: makeSprite('arrow'), pointer: makeSprite('pointer') };

function drawCursor(ctx, x, y, type, pressK) {
  const sprite = SPRITES[type === 'pointer' ? 'pointer' : 'arrow'];
  const s = (type === 'pointer' ? 1.6 : 1.7) * LOOK.cursorScale * (1 - 0.12 * pressK);

  ctx.drawImage(sprite, x - HOT.x * s, y - HOT.y * s, ART * s, ART * s);
}

function drawRipple(ctx, x, y, k) {
  // k: 0 at the click, 1 when the ripple has faded
  const r = 8 + 34 * easeInOutCubic(k);

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(255,255,255,${0.75 * (1 - k)})`;
  ctx.lineWidth = 2.5 * (1 - k) + 0.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,255,255,${0.18 * (1 - k)})`;
  ctx.fill();
  ctx.restore();
}

const frameBytes = W * H * 4;

// ---- ffmpeg in / out ----
function spawnOrExplain(bin, args) {
  const p = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  p.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error(
        `\nffmpeg not found (tried "${bin}"). Install it ` +
          '(winget install Gyan.FFmpeg) or point FFMPEG at the binary.',
      );
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  });
  return p;
}

const dec = spawnOrExplain(FFMPEG, [
  '-v', 'error',
  '-i', videoPath,
  '-f', 'rawvideo',
  '-pix_fmt', 'rgba',
  '-',
]);

const enc = spawnOrExplain(FFMPEG, [
  '-y', '-v', 'error',
  '-f', 'rawvideo',
  '-pix_fmt', 'rgba',
  '-s', `${W}x${H}`,
  '-r', String(V.fps),
  '-i', '-',
  '-c:v', 'libx264',
  '-preset', process.env.X264_PRESET || 'medium',
  '-crf', process.env.X264_CRF || '18',
  '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  outputPath,
]);

let decErr = '';
let encErr = '';
dec.stderr.on('data', (d) => (decErr += d));
enc.stderr.on('data', (d) => (encErr += d));
enc.stdout.resume();

// napi-rs exposes the backing pixels directly; fall back if that changes
const readPixels = typeof dst.data === 'function'
  ? () => dst.data()
  : () => Buffer.from(dctx.getImageData(0, 0, W, H).data.buffer);

async function writeFrame(buf) {
  if (!enc.stdin.write(buf)) await once(enc.stdin, 'drain');
}

function renderFrame(raw, index) {
  const ms = (index / V.fps) * 1000;

  // 1. source frame into its own canvas, reusing the same backing store
  raw.copy(srcView);
  sctx.putImageData(srcImage, 0, 0);

  // 2. background is already on the canvas and the window paints over itself,
  //    so nothing to clear here

  // 3. zoom transform, clipped to the rounded window
  const { z, cx, cy } = zoomAt(ms);
  const scale = (ww / W) * z;

  // clamp the focus so zooming never reveals the background behind the video
  const halfW = ww / 2 / scale;
  const halfH = wh / 2 / scale;
  const fx = Math.min(Math.max(cx * W, halfW), W - halfW);
  const fy = Math.min(Math.max(cy * H, halfH), H - halfH);

  const centreX = wx + ww / 2;
  const centreY = wy + wh / 2;

  dctx.save();
  dctx.beginPath();
  dctx.roundRect(wx, wy, ww, wh, LOOK.radius);
  dctx.clip();

  dctx.translate(centreX, centreY);
  dctx.scale(scale, scale);
  dctx.translate(-fx, -fy);
  dctx.drawImage(src, 0, 0);
  dctx.setTransform(1, 0, 0, 1, 0, 0);

  // 4. cursor + ripples, in output space so they keep a constant size,
  //    still clipped to the window
  if (LOOK.showCursor) {
    const toOut = (ncx, ncy) => ({
      x: centreX + (ncx * W - fx) * scale,
      y: centreY + (ncy * H - fy) * scale,
    });

    let pressK = 0;
    for (const c of clicks) {
      const dt = ms - c.timeMs;
      if (dt < 0 || dt > CLICK_MS) continue;
      const k = dt / CLICK_MS;
      const p = toOut(c.cx, c.cy);
      drawRipple(dctx, p.x, p.y, k);
      pressK = Math.max(pressK, 1 - k);
    }

    const cur = cursorAt(ms);
    if (cur) {
      const p = toOut(cur.cx, cur.cy);
      drawCursor(dctx, p.x, p.y, cur.cursorType, pressK);
    }
  }

  dctx.restore();
}

// ---- run ----
const t0 = Date.now();
let index = 0;

// the decoder delivers ~64 KB pipe chunks; reassemble them into one reused
// frame buffer rather than concatenating a new one per frame
const frameBuf = Buffer.allocUnsafe(frameBytes);
let filled = 0;

for await (const chunk of dec.stdout) {
  let off = 0;

  while (off < chunk.length) {
    const n = Math.min(frameBytes - filled, chunk.length - off);
    chunk.copy(frameBuf, filled, off, off + n);
    filled += n;
    off += n;

    if (filled < frameBytes) continue;
    filled = 0;

    renderFrame(frameBuf, index);
    await writeFrame(readPixels());
    index++;

    if (index % 120 === 0) {
      const pct = V.frameCount ? ((index / V.frameCount) * 100).toFixed(0) : '?';
      process.stdout.write(`\r  ${index}/${V.frameCount || '?'} frames (${pct}%)   `);
    }
  }
}

process.stdout.write('\r');

enc.stdin.end();
const [encCode] = await once(enc, 'close');

if (!index) {
  throw new Error(`no frames decoded from ${videoPath}\n${decErr.trim()}`);
}
if (encCode !== 0) {
  throw new Error(`ffmpeg encode failed (${encCode})\n${encErr.trim()}`);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
const mb = (fs.statSync(outputPath).size / 1e6).toFixed(1);

console.log(
  `composed ${index} frames in ${secs}s -> ${outputPath} (${mb} MB)\n` +
    `  frame: ${ww}x${wh} inset ${LOOK.padding}px, radius ${LOOK.radius}, ` +
    `${regions.length} zoom region(s), cursor ${LOOK.showCursor ? 'on' : 'off'}\n` +
    `  background: ${[].concat(LOOK.background).join(' -> ')}`,
);