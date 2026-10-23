// Narration stage: render `say` cues to speech and mux them onto the video.
//
//   node narrate.mjs [video.mp4] [-o out.mp4] [--dry-run]
//
// Defaults to out/final.mp4 -> out/final-narrated.mp4, using the newest
// *.narration.json written by assemble.mjs (cut.mp4's if present, else raw's).
//
// Anthropic has no text-to-speech API, so this calls a third party. Provider is
// chosen by DEMO_TTS, else by whichever key is set:
//
//   ELEVENLABS_API_KEY  -> elevenlabs   (best voice quality)
//   OPENAI_API_KEY      -> openai       (cheaper, very close)
//
// Keys resolve through the same path as every other credential here: the shell,
// .env, or a target's `secrets` — never a committed file.
//
// Clips are cached under out/tts/ keyed by provider+voice+text, so re-running
// after a re-cut or a video re-render costs nothing and re-bills nothing.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTarget } from './target.mjs';
import { pickProvider, speak, TTS_CACHE } from './tts.mjs';
import { OUT, projectPath as projectFile } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = TTS_CACHE; // shared across output folders (paths.mjs)
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

// ---- loudness ----
// Text-to-speech comes back around -20 LUFS, which is four to five below what
// web video is mixed to, and nothing downstream was correcting it. The symptom
// is not "the whole thing is quiet" — you turn it up and stop noticing. It is
// that a line opening on a soft consonant or a breath (a hundred milliseconds
// at -50 to -65 dB before the voice arrives) starts below the threshold where
// it registers, so the line seems to fade up when it did not.
//
//   speechnorm  lifts the quiet parts of speech toward the loud parts, which is
//               what closes the gap on those openings. Measured here: it pulls
//               range from 11.2 LRA to 9.7 and brings a soft line onset from
//               1.6 dB under the body of the take to level with it.
//   loudnorm    then puts the result on -16 LUFS with true peak under -1.5 dB.
//
// Both leave digital silence alone — there is no noise floor between lines to
// amplify — so tighten.mjs can still find the silent stretches afterwards.
const SPEECH_FILTER =
  process.env.NARRATION_FILTER ??
  'speechnorm=e=3:r=0.0008:l=1,loudnorm=I=-16:TP=-1.5:LRA=11';

// ---- per-clip levelling ----
// The above sets the level of the *track*. It cannot set the level of a line,
// and the provider does not return lines at a consistent one: across this
// script the spread out of ElevenLabs is 3.9 LU (-18.7 to -22.8 LUFS), with the
// short lines worst. A single dynamic pass over the finished mix rides the
// whole track — a quiet line inside a well-levelled track stays quiet relative
// to the lines around it, which is heard as the narration dropping away for a
// sentence and then coming back.
//
// So each clip is measured and put on a common level with a *static* gain
// before it enters the mix. Static, not another loudnorm: a per-clip dynamic
// pass would ride the syllables inside one line, which is audible on a line
// that opens loud and tails off. This only moves whole clips, so nothing about
// the delivery changes — and SPEECH_FILTER is then left with the one job it can
// actually do, which is setting the master.
//
// The target only has to be common; loudnorm sets the absolute level afterwards.
const PREMIX_LUFS = Number(process.env.NARRATION_PREMIX_LUFS ?? -20);
const PREMIX_MAX_DB = 6; // never trust a measurement enough to swing further

// loads .env so keys can live there rather than the shell
loadTarget(undefined);

// ---- args ----
const argv = process.argv.slice(2);
let videoArg = null;
let outArg = null;
let dryRun = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o' || a === '--out') outArg = argv[++i];
  else if (a === '--dry-run') dryRun = true;
  else if (!videoArg) videoArg = a;
  else {
    console.error(`unexpected argument "${a}"`);
    process.exit(1);
  }
}

const video = path.resolve(videoArg ?? path.join(OUT, 'final.mp4'));
if (!fs.existsSync(video)) {
  throw new Error(`video not found: ${video}\nRun compose.mjs first, or pass a path.`);
}

const output = path.resolve(
  outArg ?? path.join(OUT, `${path.basename(video, '.mp4')}-narrated.mp4`),
);

// ---- cues ----
// Cue times are in the timeline of one specific take, and using the wrong take's
// cues is the worst failure this stage has: it does not error, it silently
// narrates over the wrong footage. So the source take is read from the project
// file, which records the exact video compose.mjs rendered from — the one fact
// that actually establishes which timeline `video` is in.
//
// Newest-mtime is only the fallback, and it is not enough on its own: two cue
// files written in the same second sort arbitrarily, and the loser can be a
// take of a completely different length. (That is not hypothetical — editing
// both files by hand, which the README suggests for fixing a line, is enough to
// trigger it.)
function cueCandidates() {
  const projectPath = projectFile();
  const ordered = [];

  if (fs.existsSync(projectPath)) {
    try {
      const project = JSON.parse(fs.readFileSync(projectPath, 'utf8').replace(/^﻿/, ''));
      if (project.videoPath) {
        ordered.push(path.join(OUT, `${path.basename(project.videoPath)}.narration.json`));
      }
    } catch {
      // an unreadable project file just means falling back to mtime
    }
  }

  const rest = [path.join(OUT, 'cut.mp4.narration.json'), path.join(OUT, 'raw.mp4.narration.json')]
    .filter((p) => !ordered.includes(p))
    .sort((a, b) => (fs.existsSync(b) ? fs.statSync(b).mtimeMs : 0) - (fs.existsSync(a) ? fs.statSync(a).mtimeMs : 0));

  return [...ordered, ...rest].filter((p) => fs.existsSync(p));
}

const cuePath = cueCandidates()[0];

if (!cuePath) {
  throw new Error(
    'no *.narration.json found. Add `say "..."` lines to the script, re-record, ' +
      'and re-run assemble.mjs.',
  );
}

const cues = JSON.parse(fs.readFileSync(cuePath, 'utf8'));
if (!cues.length) throw new Error(`${cuePath} has no cues`);

console.log(`${cues.length} cues from ${path.relative(OUT, cuePath)}`);

// ---- provider ----
// Provider selection, the clip cache and the breath trim all live in tts.mjs,
// shared with cards.mjs. This file used to carry its own copy of the first two,
// which is how the two stages ended up voicing the same script differently.

// ---- ffmpeg helpers ----
function ff(args) {
  try {
    return execFileSync(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `ffmpeg not found (tried "${FFMPEG}"). Install it (winget install Gyan.FFmpeg) ` +
          'or point FFMPEG at the binary.',
      );
    }
    throw new Error(`ffmpeg failed: ${err.stderr?.toString().slice(-500) ?? err.message}`);
  }
}

// Integrated loudness of a clip, in LUFS. ebur128 reports on stderr and exits
// 0, so spawnSync rather than the throwing helper above; an unreadable
// measurement returns null and that clip is simply left at its own level.
function loudnessOf(file) {
  const res = spawnSync(
    FFMPEG,
    ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (res.status !== 0) return null;
  const found = [...(res.stderr ?? '').matchAll(/I:\s*(-?[\d.]+) LUFS/g)].pop();
  const lufs = found ? Number(found[1]) : NaN;
  return Number.isFinite(lufs) && lufs > -70 ? lufs : null;
}

const durationOf = (file) => {
  const probe = (process.env.FFPROBE || 'ffprobe').toString();
  try {
    const out = execFileSync(
      probe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return Number(out.toString().trim());
  } catch {
    return null;
  }
};

// ---- render ----
const videoMs = (durationOf(video) ?? 0) * 1000;

if (dryRun) {
  console.log('\ndry run — timing only, no audio rendered:\n');
  for (const c of cues) {
    const late = videoMs && c.atMs > videoMs ? '  << PAST END OF VIDEO' : '';
    console.log(`  ${String(c.atMs).padStart(7)}ms  ${JSON.stringify(c.text)}${late}`);
  }
  process.exit(0);
}

const provider = pickProvider();
console.log(`provider: ${provider.name}, voice ${provider.voice}`);

fs.mkdirSync(CACHE, { recursive: true });

const clips = [];
let rendered = 0;
let cached = 0;
let trimmed = 0;

// speak() also removes the breath in front of the line, so a cue plays on its
// first word rather than 100-160ms of intake. This used to be duplicated here
// with its own hashing, which is how the two stages drifted apart.
for (const cue of cues) {
  const { file, cached: fromCache, trimmedMs } = await speak(provider, cue.text);

  if (fromCache) cached++;
  else rendered++;
  if (trimmedMs > 0) trimmed++;

  clips.push({ ...cue, file, ms: (durationOf(file) ?? 0) * 1000, trimmedMs });
}

console.log(
  `clips: ${rendered} rendered, ${cached} from cache` +
    (trimmed ? `, ${trimmed} had a breath trimmed off the front` : ''),
);

// level every clip to PREMIX_LUFS before it reaches the mix
const measured = [];
for (const c of clips) {
  const lufs = loudnessOf(c.file);
  c.lufs = lufs;
  c.gainDb = lufs === null ? 0 : Math.max(-PREMIX_MAX_DB, Math.min(PREMIX_MAX_DB, PREMIX_LUFS - lufs));
  if (lufs !== null) measured.push(lufs);
}

if (measured.length > 1) {
  const spread = Math.max(...measured) - Math.min(...measured);
  console.log(
    `levels: ${measured.length} clip(s) span ${spread.toFixed(1)} LU ` +
      `(${Math.min(...measured).toFixed(1)} to ${Math.max(...measured).toFixed(1)} LUFS) ` +
      `-> levelled to ${PREMIX_LUFS} LUFS before the mix`,
  );
  for (const c of clips) {
    if (Math.abs(c.gainDb) >= 1.5) {
      console.log(
        `  ${c.gainDb > 0 ? '+' : ''}${c.gainDb.toFixed(1)} dB  ${JSON.stringify(c.text.slice(0, 58))}`,
      );
    }
  }
}

// warn about overlap rather than silently letting lines talk over each other
for (let i = 0; i < clips.length - 1; i++) {
  const end = clips[i].atMs + clips[i].ms;
  if (end > clips[i + 1].atMs) {
    console.warn(
      `warning: cue at ${clips[i].atMs}ms runs ${Math.round(end - clips[i + 1].atMs)}ms ` +
        `into the next one — shorten the line or move the \`say\``,
    );
  }
}

// How far past the last frame the voice runs. This happens routinely: once the
// page stops changing the screencast stops emitting frames, so the video can be
// shorter than the take, while a closing narration line keeps going. Clipping
// the audio there would cut the last line off mid-sentence, so instead the
// video is extended by holding its final frame.
const TAIL_MS = 800;
const narrationEndMs = Math.max(...clips.map((c) => c.atMs + c.ms)) + TAIL_MS;
const padMs = videoMs ? Math.max(0, narrationEndMs - videoMs) : 0;

// A second or two past the last frame is routine. A minute past it is not a
// long closing line, it is the wrong cue file — cues from a take of a different
// length, which this stage would otherwise "fix" by holding the final frame for
// as long as it takes, producing a video that looks deliberate and is not.
const PAD_LIMIT_MS = Math.max(15000, videoMs * 0.25);

if (padMs > PAD_LIMIT_MS) {
  throw new Error(
    `narration runs ${(padMs / 1000).toFixed(1)}s past the end of a ` +
      `${(videoMs / 1000).toFixed(1)}s video — that is too far to be a closing line.\n` +
      `Cues came from ${path.relative(OUT, cuePath)}, whose last cue is at ` +
      `${(Math.max(...clips.map((c) => c.atMs)) / 1000).toFixed(1)}s.\n` +
      'That file is almost certainly from a different take than the video. Check ' +
      `\`videoPath\` in ${path.relative(OUT, projectFile())}, or re-run assemble.mjs for this take.`,
  );
}

if (padMs > 0) {
  console.log(
    `narration runs ${Math.round(padMs)}ms past the last frame — holding the final ` +
      'frame to cover it (video is re-encoded for this)',
  );
}

// ---- mux ----
// each clip is delayed to its cue time, then all are mixed onto one track;
// the video stream is copied untouched so this costs seconds, not a re-render
const inputs = clips.flatMap((c) => ['-i', c.file]);

// `apad` pads the mixed track with silence and `-t` pins the result to the
// video's own length. Without the pad, `-shortest` would truncate the *video*
// wherever narration happened to stop — silently dropping the tail of the demo.
const audioFilter =
  clips
    .map(
      (c, i) =>
        `[${i + 1}:a]${Math.abs(c.gainDb) >= 0.1 ? `volume=${c.gainDb.toFixed(2)}dB,` : ''}` +
        `adelay=${Math.round(c.atMs)}|${Math.round(c.atMs)}[d${i}]`,
    )
    .join(';') +
  ';' +
  clips.map((_, i) => `[d${i}]`).join('') +
  `amix=inputs=${clips.length}:normalize=0:dropout_transition=0[mixed];` +
  `[mixed]apad,${SPEECH_FILTER}[aout]`;

// hold the last frame only when narration needs the extra room
const videoFilter =
  padMs > 0 ? `[0:v]tpad=stop_mode=clone:stop_duration=${(padMs / 1000).toFixed(3)}[vout]` : null;

const totalMs = videoMs ? Math.max(videoMs, narrationEndMs) : null;

const args = [
  '-y', '-loglevel', 'error',
  '-i', video,
  ...inputs,
  '-filter_complex', videoFilter ? `${videoFilter};${audioFilter}` : audioFilter,
  '-map', videoFilter ? '[vout]' : '0:v',
  '-map', '[aout]',
  ...(videoFilter
    ? ['-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast',
       '-crf', process.env.X264_CRF || '18', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'copy']),
  '-c:a', 'aac', '-b:a', '192k',
];

if (totalMs) args.push('-t', (totalMs / 1000).toFixed(3));
args.push(output);

ff(args);

console.log(`\n${output}`);
console.log(
  `  ${clips.length} cues, ` +
    (padMs > 0
      ? `video extended ${Math.round(padMs)}ms so the last line finishes`
      : 'video stream copied (not re-encoded)'),
);
