// Build a whole video from its manifest: record and render every part, gate
// each on qa.mjs, join them, gate the result.
//
//   node build.mjs ../videos/<name>.json [--only <part>] [--no-record] [--no-gate]
//                                         [--join-only]
//
//   --only <part>   rebuild just that part (others are reused from their folders)
//   --no-record     re-render from the frames already recorded (no Chrome)
//   --no-gate       keep going when qa.mjs fails (the failures are still reported)
//   --join-only     skip the parts, just re-join and re-check
//
// Manifest (videos/<name>.json):
//   {
//     "name": "my-video",
//     "output": "out/my-video.mp4",          // relative to the repo root
//     "env": { "ZOOM_DEPTH": "2", "AUTO_SPEED": "10" },   // for every stage
//     "crossfadeS": 0.75,                    // between parts
//     "leadS": 0.6, "tailS": 1.6,            // silence kept around a join
//     "parts": [
//       { "name": "admin", "script": "scripts/x-admin.demo",
//         "before": "what must be true before this take (printed)" },
//       ...
//     ]
//   }
//
// Parts record in the listed order, each into out/<name>/<part>/ (DEMO_OUT), so
// no take overwrites another's stage files. A part's target, profile, intro and
// outro come from its script as usual. Joins are trimmed by measurement, not by
// hand: a part keeps `tailS` of silence after its last word and the next keeps
// `leadS` before its first.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OUT } from './paths.mjs';
import { staleSources } from './memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE =
  process.env.FFPROBE ||
  (process.env.FFMPEG
    ? path.join(path.dirname(process.env.FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : 'ffprobe');

// ---- args ----
const argv = process.argv.slice(2);
const opt = { record: true, gate: true, joinOnly: false, only: null };
let manifestArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--only') opt.only = argv[++i];
  else if (a === '--no-record') opt.record = false;
  else if (a === '--no-gate') opt.gate = false;
  else if (a === '--join-only') opt.joinOnly = true;
  else if (!manifestArg) manifestArg = a;
  else fail(`unexpected argument ${a}`);
}
if (!manifestArg) fail('usage: node build.mjs ../videos/<name>.json [--only <part>] [--no-record] [--no-gate] [--join-only]');

const manifestPath = path.resolve(manifestArg);
const M = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
for (const k of ['name', 'parts']) if (!M[k]) fail(`manifest needs "${k}"`);
if (!M.parts.length) fail('manifest has no parts');
if (opt.only && !M.parts.some((p) => p.name === opt.only)) fail(`no part named "${opt.only}"`);

const BUILD = path.join(DEFAULT_OUT, M.name);
const OUTPUT = path.resolve(ROOT, M.output ?? `out/${M.name}.mp4`);
const XF = M.crossfadeS ?? 0.75;
const LEAD = M.leadS ?? 0.6;
const TAIL = M.tailS ?? 1.6;

function fail(msg) {
  console.error(`build: ${msg}`);
  process.exit(1);
}

function run(label, args, env) {
  console.log(`\n--- ${label}: node ${args.join(' ')}`);
  const r = spawnSync(process.execPath, args, { cwd: HERE, stdio: 'inherit', env: { ...process.env, ...env } });
  return r.status ?? 1;
}

const probeS = (f) => Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

// speech spans of a file, from silencedetect
function speech(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'silencedetect=n=-40dB:d=0.4', '-f', 'null', '-'], { encoding: 'utf8' });
  const total = probeS(file);
  const quiet = [];
  let s = null;
  for (const line of (r.stderr ?? '').split('\n')) {
    const a = /silence_start: (-?[\d.]+)/.exec(line);
    if (a) s = Math.max(0, Number(a[1]));
    const b = /silence_end: ([\d.]+)/.exec(line);
    if (b) { quiet.push([s ?? 0, Number(b[1])]); s = null; }
  }
  if (s != null) quiet.push([s, total]);
  const firstQuiet = quiet[0];
  const lastQuiet = quiet[quiet.length - 1];
  const first = firstQuiet && firstQuiet[0] <= 0.05 ? firstQuiet[1] : 0;
  const last = lastQuiet && lastQuiet[1] >= total - 0.05 ? lastQuiet[0] : total;
  return { first, last, total };
}

// ---- memory: warn when an app's online feature source has not been synced lately ----
for (const s of staleSources()) {
  console.warn(`memory: ${s.app} features ${s.lastSyncAt ? `last synced ${s.lastSyncAt}` : 'never synced'} - run the memory agent to pick up changes`);
}

// ---- parts ----
const results = [];
for (const [i, part] of M.parts.entries()) {
  const dir = path.join(BUILD, part.name);
  const deliverable = path.join(dir, 'final-narrated-tight-carded.mp4');
  const fallback = path.join(dir, 'final-narrated-tight.mp4');
  const skip = opt.joinOnly || (opt.only && opt.only !== part.name);

  if (!skip) {
    if (!part.script) fail(`part "${part.name}" has no script`);
    const script = path.resolve(ROOT, part.script);
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...(M.env ?? {}), DEMO_OUT: dir };

    console.log(`\n===== part ${i + 1}/${M.parts.length}: ${part.name} (${part.script}) -> ${path.relative(ROOT, dir)}`);
    if (part.before) console.log(`before this take: ${part.before}`);

    const steps = [
      ...(opt.record ? [['record', ['driver.mjs', script]]] : []),
      ['assemble', ['assemble.mjs']],
      ['project', ['project.mjs']],
      ['compose', ['compose.mjs']],
      ['narrate', ['narrate.mjs']],
      ['tighten', ['tighten.mjs']],
      ['cards', ['cards.mjs', '--script', script]],
    ];
    for (const [label, args] of steps) {
      if (run(`${part.name} ${label}`, args, env) !== 0) fail(`part "${part.name}": ${label} failed — fix it and rerun with --only ${part.name}${label === 'record' ? '' : ' --no-record'}`);
    }
    const qa = run(`${part.name} qa`, ['qa.mjs', '--frames', path.join(dir, 'qa')], env);
    if (qa !== 0 && opt.gate) {
      fail(`part "${part.name}" failed the quality gate. Report: ${path.relative(ROOT, path.join(dir, 'qa', 'qa.json'))}. ` +
        'Fix the trace, regenerate the script, and rerun with --only ' + part.name);
    }
  }

  const file = fs.existsSync(deliverable) ? deliverable : fs.existsSync(fallback) ? fallback : null;
  if (!file) fail(`part "${part.name}" has no rendered video in ${path.relative(ROOT, dir)} — build it first`);
  const qaReport = path.join(dir, 'qa', 'qa.json');
  results.push({
    part: part.name,
    file,
    qa: fs.existsSync(qaReport) ? JSON.parse(fs.readFileSync(qaReport, 'utf8')).verdict : 'not run',
    introS: i === 0 && fs.existsSync(path.join(dir, 'cards', 'intro.mp4')) ? probeS(path.join(dir, 'cards', 'intro.mp4')) : 0,
    outroS: i === M.parts.length - 1 && fs.existsSync(path.join(dir, 'cards', 'outro.mp4')) ? probeS(path.join(dir, 'cards', 'outro.mp4')) : 0,
  });
}

// ---- join ----
// trim each part's silence at the joins, by measurement
for (const [i, r] of results.entries()) {
  const s = speech(r.file);
  r.startS = i === 0 ? 0 : Math.max(0, s.first - LEAD);
  r.endS = i === results.length - 1 ? s.total : Math.min(s.total, s.last + TAIL);
  r.lenS = r.endS - r.startS;
  if (r.lenS <= XF * 2) fail(`part "${r.part}" is too short to join after trimming (${r.lenS.toFixed(2)}s)`);
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
const inputs = results.flatMap((r) => ['-ss', r.startS.toFixed(3), '-t', r.lenS.toFixed(3), '-i', r.file]);
let filter = results.map((_, i) => `[${i}:v]setpts=PTS-STARTPTS[v${i}];[${i}:a]asetpts=PTS-STARTPTS[a${i}]`).join(';');
let vLast = 'v0';
let aLast = 'a0';
let offset = 0;
for (let i = 1; i < results.length; i++) {
  offset += results[i - 1].lenS - XF;
  filter += `;[${vLast}][v${i}]xfade=transition=fade:duration=${XF}:offset=${offset.toFixed(3)}[vx${i}]`;
  filter += `;[${aLast}][a${i}]acrossfade=d=${XF}[ax${i}]`;
  vLast = `vx${i}`;
  aLast = `ax${i}`;
}
filter += `;[${vLast}]format=yuv420p[v]`;

console.log(`\n===== join ${results.length} part(s) -> ${path.relative(ROOT, OUTPUT)}`);
for (const r of results) console.log(`  ${r.part.padEnd(12)} ${r.startS.toFixed(2)}s .. ${r.endS.toFixed(2)}s  (qa: ${r.qa})`);
const j = spawnSync(FFMPEG, ['-y', '-v', 'error', ...inputs, '-filter_complex', filter,
  '-map', '[v]', '-map', `[${aLast}]`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-r', '60',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', OUTPUT], { stdio: 'inherit' });
if (j.status !== 0) fail('ffmpeg join failed');

// ---- gate the joined video ----
const joinedQa = path.join(BUILD, 'qa-joined');
const q = run('joined qa', ['qa.mjs', '--video', OUTPUT, '--cues', 'none',
  '--intro-s', String(results[0].introS), '--outro-s', String(results[results.length - 1].outroS),
  '--frames', joinedQa]);

const report = {
  name: M.name,
  output: OUTPUT,
  builtAt: new Date().toISOString(),
  parts: results.map(({ part, file, qa, startS, endS }) => ({ part, file, qa, startS, endS })),
  joinedQa: q === 0 ? 'PASS' : 'FAIL',
};
fs.writeFileSync(path.join(BUILD, 'build.json'), JSON.stringify(report, null, 2) + '\n');

console.log(`\n${report.joinedQa === 'PASS' ? 'BUILT' : 'BUILT, BUT FAILED QA'}: ${path.relative(ROOT, OUTPUT)}  (${probeS(OUTPUT).toFixed(1)}s)`);
console.log('Next: the video-qa agent for the visual review of each part and the join.');
process.exit(q === 0 || !opt.gate ? 0 : 1);
