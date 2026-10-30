import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTarget } from './target.mjs';
import { pickProvider, TTS_CACHE as OUT_TTS } from './tts.mjs';
import { speechMs } from './author.mjs';
import { OUT } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE =
  process.env.FFPROBE ||
  (process.env.FFMPEG
    ? path.join(path.dirname(process.env.FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : 'ffprobe');

loadTarget(undefined); // .env, for the TTS provider the clip cache is keyed on

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
//
// AUTO_SPEED=<factor> adds SPEEDS_MS ranges by itself, from the waits the driver
// logged: every wait (page open, element appearing or going) of at least
// AUTO_SPEED_MIN_MS that has no narration over it is played at <factor>. Lines
// are never sped up — a range is clipped to start after the previous line has
// finished speaking and to end before the next one starts. Hand-written
// SPEEDS_MS / CUTS_MS win where they overlap.
const CUTS = JSON.parse(process.env.CUTS_MS || '[]');
const SPEEDS = JSON.parse(process.env.SPEEDS_MS || '[]');
const AUTO_SPEED = Number(process.env.AUTO_SPEED || 0);
const AUTO_SPEED_MIN_MS = Number(process.env.AUTO_SPEED_MIN_MS || 2000);
const AUTO_HEAD_MS = 300; // keep the first moment of a wait at 1x: the click registering
const AUTO_TAIL_MS = 500; // and the last: the result landing
const AUTO_LINE_AIR_MS = 300; // never closer than this to a line
// a hovered element stays framed until the flow acts again, but no longer than this
const HIGHLIGHT_HOLD_MS = Number(process.env.HIGHLIGHT_HOLD_MS || 4000);
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
const { viewport, samples, narration = [], waits = [], targets = [] } = JSON.parse(
  fs.readFileSync(path.join(OUT, 'actions.json'), 'utf8'),
);

if (allFrames.length < 10) throw new Error(`only ${allFrames.length} frames captured`);

// video timeline starts at the first screencast frame
const t0 = allFrames[0].ts; // epoch seconds (float)

if (AUTO_SPEED) {
  if (!(AUTO_SPEED > 1)) throw new Error(`AUTO_SPEED needs a factor above 1, got ${process.env.AUTO_SPEED}`);
  const auto = autoSpeeds();
  for (const r of auto) SPEEDS.push(r);
  console.log(
    auto.length
      ? `auto-speed x${AUTO_SPEED}: ${auto.map(([a, b]) => `${(a / 1000).toFixed(1)}-${(b / 1000).toFixed(1)}s`).join(', ')}`
      : `auto-speed x${AUTO_SPEED}: no unnarrated wait of ${AUTO_SPEED_MIN_MS}ms or more`,
  );
}

function autoSpeeds() {
  if (!waits.length) {
    console.warn('auto-speed: actions.json has no waits — re-record with the current driver.mjs');
    return [];
  }
  const vt = (epochMs) => epochMs - t0 * 1000;

  // an open() followed by the wait for the page's content is one load
  const spans = waits
    .map((w) => [vt(w.start), vt(w.end)])
    .filter(([, e]) => e > 0)
    .sort((a, b) => a[0] - b[0])
    .reduce((acc, [s, e]) => {
      const last = acc[acc.length - 1];
      if (last && s - last[1] < 600) last[1] = Math.max(last[1], e);
      else acc.push([Math.max(0, s), e]);
      return acc;
    }, []);

  // where a voice is speaking, at its real length when narrate.mjs has cached
  // the clip, else at the author's deliberately slow estimate
  const lines = narration.map((c) => {
    const s = vt(c.t);
    return [s - AUTO_LINE_AIR_MS, s + lineMs(c.text) + AUTO_LINE_AIR_MS];
  });

  const ranges = [];
  for (const [s, e] of spans) {
    let free = [[s + AUTO_HEAD_MS, e - AUTO_TAIL_MS]];
    for (const [ls, le] of lines) {
      free = free.flatMap(([a, b]) => (le <= a || ls >= b ? [[a, b]] : [[a, ls], [le, b]].filter(([x, y]) => y > x)));
    }
    for (const [a, b] of free) {
      if (b - a < AUTO_SPEED_MIN_MS) continue;
      const clash = [...SPEEDS, ...CUTS].some(([x, y]) => a < y && b > x);
      if (!clash) ranges.push([Math.round(a), Math.round(b), AUTO_SPEED]);
    }
  }
  return ranges;
}

function lineMs(text) {
  try {
    const provider = pickProvider();
    const hash = crypto.createHash('sha256').update(`${provider.name}|${provider.voice}|${text}`).digest('hex').slice(0, 16);
    const file = [path.join(OUT_TTS, `${hash}.lead.mp3`), path.join(OUT_TTS, `${hash}.mp3`)].find((f) => fs.existsSync(f));
    if (file) {
      const s = Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
      if (s > 0) return s * 1000;
    }
  } catch {
    // no provider configured or no clip yet: estimate
  }
  return speechMs(text);
}
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

// The screencast can deliver a frame stamped earlier than the one before it
// (99 of 3508 on one take, up to 0.47s back). Each one would get the 1ms floor
// below and the next frame the whole gap, so every out-of-order frame pushed
// the picture later while the narration kept its own clock: 3s behind by the
// end of that take. Keep capture order and drop any frame that steps back.
let lastTs = -Infinity;
const ordered = allFrames.filter((f) => (f.ts > lastTs ? ((lastTs = f.ts), true) : false));
if (ordered.length < allFrames.length) {
  console.log(`frames: dropped ${allFrames.length - ordered.length} stamped earlier than the frame before them`);
}

const frames = ordered
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

// The element boxes the driver measured, for compose.mjs's red frame: on the
// same clock as everything else, normalised to the viewport like the cursor.
// A box whose start fell inside a cut is dropped; one that runs into a cut
// ends where the cut begins.
const highlights = targets
  .map((t) => {
    const s = t.start - t0 * 1000;
    let end = t.end;
    if (t.kind === 'hover') end = Math.min(t.end ?? Infinity, t.start + HIGHLIGHT_HOLD_MS);
    // a click's frame ends at its release (takes recorded before 2026-10-28
    // logged 500ms past it, by when the button's card had often closed)
    if (t.kind === 'click') end = Math.min(end, samples.find((x) => x.type === 'mouseup' && x.t >= t.start)?.t ?? end);
    const e = end - t0 * 1000;
    return { ...t, s, e };
  })
  .filter((t) => t.s >= 0 && t.e > t.s && !inCut(t.s))
  .map((t) => ({
    startMs: Math.round(warp(t.s)),
    endMs: Math.round(warp(t.e)),
    kind: t.kind,
    x: t.x / viewport.width,
    y: t.y / viewport.height,
    w: t.w / viewport.width,
    h: t.h / viewport.height,
    // where a typed field grew, its later boxes, from when each took over
    ...(t.track && {
      track: t.track.map((b) => ({
        atMs: Math.round(warp(b.t - t0 * 1000)),
        x: b.x / viewport.width,
        y: b.y / viewport.height,
        w: b.w / viewport.width,
        h: b.h / viewport.height,
      })),
    }),
  }))
  .filter((h) => h.endMs > h.startMs)
  .sort((a, b) => a.startMs - b.startMs);

fs.writeFileSync(`${raw}.highlights.json`, JSON.stringify(highlights, null, 1));
if (!targets.length) {
  console.log('highlights: actions.json has no element boxes (recorded before they were logged) - no red frames');
}

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