// Background music under a finished video: a bed generated on this computer in
// one of the built-in styles, or a music file, ducked while the voice speaks and
// held a fixed distance under it.
//
//   node music.mjs --video <in.mp4> [-o <out.mp4>] --spec '<json>'
//   node music.mjs --styles                     # list the built-in styles
//
// Spec (a manifest's "music" block; build.mjs passes it):
//   { "style": "tech",          // warm | upbeat | calm | tech | playful (default warm)
//     "volume": 0.5,            // 0-1; 0.5 is the calibrated level
//     "seed": 1, "key": "D", "bpm": 100,   // optional: vary or pin the piece
//     "src": "brand/music/x.mp3",          // a file instead of a style (repo-relative)
//     "loop": true,             // a short file loops (default); false plays it once
//     "underDb": 14,            // how far under the voice the bed sits (default 14)
//     "credit": "..." }         // who made a file; for the description, not drawn
//
// The voice is found by measurement (silencedetect on the video's own audio, so
// the narration and the voiced cards both duck it). The synthesis engine is
// vendored in vendor/music-engine (MIT, see its LICENSE): the same spec always
// gives the same samples. Video is copied; audio is re-encoded once, through a
// limiter, so the mix never clips.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderSoundtrack, encodeWav, MUSIC_STYLES } from './vendor/music-engine/soundtrack.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE =
  process.env.FFPROBE ||
  (process.env.FFMPEG
    ? path.join(path.dirname(process.env.FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : 'ffprobe');

export const SR = 48000;
// The built-in styles at volume 0.5, and a file levelled by the engine, measure
// near -32 LUFS before ducking (the engine's calibration). The bed is moved from
// there to `underDb` below the measured voice.
export const ENGINE_LUFS = -32;
export const DEFAULT_UNDER_DB = 14;
export { MUSIC_STYLES };

// ---- pure helpers (unit tested) ----

export function normaliseMusic(spec) {
  if (spec == null || spec === false) return null;
  if (spec === true) spec = {};
  if (typeof spec !== 'object' || Array.isArray(spec)) throw new Error('music must be true or an object');
  if (spec.style && spec.src) throw new Error('music: give "style" or "src", not both');
  if (spec.style && !MUSIC_STYLES[spec.style]) throw new Error(`music: unknown style "${spec.style}" (one of: ${Object.keys(MUSIC_STYLES).join(', ')})`);
  const volume = spec.volume == null ? 0.5 : Number(spec.volume);
  if (!(volume >= 0 && volume <= 1)) throw new Error('music: volume goes from 0 to 1');
  const underDb = spec.underDb == null ? DEFAULT_UNDER_DB : Number(spec.underDb);
  if (!(underDb >= 6 && underDb <= 30)) throw new Error('music: underDb goes from 6 to 30');
  return { ...spec, style: spec.src ? undefined : spec.style ?? 'warm', volume, underDb };
}

// Speech spans from silencedetect's silences over a file `total` seconds long.
export function speechSpans(silences, total) {
  const spans = [];
  let t = 0;
  for (const [a, b] of [...silences].sort((x, y) => x[0] - y[0])) {
    if (a > t + 0.05) spans.push({ start: t, end: a });
    t = Math.max(t, b);
  }
  if (total > t + 0.05) spans.push({ start: t, end: total });
  return spans;
}

// Gain (dB) that moves the engine's bed from its calibrated level to `underDb`
// under the voice. Volume scales on top of that, as in the engine (0.5 = 1x).
export function bedGainDb(voiceLufs, underDb = DEFAULT_UNDER_DB) {
  if (!Number.isFinite(voiceLufs)) throw new Error('music: the voice level could not be measured');
  return voiceLufs - underDb - ENGINE_LUFS;
}

// ---- measurement ----

function durationS(file) {
  return Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
}

function silences(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'silencedetect=n=-40dB:d=0.4', '-f', 'null', '-'], { encoding: 'utf8' });
  const out = [];
  let s = null;
  for (const line of (r.stderr ?? '').split('\n')) {
    const a = /silence_start: (-?[\d.]+)/.exec(line);
    if (a) s = Math.max(0, Number(a[1]));
    const b = /silence_end: ([\d.]+)/.exec(line);
    if (b) { out.push([s ?? 0, Number(b[1])]); s = null; }
  }
  if (s != null) out.push([s, Infinity]);
  return out;
}

// integrated loudness of a file's audio (LUFS)
export function loudness(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = [...(r.stderr ?? '').matchAll(/^\s+I:\s+(-?[\d.]+) LUFS/gm)].pop();
  return m ? Number(m[1]) : NaN;
}

function decodeStereo(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`music: could not read ${file}`);
  const all = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
  const n = all.length / 2;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = all[2 * i]; R[i] = all[2 * i + 1]; }
  return [L, R];
}

// ---- stage ----

export async function addMusic({ video, output, spec }) {
  const m = normaliseMusic(spec);
  if (!m) throw new Error('music: no music spec');
  const total = durationS(video);
  const voice = speechSpans(silences(video), total);
  const voiceLufs = loudness(video);
  const gainDb = bedGainDb(voiceLufs, m.underDb);

  let musicFile = null;
  if (m.src) {
    const src = path.resolve(ROOT, m.src);
    if (!fs.existsSync(src)) throw new Error(`music: no file ${m.src}`);
    musicFile = { data: decodeStereo(src), sampleRate: SR, lufs: loudness(src), volume: m.volume, loop: m.loop !== false };
  }
  const buf = await renderSoundtrack({
    duration: total,
    sampleRate: SR,
    voiceSpans: voice,
    music: musicFile ? null : { style: m.style, volume: m.volume, seed: m.seed, key: m.key, bpm: m.bpm },
    musicFile,
  });
  const dir = path.join(path.dirname(output), 'music');
  fs.mkdirSync(dir, { recursive: true });
  const bed = path.join(dir, `${path.basename(output, '.mp4')}.bed.wav`);
  fs.writeFileSync(bed, Buffer.from(encodeWav(buf)));

  const tmp = `${output}.tmp.mp4`;
  const r = spawnSync(FFMPEG, [
    '-y', '-v', 'error', '-i', video, '-i', bed,
    '-filter_complex', `[1:a]volume=${gainDb.toFixed(2)}dB[m];[0:a][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.89:level=false[a]`,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp,
  ], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('music: ffmpeg mix failed');
  fs.renameSync(tmp, output);
  const what = m.src ? `file ${m.src}` : `style ${m.style}`;
  console.log(`music: ${what}, volume ${m.volume}, ${voice.length} speech span(s), voice ${voiceLufs.toFixed(1)} LUFS, bed ${m.underDb} dB under (gain ${gainDb.toFixed(1)} dB)`);
  if (m.credit) console.log(`music: credit "${m.credit}" (add it to the video description)`);
  return { voiceLufs, gainDb, speech: voice.length, bed };
}

async function main(argv) {
  if (argv.includes('--styles')) {
    for (const [k, v] of Object.entries(MUSIC_STYLES)) console.log(`${k.padEnd(8)} ${v}`);
    return;
  }
  let video = null;
  let output = null;
  let spec = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--video') video = path.resolve(argv[++i]);
    else if (argv[i] === '-o') output = path.resolve(argv[++i]);
    else if (argv[i] === '--spec') spec = JSON.parse(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!video || spec == null) throw new Error("usage: node music.mjs --video <in.mp4> [-o <out.mp4>] --spec '{\"style\":\"tech\"}'");
  await addMusic({ video, output: output ?? video, spec });
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
