// Quality gate for a finished video. Measures what a viewer notices and a
// pipeline stage only warns about, and fails the build on it:
//
//   overlap   a narration line still speaking when the next one starts —
//             two voices at once ("double narration")
//   sync      a line whose speech does not start where its cue says, in the
//             narrated video — sound shifted against the picture
//   deadair   long silences in the deliverable
//   frozen    long stretches where the picture does not change — a loading
//             spinner, a page still fetching, a wait nobody fast-forwarded
//   black     black frames
//   streams   audio and video of different lengths, or offset start times
//   loudness  integrated loudness and true peak outside the delivery range
//
//   node qa.mjs [--video <deliverable.mp4>] [--narrated <x-narrated.mp4>]
//               [--cues <take.narration.json>] [--json <report.json>]
//               [--frames <dir>] [--no-frames] [--intro-s <s>] [--outro-s <s>]
//
// Title cards are still pictures by design, so frozen and dead-air findings
// that lie inside them are dropped. Their lengths come from out/cards/ when the
// video is cards.mjs's own output; pass --intro-s / --outro-s (0 for none) for
// anything else, such as a joined video.
//
// Defaults follow the pipeline's own outputs in out/. Exits 1 when any check
// FAILs, so it can end a pipeline run. It never calls a text-to-speech API:
// line lengths come from the clip cache narrate.mjs already filled.
//
// For a video joined from several takes, run it once per take (each with its
// own --narrated and --cues) before joining, and once more on the joined file
// with --cues none, which skips the per-line checks.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTarget } from './target.mjs';
import { pickProvider } from './tts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'out');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE =
  process.env.FFPROBE ||
  (process.env.FFMPEG
    ? path.join(path.dirname(process.env.FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : 'ffprobe');

loadTarget(undefined); // loads .env, for the TTS provider and voice the cache is keyed on

// ---- thresholds ----
// Tuned on the saved-replies takes: the defects people reported all sit well
// past these, and a clean take sits well inside them.
const OVERLAP_TOLERANCE_MS = 80; // a breath of overlap is inaudible
const SYNC_TOLERANCE_MS = 250; // lip-sync tolerance for a voice-over
const SYNC_SEARCH_MS = 900; // how far past a cue to look for its onset
const SILENCE_DB = -40;
const DEADAIR_WARN_S = 4;
const DEADAIR_FAIL_S = 6;
const FREEZE_NOISE = 0.003; // mean frame difference below this counts as frozen
const FREEZE_WARN_S = 2.5;
const FREEZE_FAIL_S = 5;
const AV_DRIFT_FAIL_S = 0.25;
const LUFS_RANGE = [-19, -13];
const TRUE_PEAK_MAX = -1;

// ---- args ----
const argv = process.argv.slice(2);
const opt = { frames: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--video') opt.video = argv[++i];
  else if (a === '--narrated') opt.narrated = argv[++i];
  else if (a === '--cues') opt.cues = argv[++i];
  else if (a === '--json') opt.json = argv[++i];
  else if (a === '--frames') opt.framesDir = argv[++i];
  else if (a === '--no-frames') opt.frames = false;
  else if (a === '--intro-s') opt.introS = Number(argv[++i]);
  else if (a === '--outro-s') opt.outroS = Number(argv[++i]);
  else {
    console.error(`unknown argument ${a}`);
    process.exit(2);
  }
}

const firstExisting = (...ps) => ps.find((p) => p && fs.existsSync(p));
const video = path.resolve(
  opt.video ??
    firstExisting(
      path.join(OUT, 'final-narrated-tight-carded.mp4'),
      path.join(OUT, 'final-narrated-tight.mp4'),
      path.join(OUT, 'final-narrated.mp4'),
      path.join(OUT, 'final.mp4'),
    ) ??
    '',
);
if (!fs.existsSync(video)) {
  console.error('no video to check. Pass --video <file>, or render one first.');
  process.exit(2);
}

// The narrated video is where cue times are still in the take's own timeline:
// compose and narrate keep it, tighten and cards move it. So per-line checks
// run there, and whole-video checks run on the deliverable.
const narrated = opt.narrated ? path.resolve(opt.narrated) : firstExisting(path.join(OUT, 'final-narrated.mp4'));

function cueFile() {
  if (opt.cues === 'none') return null;
  if (opt.cues) return path.resolve(opt.cues);
  // same discovery as narrate.mjs: the take compose.mjs rendered from
  try {
    const project = JSON.parse(fs.readFileSync(path.join(OUT, 'demo.recordly'), 'utf8').replace(/^\uFEFF/, ''));
    const p = path.join(OUT, `${path.basename(project.videoPath)}.narration.json`);
    if (fs.existsSync(p)) return p;
  } catch {
    // fall through
  }
  return firstExisting(path.join(OUT, 'cut.mp4.narration.json'), path.join(OUT, 'raw.mp4.narration.json')) ?? null;
}
const cuesPath = cueFile();
const cues = cuesPath ? JSON.parse(fs.readFileSync(cuesPath, 'utf8')) : [];

const framesDir = path.resolve(opt.framesDir ?? path.join(OUT, 'qa'));
const reportPath = path.resolve(opt.json ?? path.join(framesDir, 'qa.json'));

// ---- helpers ----
const findings = [];
const add = (check, level, atS, message, extra = {}) =>
  findings.push({ check, level, atS: atS == null ? null : Math.round(atS * 100) / 100, message, ...extra });
const fmt = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

function probe(file) {
  const out = execFileSync(FFPROBE, [
    '-v', 'error', '-show_entries', 'stream=codec_type,start_time,duration:format=duration',
    '-of', 'json', file,
  ]).toString();
  return JSON.parse(out);
}

// ffmpeg writes its filter reports to stderr
function filterLog(file, args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, ...args, '-f', 'null', '-'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.stderr ?? '';
}

function silences(file, minS) {
  const log = filterLog(file, ['-vn', '-af', `silencedetect=n=${SILENCE_DB}dB:d=${minS}`]);
  const out = [];
  let start = null;
  for (const line of log.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/.exec(line);
    if (e) {
      out.push({ start: start ?? Number(e[1]) - Number(e[2]), end: Number(e[1]), dur: Number(e[2]) });
      start = null;
    }
  }
  if (start != null) out.push({ start, end: null, dur: null }); // runs to the end
  return out;
}

function lineDurationS(text) {
  try {
    const provider = pickProvider();
    const hash = crypto
      .createHash('sha256')
      .update(`${provider.name}|${provider.voice}|${text}`)
      .digest('hex')
      .slice(0, 16);
    // narrate.mjs plays the head-trimmed clip when there is one
    const file = firstExisting(
      path.join(OUT, 'tts', `${hash}.lead.mp3`),
      path.join(OUT, 'tts', `${hash}.mp3`),
    );
    if (!file) return null;
    return Number(
      execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
        .toString()
        .trim(),
    );
  } catch {
    return null;
  }
}

// ---- lineage ----
// Each stage reads the newest output of the one before. A stage that skips
// writing leaves an older take's file behind, and the next stage happily joins
// it: a clean-looking video of the wrong take. Inside out/, every stage output
// the deliverable is built from must be newer than the one before it.
{
  const chain = ['raw.mp4', 'cut.mp4', 'final.mp4', 'final-narrated.mp4', 'final-narrated-tight.mp4', 'final-narrated-tight-carded.mp4']
    .map((f) => path.join(OUT, f));
  const upTo = chain.indexOf(video);
  if (upTo > 0) {
    const present = chain.slice(0, upTo + 1).filter((f) => fs.existsSync(f));
    for (let i = 1; i < present.length; i++) {
      const [older, newer] = [present[i - 1], present[i]];
      if (path.basename(older) === 'cut.mp4' && fs.statSync(older).mtimeMs < fs.statSync(path.join(OUT, 'raw.mp4')).mtimeMs) continue; // a cut.mp4 from an earlier take is simply unused
      if (fs.statSync(newer).mtimeMs < fs.statSync(older).mtimeMs) {
        add('lineage', 'FAIL', null,
          `${path.basename(newer)} is older than ${path.basename(older)} — a stage did not run or did not write, ` +
            'so the deliverable is built from a previous take. Re-run from that stage.');
      }
    }
  }
}

// ---- streams ----
const meta = probe(video);
const v = meta.streams.find((s) => s.codec_type === 'video');
const a = meta.streams.find((s) => s.codec_type === 'audio');
const totalS = Number(meta.format.duration);

if (!a) {
  add('streams', 'FAIL', null, 'no audio stream');
} else {
  const drift = Math.abs(Number(a.duration) - Number(v.duration));
  if (drift > AV_DRIFT_FAIL_S) {
    add('streams', 'FAIL', null, `audio and video lengths differ by ${drift.toFixed(2)}s`);
  }
  const offset = Math.abs(Number(a.start_time ?? 0) - Number(v.start_time ?? 0));
  if (offset > 0.05) {
    add('streams', 'FAIL', 0, `audio starts ${offset.toFixed(2)}s away from video — the whole track is shifted`);
  }
}

// ---- per-line: overlap and sync, in the take's own timeline ----
let lines = [];
if (cues.length) {
  lines = cues.map((c) => ({ ...c, durS: lineDurationS(c.text) }));

  lines.forEach((c, i) => {
    const next = lines[i + 1];
    if (c.durS == null) {
      add('overlap', 'WARN', c.atMs / 1000, `no cached clip for "${c.text}" — length unknown, run narrate.mjs first`);
      return;
    }
    if (next) {
      const overlapMs = c.atMs + c.durS * 1000 - next.atMs;
      if (overlapMs > OVERLAP_TOLERANCE_MS) {
        add('overlap', 'FAIL', next.atMs / 1000,
          `two voices for ${(overlapMs / 1000).toFixed(1)}s: "${c.text}" (${c.durS.toFixed(1)}s) ` +
            `is still speaking when "${next.text}" starts`,
          { line: c.text, nextLine: next.text, overlapMs: Math.round(overlapMs), timeline: 'take' });
      }
    }
  });

  if (narrated && fs.existsSync(narrated)) {
    const narratedS = Number(probe(narrated).format.duration);
    const quiet = silences(narrated, 0.3);
    // speech starts wherever a silence ends, plus at 0 if the track opens on speech
    const onsets = quiet.map((q) => q.end).filter((t) => t != null);
    if (!quiet.length || quiet[0].start > 0.05) onsets.unshift(0);

    lines.forEach((c, i) => {
      const at = c.atMs / 1000;
      const prev = lines[i - 1];
      // a line that starts under the previous one has no onset of its own;
      // that is the overlap finding, not a separate sync one
      if (prev?.durS && prev.atMs + prev.durS * 1000 > c.atMs) return;

      if (c.durS && at + c.durS > narratedS + 0.2) {
        add('sync', 'FAIL', at, `"${c.text}" runs ${(at + c.durS - narratedS).toFixed(1)}s past the end of the video`);
      }
      const onset = onsets.find((t) => t >= at - 0.15 && t <= at + SYNC_SEARCH_MS / 1000);
      if (onset == null) {
        add('sync', 'FAIL', at, `no speech starts within ${SYNC_SEARCH_MS}ms of the cue for "${c.text}"`);
      } else if (Math.abs(onset - at) * 1000 > SYNC_TOLERANCE_MS) {
        add('sync', 'FAIL', at, `"${c.text}" starts ${Math.round((onset - at) * 1000)}ms off its cue`);
      }
    });
  } else {
    add('sync', 'WARN', null, 'no narrated video found — line sync not checked (pass --narrated)');
  }
}

// ---- whole video: dead air, frozen picture, black, loudness ----
const cardS = (name, given) => {
  if (given != null) return given;
  if (!/carded\.mp4$/.test(video)) return 0;
  const f = path.join(OUT, 'cards', `${name}.mp4`);
  if (!fs.existsSync(f) || fs.statSync(f).mtimeMs > fs.statSync(video).mtimeMs) return 0;
  return Number(probe(f).format.duration);
};
const introS = cardS('intro', opt.introS);
const outroS = cardS('outro', opt.outroS);
// a range that starts inside a card only counts from where the card ends
const outsideCards = (start, end) => [Math.max(start, introS), Math.min(end, totalS - outroS)];

for (const q of silences(video, DEADAIR_WARN_S)) {
  const [s0, e0] = outsideCards(q.start, q.end ?? totalS);
  if (e0 - s0 < DEADAIR_WARN_S) continue;
  q.start = s0;
  q.end = e0;
  const end = q.end ?? totalS;
  const dur = end - q.start;
  add('deadair', dur >= DEADAIR_FAIL_S ? 'FAIL' : 'WARN', q.start,
    `${dur.toFixed(1)}s with no narration (${fmt(q.start)}–${fmt(end)})`, { endS: Math.round(end * 100) / 100 });
}

// A still picture with the voice talking over it is a deliberate hold on
// finished content (a tooltip, a settled page); a still picture in silence is
// a wait. Only the second is a FAIL.
// Pauses shorter than this are inside the narration — between clauses of one
// line ("...are disabled, [0.3s] and there is no...") — not gaps in it.
// Counting them as quiet scored a correctly paced 13s hold at 55%.
const SPEECH_PAUSE_S = 0.8;
const quietParts = a ? silences(video, SPEECH_PAUSE_S).map((q) => [q.start, q.end ?? totalS]) : [];
const spokenShare = (s, e) => {
  const quiet = quietParts.reduce((sum, [qs, qe]) => sum + Math.max(0, Math.min(e, qe) - Math.max(s, qs)), 0);
  return e > s ? 1 - quiet / (e - s) : 0;
};
const NARRATED_HOLD_SHARE = 0.6;

{
  const log = filterLog(video, ['-an', '-vf', `freezedetect=n=${FREEZE_NOISE}:d=${FREEZE_WARN_S}`]);
  let start = null;
  for (const line of log.split('\n')) {
    const s = /freeze_start: ([\d.]+)/.exec(line);
    if (s) start = Number(s[1]);
    const e = /freeze_end: ([\d.]+)/.exec(line);
    if (e && start != null) {
      const [s0, e0] = outsideCards(start, Number(e[1]));
      const dur = e0 - s0;
      if (dur >= FREEZE_WARN_S) {
        const spoken = spokenShare(s0, e0);
        const held = spoken >= NARRATED_HOLD_SHARE;
        add('frozen', dur >= FREEZE_FAIL_S && !held ? 'FAIL' : 'WARN', s0,
          held
            ? `picture holds for ${dur.toFixed(1)}s (${fmt(s0)}–${fmt(e0)}) with narration over ${Math.round(spoken * 100)}% of it — check it is finished content, not loading`
            : `picture barely changes for ${dur.toFixed(1)}s (${fmt(s0)}–${fmt(e0)}) — loading, or a wait to fast-forward`,
          { endS: Math.round(e0 * 100) / 100, spokenShare: Math.round(spoken * 100) / 100 });
      }
      start = null;
    }
  }
  if (start != null) {
    const [s0, e0] = outsideCards(start, totalS);
    if (e0 - s0 >= FREEZE_WARN_S) {
      add('frozen', e0 - s0 >= FREEZE_FAIL_S ? 'FAIL' : 'WARN', s0,
        `picture barely changes from ${fmt(s0)} to ${fmt(e0)}`, { endS: e0 });
    }
  }
}

{
  const log = filterLog(video, ['-an', '-vf', 'blackdetect=d=0.4:pix_th=0.08']);
  for (const m of log.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)) {
    add('black', 'FAIL', Number(m[1]), `${Number(m[3]).toFixed(1)}s of black frames`, { endS: Number(m[2]) });
  }
}

if (a) {
  const log = filterLog(video, ['-vn', '-af', 'ebur128=peak=true']);
  const I = Number(/I:\s+(-?[\d.]+) LUFS/.exec(log.slice(log.lastIndexOf('Summary')))?.[1]);
  const TP = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(log.slice(log.lastIndexOf('Summary')))?.[1]);
  if (Number.isFinite(I) && (I < LUFS_RANGE[0] || I > LUFS_RANGE[1])) {
    add('loudness', 'WARN', null, `integrated loudness ${I} LUFS, outside ${LUFS_RANGE[0]}..${LUFS_RANGE[1]}`);
  }
  if (Number.isFinite(TP) && TP > TRUE_PEAK_MAX) {
    add('loudness', 'WARN', null, `true peak ${TP} dBFS, above ${TRUE_PEAK_MAX}`);
  }
}

// ---- frames for a visual review ----
// One still per line (does the screen show what the voice says?) and one per
// flagged range (is that a spinner, a blank page, a popup?).
const stills = [];
function still(file, atS, name) {
  const out = path.join(framesDir, name);
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-ss', String(Math.max(0, atS)), '-i', file,
    '-frames:v', '1', '-vf', 'scale=960:-1', out]);
  if (r.status === 0 && fs.existsSync(out)) stills.push({ file: out, video: path.basename(file), atS: Math.round(atS * 100) / 100, for: name });
}

if (opt.frames) {
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  if (narrated && fs.existsSync(narrated)) {
    lines.forEach((c, i) => {
      // mid-line, when the viewer is looking at what is being described
      const mid = c.atMs / 1000 + Math.min(c.durS ?? 2, 4) / 2;
      still(narrated, mid, `line-${String(i + 1).padStart(2, '0')}.jpg`);
    });
  }
  findings
    .filter((f) => ['frozen', 'deadair', 'black'].includes(f.check) && f.atS != null)
    .forEach((f, i) => {
      const mid = f.endS ? (f.atS + f.endS) / 2 : f.atS + 1;
      still(video, mid, `${f.check}-${String(i + 1).padStart(2, '0')}.jpg`);
      f.still = `${f.check}-${String(i + 1).padStart(2, '0')}.jpg`;
    });
}

// ---- report ----
const fails = findings.filter((f) => f.level === 'FAIL').length;
const warns = findings.filter((f) => f.level === 'WARN').length;
const report = {
  verdict: fails ? 'FAIL' : 'PASS',
  video,
  narrated: narrated ?? null,
  cues: cuesPath,
  durationS: Math.round(totalS * 100) / 100,
  counts: { fail: fails, warn: warns },
  lines: lines.map((c, i) => ({
    n: i + 1, atS: c.atMs / 1000, durS: c.durS == null ? null : Math.round(c.durS * 100) / 100, text: c.text,
    still: opt.frames && narrated ? `line-${String(i + 1).padStart(2, '0')}.jpg` : null,
  })),
  findings: findings.sort((x, y) => (x.level === y.level ? (x.atS ?? 0) - (y.atS ?? 0) : x.level === 'FAIL' ? -1 : 1)),
  stills,
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

console.log(`${report.verdict}  ${path.basename(video)}  ${fmt(totalS)}  — ${fails} fail, ${warns} warn`);
for (const f of report.findings) {
  console.log(`  ${f.level.padEnd(4)} ${f.check.padEnd(8)} ${f.atS == null ? '     ' : fmt(f.atS).padStart(6)}  ${f.message}`);
}
console.log(`\nreport: ${reportPath}`);
if (stills.length) console.log(`stills: ${framesDir} (${stills.length})`);

process.exit(fails ? 1 : 0);
