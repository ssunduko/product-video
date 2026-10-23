// Tightening stage: take the dead air out of a narrated demo.
//
//   node tighten.mjs [video.mp4] [-o out.mp4] [--dry-run]
//
// Defaults to out/final-narrated.mp4 -> out/final-narrated-tight.mp4.
//
// A screen recording of a real app is mostly waiting. The page sits still while
// a request is in flight, a `hold` runs longer than the line it was covering,
// and the take keeps rolling for seconds after the last thing happens. None of
// that survives contact with a viewer.
//
// WHY THIS RUNS AFTER narrate.mjs AND NOT BEFORE
//
// Dead air is not a property of the picture alone. A frozen screen under a
// narration line is not dead — it is the shot the line is playing over, and
// cutting it truncates the voiceover. So a stretch is only dead when the
// picture is frozen AND the audio is silent, which is knowable only once the
// narration is on the timeline. Running this earlier and trimming on freeze
// alone desynchronises every cue after the first cut.
//
// Because both streams are cut together here, nothing can drift: there is no
// separate telemetry to re-map, unlike the manual CUTS_MS in assemble.mjs.
//
// WHAT IT DOES
//
//   * interior dead runs are played at --speed rather than excised, with at
//     least --keep of screen time left, so a pause still reads as a pause;
//   * the trailing dead run — the take rolling on after the last line — is
//     trimmed to --tail;
//   * every seam is a short crossfade (--xfade), not a cut.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OUT, projectPath as projectFile } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
// Defaults are deliberately conservative about what counts as dead, and about
// how hard to squeeze it.
//
// `min` is 3.0s, not half a second, because the pause between two spoken lines
// is not dead air — it is the beat the viewer reads the answer in. At 0.9s this
// demo lost 46% of its runtime and the answers became unreadable. What is left
// at 2.5s is genuine waiting: a request in flight, a `hold` overrunning the
// line it was covering, the take still rolling after the last thing happened.
//
// `keep` and `speed` decide how hard the squeeze is, and the honest failure
// mode is squeezing too hard: a pause cut to 0.8s at 5x does not read as a
// pause, it reads as a jump. 1.4s at 3x still feels like the video breathing.
// `keep` also sets the ceiling on the dissolve — a seam cannot be longer than
// half the segment it lands in, so a short `keep` forces a hard cut whatever
// `xfade` says.
const opts = {
  min: 3.0, // shortest dead run worth acting on, seconds
  keep: 1.4, // screen time left where a dead run was
  speed: 3, // top playback rate through a dead run
  tail: 2.5, // screen time left after the last thing that happens
  xfade: 0.6, // seam length
  freeze: -50, // freezedetect noise floor, dB
  silence: -40, // silencedetect noise floor, dB
};

let input = null;
let output = null;
let dryRun = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o' || a === '--out') output = argv[++i];
  else if (a === '--dry-run') dryRun = true;
  else if (a.startsWith('--') && a.slice(2) in opts) opts[a.slice(2)] = Number(argv[++i]);
  else if (!input) input = a;
  else {
    console.error(`unexpected argument "${a}"`);
    process.exit(1);
  }
}

// A dissolve has to fit inside half of the shortest segment it joins, so a
// tiny --keep would silently degrade every seam back into a hard cut. Floor it.
opts.keep = Math.max(0.3, opts.keep);

const src = path.resolve(input ?? path.join(OUT, 'final-narrated.mp4'));
if (!fs.existsSync(src)) {
  throw new Error(`video not found: ${src}\nRun narrate.mjs first, or pass a path.`);
}

const dst = path.resolve(
  output ?? path.join(OUT, `${path.basename(src, '.mp4')}-tight.mp4`),
);

// ---- ffmpeg ----
function run(bin, args) {
  try {
    execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`${bin} not found. Install ffmpeg (winget install Gyan.FFmpeg) or set FFMPEG.`);
    }
    throw new Error(
      `${path.basename(bin)} failed:\n${err.stderr?.toString().slice(-1500) ?? err.message}`,
    );
  }
}

// The detect pass exits 0 and reports on stderr, which execFileSync only hands
// back on failure — hence spawnSync, where stderr is available either way.
function detect() {
  const res = spawnSync(
    FFMPEG,
    [
      '-hide_banner', '-nostats',
      '-i', src,
      '-vf', `freezedetect=n=${opts.freeze}dB:d=0.4`,
      '-af', `silencedetect=n=${opts.silence}dB:d=0.4`,
      '-map', '0:v', '-map', '0:a',
      '-f', 'null', '-',
    ],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );

  if (res.error?.code === 'ENOENT') {
    throw new Error(`ffmpeg not found (tried "${FFMPEG}"). Set FFMPEG.`);
  }
  if (res.status !== 0) {
    throw new Error(`detection pass failed:\n${(res.stderr ?? '').slice(-800)}`);
  }

  const log = res.stderr ?? '';

  // freezedetect reports start/duration/end; silencedetect start/end. Both can
  // leave a run open at EOF, which is exactly the trailing dead air we care
  // about most, so an unclosed run is closed at the duration rather than
  // dropped.
  const collect = (startRe, endRe) => {
    const runs = [];
    let open = null;
    for (const line of log.split(/\r?\n/)) {
      const s = startRe.exec(line);
      if (s) {
        open = Number(s[1]);
        continue;
      }
      const e = endRe.exec(line);
      if (e && open !== null) {
        runs.push([open, Number(e[1])]);
        open = null;
      }
    }
    if (open !== null) runs.push([open, Infinity]);
    return runs;
  };

  return {
    freezes: collect(/freeze_start:\s*([\d.]+)/, /freeze_end:\s*([\d.]+)/),
    silences: collect(/silence_start:\s*([-\d.]+)/, /silence_end:\s*([\d.]+)/),
  };
}

function probeDuration() {
  const out = execFileSync(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src],
    { encoding: 'utf8' },
  );
  const d = Number(out.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`could not read duration of ${src}`);
  return d;
}

// ---- work out what is dead ----
const duration = probeDuration();
const { freezes, silences } = detect();

const clamp = (t) => Math.min(Math.max(t, 0), duration);

// dead = frozen AND silent. Interval intersection, both lists in order.
const dead = [];
for (const [fa, fb] of freezes) {
  for (const [sa, sb] of silences) {
    const a = clamp(Math.max(fa, sa));
    const b = clamp(Math.min(fb, sb));
    if (b - a >= opts.min) dead.push([a, b]);
  }
}
dead.sort((a, b) => a[0] - b[0]);

// merge runs that touch, so two adjacent detections do not become two seams
let merged = [];
for (const run of dead) {
  const last = merged[merged.length - 1];
  if (last && run[0] <= last[1] + 0.05) last[1] = Math.max(last[1], run[1]);
  else merged.push([...run]);
}

// ---- protect the zoom moves ----
// A dead run butts right up against a zoom, because the zoom is triggered by a
// click and the screen goes still immediately after it. Left alone, a seam
// lands on the ease-in or ease-out and dissolves the move away — the zoom then
// reads as a snap, which is the opposite of what the compositor spent its
// effort on. The regions come from the project file compose.mjs rendered from.
function zoomWindows() {
  const projectPath = projectFile();
  if (!fs.existsSync(projectPath)) return [];
  try {
    const project = JSON.parse(fs.readFileSync(projectPath, 'utf8').replace(/^﻿/, ''));
    const pad = opts.xfade + 0.35;
    return (project.editor?.zoomRegions ?? [])
      .map((r) => [Number(r.startMs) / 1000 - pad, Number(r.endMs) / 1000 + pad])
      .filter(([a, b]) => b > a);
  } catch {
    return []; // an unreadable project file just means no zoom protection
  }
}

function subtract(runs, blocks) {
  let out = runs;
  for (const [ba, bb] of blocks) {
    const next = [];
    for (const [a, b] of out) {
      if (bb <= a || ba >= b) next.push([a, b]);
      else {
        if (ba > a) next.push([a, ba]);
        if (bb < b) next.push([bb, b]);
      }
    }
    out = next;
  }
  return out;
}

const zooms = zoomWindows();
const beforeZoomGuard = merged.length;
merged = subtract(merged, zooms).filter(([a, b]) => b - a >= opts.min);

console.log(`${path.basename(src)}: ${duration.toFixed(1)}s`);
console.log(
  `  ${freezes.length} frozen run(s), ${silences.length} silent run(s) ` +
    `-> ${beforeZoomGuard} dead run(s) over ${opts.min}s`,
);
if (zooms.length) {
  console.log(
    `  ${zooms.length} zoom move(s) protected` +
      (merged.length !== beforeZoomGuard ? ` -> ${merged.length} dead run(s) left` : ''),
  );
}

if (!merged.length) {
  // Still write the output. cards.mjs picks the newest stage it finds, so
  // leaving the previous take's -tight file in place makes it join THAT video —
  // a finished take with another take's footage and narration in it.
  if (dryRun) {
    console.log(`nothing to tighten (dry run: would copy to ${dst}).`);
  } else {
    fs.copyFileSync(src, dst);
    console.log(`nothing to tighten — copied unchanged to\n${dst}`);
  }
  process.exit(0);
}

// ---- turn dead runs into a segment plan ----
// The plan alternates: live stretch at 1x, dead stretch at --speed.
//
// GUARD. Every seam sits a full crossfade *inside* the dead run, never on its
// edge. This is the whole correctness argument of the stage, and getting it
// wrong is not subtle:
//
// A dead run begins where the silence begins and ends where speech resumes. So
// the audio immediately outside either edge is, by construction, narration —
// and a crossfade placed on the edge reaches 0.6s past it and fades that
// narration in or out. Result lines suffer worst, because a result line starts
// the instant generation finishes, which is exactly where a dead run ends: the
// line's own first word is the thing that gets faded up from nothing.
//
// Inside the run there is nothing to damage. The picture is frozen and the
// audio is silent across the whole span, so a seam there is invisible and
// inaudible — the pause simply becomes shorter, which is the entire point.
const guard = opts.xfade + 0.35;

const plan = [];
let cursor = 0;
let cut = 0;
let skipped = 0;

for (const [a, b] of merged) {
  // a run reaching the end of the video is the take rolling on after the demo
  // finished. Trim it — but leave --tail so the final state gets a beat to be
  // read, rather than the video stopping the moment the last word lands.
  if (b >= duration - 0.25) {
    const end = Math.min(b, a + opts.tail);
    if (end > cursor) plan.push({ from: cursor, to: end, speed: 1 });
    cut += duration - end;
    cursor = duration;
    break;
  }

  const from = a + guard;
  const to = b - guard;

  // too short to hold a seam at each end plus --keep of screen time: leave it
  // alone entirely rather than squeeze it into a damaging one
  if (to - from < Math.max(opts.keep, 2 * opts.xfade)) {
    skipped++;
    continue;
  }

  // never squeeze a run below --keep of screen time, however long it is
  const speed = Math.min(opts.speed, Math.max(1, (to - from) / opts.keep));
  const saving = (to - from) * (1 - 1 / speed);

  // Every compression costs a seam, and a seam is never free — it is one more
  // place the plan can be wrong. Shaving 0.2s off a pause does not pay for
  // that, so a run has to be worth a noticeable amount or it is left alone.
  if (saving < 0.8) {
    skipped++;
    continue;
  }

  if (from > cursor) plan.push({ from: cursor, to: from, speed: 1 });

  plan.push({ from, to, speed });
  cut += saving;
  cursor = to;
}

if (cursor < duration) plan.push({ from: cursor, to: duration, speed: 1 });

if (skipped) {
  console.log(`  ${skipped} run(s) too short to compress without a seam on the edge — left alone`);
}

const kept = plan.reduce((acc, s) => acc + (s.to - s.from) / s.speed, 0);

for (const s of plan) {
  const tag = s.speed === 1 ? 'play' : `${s.speed.toFixed(1)}x`;
  console.log(
    `  ${s.from.toFixed(1).padStart(7)}s -> ${s.to.toFixed(1).padStart(7)}s  ` +
      `${tag.padStart(5)}  (${((s.to - s.from) / s.speed).toFixed(1)}s)`,
  );
}

console.log(
  `\n  ${duration.toFixed(1)}s -> ~${kept.toFixed(1)}s ` +
    `(${cut.toFixed(1)}s of dead air removed, ${((cut / duration) * 100).toFixed(0)}%)`,
);

// ---- self-check ----
// The damage this stage can do is silent: a faded word or a dissolved zoom move
// still produces a clean file of a plausible length. So the placement rule is
// checked rather than trusted. Every crossfade window must sit inside a
// detected silence, and clear of every zoom move.
const inside = (win, runs) => runs.some(([a, b]) => win[0] >= a - 0.02 && win[1] <= b + 0.02);
const problems = [];

for (let i = 1; i < plan.length; i++) {
  const t = plan[i].from; // seam, in source time
  const win = [t - opts.xfade, t + opts.xfade];

  if (!inside(win, silences)) {
    problems.push(`seam at ${t.toFixed(1)}s crossfades over audio that is not silent`);
  }
  for (const [za, zb] of zooms) {
    if (win[0] < zb && win[1] > za) {
      problems.push(`seam at ${t.toFixed(1)}s crossfades over the zoom move at ${za.toFixed(1)}s`);
    }
  }
}

if (problems.length) {
  console.error('\nplacement check FAILED:');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nRefusing to write. A seam over speech fades a narration line in or out, and a\n' +
      'seam over a zoom dissolves the move — both look deliberate in the output.\n' +
      'Raise --xfade guard room by lowering --xfade, or raise --min.',
  );
  process.exit(1);
}

console.log(`  placement check: ${plan.length - 1} seam(s), all clear of speech and zooms`);

if (dryRun) {
  console.log('\ndry run — nothing written.');
  process.exit(0);
}

// ---- render ----
// Each segment is trimmed out and retimed, then the segments are dissolved into
// one another. A hard concat of frozen frames is invisible in itself, but the
// frame where motion resumes is not: the picture snaps back into life on a
// single frame boundary and it reads as a splice. A dissolve long enough to see
// — 0.6s, not 0.25s — carries the eye across it instead.
//
// Audio through a dead run is silence by definition, so atempo only ever has to
// stretch silence — the narration itself is never pitched or hurried.
const seam = Math.min(opts.xfade, opts.keep * 0.5);

const chains = plan.map((s, i) => {
  const v =
    `[0:v]trim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},setpts=` +
    (s.speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${s.speed.toFixed(4)}`) +
    `,fps=60,format=yuv420p,settb=AVTB[v${i}]`;

  // atempo takes 0.5–100 in one pass on ffmpeg 5+, but older builds cap a
  // single instance at 2x, so the rate is spread over as many stages as that
  // needs. Costs nothing here and keeps the graph portable.
  const stages = Math.max(1, Math.ceil(Math.log2(s.speed)));
  const perStage = Math.pow(s.speed, 1 / stages);
  const tempo =
    s.speed === 1
      ? 'anull'
      : Array.from({ length: stages }, () => `atempo=${perStage.toFixed(6)}`).join(',');

  const a =
    `[0:a]atrim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},asetpts=PTS-STARTPTS,` +
    `${tempo},aformat=sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`;

  return [v, a];
});

const steps = chains.flat();
let vPrev = '[v0]';
let aPrev = '[a0]';
let running = (plan[0].to - plan[0].from) / plan[0].speed;

for (let i = 1; i < plan.length; i++) {
  const segLen = (plan[i].to - plan[i].from) / plan[i].speed;
  // a dissolve cannot be longer than either clip it joins
  const d = Math.max(0.06, Math.min(seam, running * 0.5, segLen * 0.5));
  const offset = Math.max(0, running - d);

  const vOut = i === plan.length - 1 ? '[v]' : `[vx${i}]`;
  const aOut = i === plan.length - 1 ? '[a]' : `[ax${i}]`;

  steps.push(
    `${vPrev}[v${i}]xfade=transition=fade:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}${vOut}`,
    `${aPrev}[a${i}]acrossfade=d=${d.toFixed(3)}:c1=tri:c2=tri${aOut}`,
  );

  running = running + segLen - d;
  vPrev = vOut;
  aPrev = aOut;
}

if (plan.length === 1) {
  steps.push('[v0]null[v]', '[a0]anull[a]');
}

run(FFMPEG, [
  '-y', '-loglevel', 'error',
  '-i', src,
  '-filter_complex', steps.join(';'),
  '-map', '[v]', '-map', '[a]',
  '-r', '60',
  '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast',
  '-crf', process.env.X264_CRF || '18',
  '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
  dst,
]);

const finalSecs = Number(
  execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', dst], {
    encoding: 'utf8',
  }).trim(),
);

console.log(`\n${dst}`);
console.log(
  `  ${plan.length} segments, ${plan.length - 1} crossfade(s) — ` +
    `${duration.toFixed(1)}s -> ${finalSecs.toFixed(1)}s`,
);
