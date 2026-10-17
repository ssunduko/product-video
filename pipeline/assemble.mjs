import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'out');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

// Two ways to shorten a take, and the difference matters more than it looks.
//
// CUTS_MS   [[a,b], ...]         frames inside are DROPPED
// SPEEDS_MS [[a,b,factor], ...]  frames inside are KEPT, played at `factor`
//
// Reach for SPEEDS_MS first. A cut is right for something with no content —
// a redirect spinner, a misfire in the take. It is wrong for a long wait that
// is *doing* something, and the obvious case is a model writing an answer: the
// answer appearing is the payoff of the demo, and a cut across it lands the
// viewer on a finished table having never seen it arrive. Fast-forwarding the
// same span keeps every frame and still costs eight seconds instead of two
// minutes, and reads as a deliberate fast-forward rather than a jump.
const CUTS = JSON.parse(process.env.CUTS_MS || '[]');
const SPEEDS = JSON.parse(process.env.SPEEDS_MS || '[]');
const OUT_NAME = process.env.OUT_NAME || 'raw.mp4';

for (const [a, b, factor] of SPEEDS) {
  if (!(b > a)) throw new Error(`SPEEDS_MS range [${a},${b}] is empty or reversed`);
  if (!(factor > 1)) throw new Error(`SPEEDS_MS [${a},${b}] needs a factor above 1, got ${factor}`);
}
for (const [a, b] of CUTS) {
  for (const [sa, sb] of SPEEDS) {
    if (a < sb && b > sa) {
      throw new Error(`CUTS_MS [${a},${b}] overlaps SPEEDS_MS [${sa},${sb}] — they cannot both apply`);
    }
  }
}

const allFrames = JSON.parse(fs.readFileSync(path.join(OUT, 'frames.json'), 'utf8'));
const { viewport, samples, narration = [] } = JSON.parse(
  fs.readFileSync(path.join(OUT, 'actions.json'), 'utf8'),
);

if (allFrames.length < 10) throw new Error(`only ${allFrames.length} frames captured`);

// video timeline starts at the first screencast frame
const t0 = allFrames[0].ts; // epoch seconds (float)
const inCut = (vtMs) => CUTS.some(([a, b]) => vtMs >= a && vtMs < b);

// One time-warp, used for frames, cursor telemetry and narration cues alike.
// Everything downstream depends on those three staying on the same clock, so
// there is exactly one function that moves time and no stage may do its own.
// Ranges are partially applied when a timestamp falls inside one, which is what
// keeps a sped-up span in sync with itself rather than only at its far edge.
function warp(vtMs) {
  let out = vtMs;

  for (const [a, b] of CUTS) {
    if (vtMs >= b) out -= b - a;
    else if (vtMs > a) out -= vtMs - a;
  }

  for (const [a, b, factor] of SPEEDS) {
    const lost = 1 - 1 / factor;
    if (vtMs >= b) out -= (b - a) * lost;
    else if (vtMs > a) out -= (vtMs - a) * lost;
  }

  return out;
}

const frames = allFrames
  .filter((f) => !inCut((f.ts - t0) * 1000))
  .map((f) => ({ ...f, ts: t0 + warp((f.ts - t0) * 1000) / 1000 }));

if (frames.length < 10) {
  throw new Error(`cuts left only ${frames.length} frames; widen or drop a cut`);
}

// dead-air aid: report the biggest inter-frame gaps (video freezes there)
const gaps = frames
  .slice(1)
  .map((f, i) => ({
    atMs: Math.round((frames[i].ts - t0) * 1000),
    gapMs: Math.round((f.ts - frames[i].ts) * 1000),
  }))
  .sort((a, b) => b.gapMs - a.gapMs)
  .slice(0, 5)
  .filter((g) => g.gapMs > 1000);

if (gaps.length) console.log('largest frame gaps (candidate cuts):', JSON.stringify(gaps));

// ffmpeg's concat demuxer treats \ as an escape inside quotes, so Windows
// paths must go in with forward slashes (it accepts them fine on win32)
const concatPath = (p) => path.resolve(p).split(path.sep).join('/');

let list = '';
for (let i = 0; i < frames.length; i++) {
  const dur = i < frames.length - 1 ? frames[i + 1].ts - frames[i].ts : 1.5;
  list += `file '${concatPath(frames[i].file)}'\nduration ${Math.max(dur, 0.001).toFixed(4)}\n`;
}

// concat demuxer quirk: repeat last frame so its duration is honored
list += `file '${concatPath(frames[frames.length - 1].file)}'\n`;

fs.writeFileSync(path.join(OUT, 'list.txt'), list);

const raw = path.join(OUT, OUT_NAME);

try {
  execFileSync(
    FFMPEG,
    [
      '-y', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0',
      '-i', path.join(OUT, 'list.txt'),
      '-vf', 'scale=1920:1080:flags=lanczos,fps=60',
      '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p',
      raw,
    ],
    { stdio: 'inherit' },
  );
} catch (err) {
  if (err.code === 'ENOENT') {
    throw new Error(
      `ffmpeg not found (tried "${FFMPEG}"). Install it (winget install Gyan.FFmpeg) ` +
        'or point FFMPEG at the binary.',
    );
  }
  throw err;
}

const telemetry = samples
  .map((s) => ({ ...s, vt: s.t - t0 * 1000 }))
  .filter((s) => s.vt >= 0 && !inCut(s.vt))
  .map((s) => ({
    timeMs: Math.round(warp(s.vt)),
    cx: Math.min(1, Math.max(0, s.x / viewport.width)),
    cy: Math.min(1, Math.max(0, s.y / viewport.height)),
    interactionType: s.type,
    cursorType: s.cursorType,
  }))
  .sort((a, b) => a.timeMs - b.timeMs);

if (!telemetry.length) {
  throw new Error('no telemetry survived the cuts; check CUTS_MS against the take');
}

fs.writeFileSync(`${raw}.cursor.json`, JSON.stringify(telemetry));

// Narration cues go through the identical cut/shift maths as the cursor
// telemetry. Do this anywhere else and a cut silently desyncs the voiceover
// from the picture.
const cues = narration
  .map((c) => ({ ...c, vt: c.t - t0 * 1000 }))
  .filter((c) => c.vt >= 0 && !inCut(c.vt))
  .map((c) => ({ atMs: Math.round(warp(c.vt)), text: c.text }))
  .sort((a, b) => a.atMs - b.atMs);

fs.writeFileSync(`${raw}.narration.json`, JSON.stringify(cues, null, 1));

const droppedCues = narration.length - cues.length;

console.log(
  `${OUT_NAME} written, ${frames.length} frames; telemetry ${telemetry.length} points, ` +
    `span ${telemetry[0].timeMs}..${telemetry[telemetry.length - 1].timeMs}ms`,
);

if (narration.length) {
  console.log(
    `narration: ${cues.length} cues kept` +
      (droppedCues ? `, ${droppedCues} dropped inside cuts` : ''),
  );
}