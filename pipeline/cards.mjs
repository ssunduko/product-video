// Intro / outro cards: render branded title cards, voice them, and join them
// onto the finished video.
//
//   node cards.mjs [video.mp4] [-o out.mp4] [--script ../scripts/x.demo] [--no-voice]
//
// Defaults to out/final-narrated.mp4 (else out/final.mp4) and writes
// out/<name>-carded.mp4. Card copy comes from the script's `intro:` / `outro:`
// headers, or from --intro/--outro.
//
// Brand assets come from brand/ and nowhere else: the logo, plus
// the colours and fonts declared in brand/StyleGuide.txt. There is no flag to
// point this at another folder — one directory is the brand.
//
// Cards are rendered with @napi-rs/canvas (already a dependency) rather than
// ffmpeg drawtext: real layout control, and the logo composites with alpha.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { loadTarget } from './target.mjs';
import { parseScript } from './script.mjs';
import { pickProvider, speak, audioDuration } from './tts.mjs';
import { BRAND_DIR, LOGO_WHITE as LOGO, readStyleGuide, mix, shade } from './brand.mjs';
import { OUT } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

loadTarget(undefined); // loads .env

const W = 1920;
const H = 1080;
const FPS = 60;

// How long the card dissolves into the demo (and the demo into the outro).
const XFADE = Number(process.env.CARD_XFADE ?? 0.75);

// Silence before the card's voice starts. It has to clear XFADE: the outro card
// is the incoming side of the last dissolve, so its opening XFADE seconds are
// faded up — and a lead-in shorter than that puts the first word inside the
// fade, which is the one place a card can start quiet.
const LEAD = Math.max(0.6, XFADE + 0.25);
const TAIL = 1.2; // silence after it, so the card does not end on the last word

// The card voice gets the same treatment as the narration, or the cards sit at
// a different level from the body of the video and the join is audible.
const SPEECH_FILTER =
  process.env.NARRATION_FILTER ??
  'speechnorm=e=3:r=0.0008:l=1,loudnorm=I=-16:TP=-1.5:LRA=11';

// ---- style guide ----
// Colour and type come from brand/StyleGuide.txt via brand.mjs, shared with
// compose.mjs so both stages paint the same blue.
const STYLE = readStyleGuide();

// The card is a field of the brand blue itself. Two mistakes are worth naming,
// because both make the style-guide hex an ingredient nobody can see:
//
//   1. mixing the blue down into a near-black navy, so the card is not the
//      brand colour at all;
//   2. running a gradient off the hex immediately, so the hex survives on the
//      literal top row of pixels and nowhere else.
//
// So the top 55% of the card is the hex flat and unmodified — sample anywhere
// in it and you get the hex back — and only below that does it deepen.
const BRAND = {
  blue: STYLE.blue,
  green: STYLE.green,
  bgTop: STYLE.blue,
  bgHold: 0.55, // fraction of card height held at the flat hex
  bgBottom: shade(STYLE.blue, 0.55),
  text: '#ffffff',
  muted: mix('#ffffff', STYLE.blue, 0.18),
};

// ---- args ----
const argv = process.argv.slice(2);
let video = null;
let output = null;
let scriptPath = null;
let introText = null;
let outroText = null;
let voice = true;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o' || a === '--out') output = argv[++i];
  else if (a === '--script') scriptPath = argv[++i];
  else if (a === '--intro') introText = argv[++i];
  else if (a === '--outro') outroText = argv[++i];
  else if (a === '--no-voice') voice = false;
  else if (!video) video = a;
  else {
    console.error(`unexpected argument "${a}"`);
    process.exit(1);
  }
}

// ---- card copy, from the script unless overridden ----
if (scriptPath) {
  const { meta } = parseScript(fs.readFileSync(path.resolve(scriptPath), 'utf8'), {
    file: path.basename(scriptPath),
  });
  introText ??= meta.intro;
  outroText ??= meta.outro;
}

if (!introText && !outroText) {
  throw new Error(
    'nothing to add: give --intro/--outro, or --script pointing at a .demo with ' +
      '`intro:` / `outro:` headers.',
  );
}

// ---- source video ----
// Newest stage wins: tightened, else narrated, else composed.
const src = path.resolve(
  video ??
    [
      path.join(OUT, 'final-narrated-tight.mp4'),
      path.join(OUT, 'final-narrated.mp4'),
      path.join(OUT, 'final.mp4'),
    ].find((p) => fs.existsSync(p)) ??
    path.join(OUT, 'final.mp4'),
);

if (!fs.existsSync(src)) throw new Error(`video not found: ${src}\nRun compose.mjs first.`);

const dst = path.resolve(
  output ?? path.join(OUT, `${path.basename(src, '.mp4')}-carded.mp4`),
);

console.log(`source: ${path.basename(src)}`);
console.log(`brand : ${BRAND_DIR}`);

// ---- ffmpeg ----
function ff(args) {
  try {
    return execFileSync(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`ffmpeg not found (tried "${FFMPEG}"). Set FFMPEG.`);
    }
    throw new Error(`ffmpeg failed:\n${err.stderr?.toString().slice(-800) ?? err.message}`);
  }
}

function durationOf(file) {
  const probe =
    process.env.FFPROBE ||
    (process.env.FFMPEG
      ? path.join(path.dirname(process.env.FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
      : 'ffprobe');
  const out = execFileSync(
    probe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const secs = Number(out.toString().trim());
  if (!Number.isFinite(secs) || secs <= 0) throw new Error(`could not read duration of ${file}`);
  return secs;
}

// ---- type ----
// Brand fonts are loaded from the brand folder — drop the .ttf/.otf in
// brand/ or brand/fonts/ and the style-guide names resolve to them. An
// installed system copy works too. Anything else falls back, loudly: a card in
// the wrong typeface should not slip through unnoticed.
function registerBrandFonts() {
  const names = [];
  for (const dir of [BRAND_DIR, path.join(BRAND_DIR, 'fonts')]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!/\.(ttf|otf|ttc|woff2?)$/i.test(entry)) continue;
      if (GlobalFonts.registerFromPath(path.join(dir, entry))) names.push(entry);
    }
  }
  return names;
}

function resolveFont(want, role) {
  if (GlobalFonts.has(want)) return want;
  const alt =
    ['Segoe UI', 'Helvetica Neue', 'Arial', 'DejaVu Sans'].find((f) => GlobalFonts.has(f)) ??
    'sans-serif';
  console.warn(
    `warning: ${role} font "${want}" is not available — put the font file in ` +
      `${path.relative(process.cwd(), BRAND_DIR)} or install it. Falling back to ${alt}.`,
  );
  return alt;
}

const brandFonts = registerBrandFonts();
if (brandFonts.length) console.log(`fonts : ${brandFonts.length} file(s) from ${path.basename(BRAND_DIR)}/`);

const HEAD_FONT = resolveFont(STYLE.headlineFont, 'headline');
const BODY_FONT = resolveFont(STYLE.bodyFont, 'body');

// State what the card is actually set in, rather than what was asked for. A
// silent fallback and a successful resolve otherwise look identical in the log,
// which is how a card in the wrong typeface goes unnoticed.
const mark = (want, got) => (want === got ? `${got}` : `${got}  << NOT ${want}`);
console.log(`type  : headline ${mark(STYLE.headlineFont, HEAD_FONT)}`);
console.log(`        body     ${mark(STYLE.bodyFont, BODY_FONT)}`);
console.log(`colour: ${STYLE.blue} field, ${STYLE.green} rule`);

// ---- card rendering ----

function wrap(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const probe = line ? `${line} ${w}` : w;
    if (ctx.measureText(probe).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = probe;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// A greedy wrap fills each line to the brim and dumps the remainder on the
// last one, so two lines come out as a long one and a stub. Moving words back
// from the end while that shortens the longest line evens them up.
function balance(lines) {
  if (lines.length !== 2) return lines;

  let [a, b] = lines;
  for (;;) {
    const words = a.split(' ');
    if (words.length < 2) break;
    const moved = words.pop();
    const na = words.join(' ');
    const nb = `${moved} ${b}`;
    if (Math.max(na.length, nb.length) >= Math.max(a.length, b.length)) break;
    a = na;
    b = nb;
  }
  return [a, b];
}

async function renderCard({ headline, sub, file }) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // background: the brand hex held flat across the top, deepening below it
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, BRAND.bgTop);
  grad.addColorStop(BRAND.bgHold, BRAND.bgTop);
  grad.addColorStop(1, BRAND.bgBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // Measure the whole block first, then draw it optically centred. Drawing
  // from a fixed top leaves the card bottom-heavy with empty space, which
  // reads as a mistake at full screen.
  let logoImg = null;
  let logoW = 0;
  let logoH = 0;

  if (fs.existsSync(LOGO)) {
    logoImg = await loadImage(LOGO);
    logoW = 460;
    logoH = (logoImg.height / logoImg.width) * logoW;
  } else {
    console.warn(`warning: ${LOGO} not found — card rendered without the logo`);
  }

  const GAP_LOGO = 74;
  const RULE_GAP = 40;
  const HEAD_LINE = 92;
  const SUB_LINE = 48;

  ctx.font = `600 74px "${HEAD_FONT}"`;
  const headLines = wrap(ctx, headline, W * 0.72);

  // The subhead measure is wide because the alternative is worse: at 0.62 a
  // sentence one word too long wraps and leaves that word alone on line two,
  // which looks like a mistake rather than a line break. `balance` then evens
  // out whatever still has to wrap.
  ctx.font = `400 34px "${BODY_FONT}"`;
  const subLines = sub ? balance(wrap(ctx, sub, W * 0.8)) : [];

  const blockH =
    (logoImg ? logoH + GAP_LOGO : 0) +
    RULE_GAP +
    headLines.length * HEAD_LINE +
    (subLines.length ? 14 + subLines.length * SUB_LINE : 0);

  // sit slightly above true centre — optically centred for a title card
  let y = (H - blockH) / 2 - 30;

  if (logoImg) {
    ctx.drawImage(logoImg, (W - logoW) / 2, y, logoW, logoH);
    y += logoH + GAP_LOGO;
  }

  // the CTA green, verbatim — the one accent that reads against a blue field
  ctx.fillStyle = BRAND.green;
  ctx.fillRect(W / 2 - 46, y, 92, 5);
  y += RULE_GAP;

  ctx.fillStyle = BRAND.text;
  ctx.font = `600 74px "${HEAD_FONT}"`;
  for (const line of headLines) {
    ctx.fillText(line, W / 2, y);
    y += HEAD_LINE;
  }

  if (subLines.length) {
    y += 14;
    ctx.fillStyle = BRAND.muted;
    ctx.font = `400 34px "${BODY_FONT}"`;
    for (const line of subLines) {
      ctx.fillText(line, W / 2, y);
      y += SUB_LINE;
    }
  }

  fs.writeFileSync(file, canvas.encodeSync('png'));
  return file;
}

// ---- build one card clip (png + optional voice) ----
// Only the *outer* edges fade to black — the open of the intro and the close of
// the outro. The inner edges butt against the demo and are crossfaded into it
// at the join, so they must not dip to black first: a card that fades out and a
// demo that cuts in reads as two videos stapled together, with a black flash on
// the seam.
async function buildClip({ png, seconds, audioFile, out, fadeIn, fadeOut }) {
  const fades = ['format=yuv420p'];
  if (fadeIn) fades.unshift('fade=t=in:st=0:d=0.5');
  if (fadeOut) fades.unshift(`fade=t=out:st=${Math.max(0, seconds - 0.6).toFixed(2)}:d=0.6`);
  const vf = fades.join(',');

  const args = ['-y', '-loglevel', 'error', '-loop', '1', '-t', seconds.toFixed(2), '-i', png];

  if (audioFile) args.push('-i', audioFile);
  else args.push('-f', 'lavfi', '-t', seconds.toFixed(2), '-i', 'anullsrc=r=44100:cl=stereo');

  const delayMs = Math.round(LEAD * 1000);

  args.push(
    '-filter_complex',
    audioFile
      ? `[0:v]${vf}[v];[1:a]adelay=${delayMs}|${delayMs},apad,${SPEECH_FILTER}[a]`
      : `[0:v]${vf}[v];[1:a]anull[a]`,
    '-map', '[v]', '-map', '[a]',
    '-r', String(FPS),
    '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast',
    '-crf', process.env.X264_CRF || '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
    '-t', seconds.toFixed(2),
    out,
  );

  ff(args);
  return out;
}

// ---- run ----
const tmp = path.join(OUT, 'cards');
fs.mkdirSync(tmp, { recursive: true });

const provider = voice ? pickProvider() : null;
if (provider) console.log(`voice : ${provider.name}, ${provider.voice}`);

const parts = [];

// `intro: Headline | Subhead` splits into the two lines on the card; the voice
// reads both. Without a `|`, the text is the subhead under a default headline.
function splitCopy(kind, text) {
  const i = text.indexOf('|');
  if (i === -1) {
    return {
      headline: kind === 'intro' ? 'Product demo' : 'Thanks for watching',
      sub: text.trim(),
      spoken: text.trim(),
    };
  }
  const headline = text.slice(0, i).trim();
  const sub = text.slice(i + 1).trim();
  return { headline, sub, spoken: `${headline}. ${sub}` };
}

async function makeCard(kind, text) {
  if (!text) return;

  const { headline, sub, spoken } = splitCopy(kind, text);

  const png = await renderCard({ headline, sub, file: path.join(tmp, `${kind}.png`) });

  let audioFile = null;
  let seconds = kind === 'intro' ? 5 : 6;

  if (provider) {
    const { file, cached } = await speak(provider, spoken);
    audioFile = file;
    const dur = audioDuration(file);
    seconds = Math.max(seconds, dur + LEAD + TAIL);
    console.log(`  ${kind}: ${dur.toFixed(1)}s voice${cached ? ' (cached)' : ''} -> ${seconds.toFixed(1)}s card`);
  } else {
    console.log(`  ${kind}: ${seconds}s card, no voice`);
  }

  parts.push({
    kind,
    seconds,
    file: await buildClip({
      png,
      seconds,
      audioFile,
      out: path.join(tmp, `${kind}.mp4`),
      fadeIn: kind === 'intro', // the video opens from black
      fadeOut: kind === 'outro', // and closes to it
    }),
  });
}

await makeCard('intro', introText);
const introPart = parts.find((p) => p.kind === 'intro');
parts.length = 0;
await makeCard('outro', outroText);
const outroPart = parts.find((p) => p.kind === 'outro');

// ---- join ----
// xfade/acrossfade rather than concat: the card dissolves into the demo instead
// of cutting to it. Filters (not the concat demuxer) so mismatched encoder
// settings between the cards and the composed video cannot corrupt the join.

const inputs = [];
if (introPart) inputs.push({ file: introPart.file, seconds: introPart.seconds });
inputs.push({ file: src, seconds: durationOf(src) });
if (outroPart) inputs.push({ file: outroPart.file, seconds: outroPart.seconds });

const n = inputs.length;

// Normalise every input to the same frame rate, pixel format and timebase
// first. xfade rejects mismatched inputs, and a stray timestamp offset shows up
// as a frozen frame at the seam rather than as an error.
const pre = inputs
  .map(
    (_, i) =>
      `[${i}:v:0]fps=${FPS},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${i}];` +
      `[${i}:a:0]aformat=sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`,
  )
  .join(';');

// Each dissolve overlaps the two clips, so the running total loses one XFADE
// per join — the next offset has to be measured against that shortened total,
// not against the sum of the source durations.
const steps = [];
let vPrev = '[v0]';
let aPrev = '[a0]';
let running = inputs[0].seconds;

for (let i = 1; i < n; i++) {
  const offset = Math.max(0, running - XFADE);
  const vOut = i === n - 1 ? '[v]' : `[vx${i}]`;
  const aOut = i === n - 1 ? '[a]' : `[ax${i}]`;

  steps.push(
    `${vPrev}[v${i}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}${vOut}`,
    `${aPrev}[a${i}]acrossfade=d=${XFADE}:c1=tri:c2=tri${aOut}`,
  );

  running = running + inputs[i].seconds - XFADE;
  vPrev = vOut;
  aPrev = aOut;
}

ff([
  '-y', '-loglevel', 'error',
  ...inputs.flatMap((s) => ['-i', s.file]),
  '-filter_complex', [pre, ...steps].join(';'),
  '-map', '[v]', '-map', '[a]',
  '-r', String(FPS),
  '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast',
  '-crf', process.env.X264_CRF || '18',
  '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  '-c:a', 'aac', '-b:a', '192k',
  dst,
]);

console.log(`\n${dst}`);
console.log(
  `  ${n} segments, ${n - 1} crossfade(s) of ${XFADE}s` +
    `${introPart ? ', intro' : ''}${outroPart ? ' + outro' : ''} — ${running.toFixed(1)}s`,
);
