// Intro / outro cards: render branded title cards, voice them, and join them
// onto the finished video.
//
//   node cards.mjs [video.mp4] [-o out.mp4] [--script ../scripts/x.demo] [--no-voice]
//                  [--intro-avatar avatar/x-intro.mp4] [--outro-avatar avatar/x-outro.mp4]
//                  [--no-sections]
//
// Defaults to out/final-narrated.mp4 (else out/final.mp4) and writes
// out/<name>-carded.mp4. Card copy comes from the script's `intro:` / `outro:`
// headers, or from --intro/--outro. An `intro-avatar:` / `outro-avatar:` header
// (or flag) puts a talking-head clip in a round bubble on that card, voicing
// it in place of TTS.
//
// A beat that starts with `card "Headline | Subhead"` also gets a section card:
// it is cut into the video just before that beat's first narration line, found
// by the line's cue time mapped through tighten's time map. Its headline is
// voiced. `--no-sections` leaves them out. Their spans in the output go to
// cards/sections.json, so qa does not judge a still card as a frozen screen.
//
// Brand assets come from brand/ and nowhere else: the logo, plus
// the colours and fonts declared in brand/StyleGuide.txt. There is no flag to
// point this at another folder — one directory is the brand.
//
// Cards are rendered with @napi-rs/canvas (already a dependency) rather than
// ffmpeg drawtext: real layout control, and the logo composites with alpha.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { loadTarget } from './target.mjs';
import { parseScript, sectionCards } from './script.mjs';
import { readTimeMap, mapTime } from './timemap.mjs';
import { pickProvider, speak, audioDuration, avatarEnabled } from './tts.mjs';
import { BRAND_DIR, LOGO_WHITE as LOGO, readStyleGuide, mix, shade } from './brand.mjs';
import { OUT, projectPath } from './paths.mjs';

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
let introAvatar = null;
let outroAvatar = null;
let voice = true;
let sectionsOn = true;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o' || a === '--out') output = argv[++i];
  else if (a === '--script') scriptPath = argv[++i];
  else if (a === '--intro') introText = argv[++i];
  else if (a === '--outro') outroText = argv[++i];
  else if (a === '--intro-avatar') introAvatar = argv[++i];
  else if (a === '--outro-avatar') outroAvatar = argv[++i];
  else if (a === '--no-voice') voice = false;
  else if (a === '--no-sections') sectionsOn = false;
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
  introAvatar ??= meta.introAvatar;
  outroAvatar ??= meta.outroAvatar;
}

const sections = scriptPath && sectionsOn
  ? sectionCards(parseScript(fs.readFileSync(path.resolve(scriptPath), 'utf8'), { file: path.basename(scriptPath) }).steps)
  : [];

// ---- avatar clips ----
// A talking-head clip (an ElevenCreative avatar reading the card copy) voices
// the card from a bubble beside its copy. ElevenCreative has no avatar API, so
// the clip is generated by hand and dropped in avatar/ — gitignored, since it
// is a real person's face and voice. Relative paths resolve from the repo root.
// Off unless DEMO_AVATAR is on: a script can name its clips and still render
// with plain cards and the premium voice.
const ROOT = path.join(HERE, '..');
const resolveAvatar = (p) => (p ? path.resolve(ROOT, p) : null);
if ((introAvatar || outroAvatar) && !avatarEnabled()) {
  console.log('avatar: off (DEMO_AVATAR) — still cards, the clips are ignored');
  introAvatar = outroAvatar = null;
}
introAvatar = resolveAvatar(introAvatar);
outroAvatar = resolveAvatar(outroAvatar);

if (!introText && !outroText && !sections.length) {
  throw new Error(
    'nothing to add: give --intro/--outro, or --script pointing at a .demo with ' +
      '`intro:` / `outro:` headers or `card` lines.',
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

async function renderCard({ headline, sub, contact, file, bubble = null }) {
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

  // With an avatar bubble the block moves left to share the card with it;
  // otherwise it is centred on the full width.
  const cx = bubble ? bubble.textCx : W / 2;
  const measure = bubble ? bubble.textW : null;

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
  const CONTACT_GAP = 34;
  const CONTACT_LINE = 44;

  ctx.font = `600 74px "${HEAD_FONT}"`;
  const headLines = wrap(ctx, headline, measure ?? W * 0.72);

  // The subhead measure is wide because the alternative is worse: at 0.62 a
  // sentence one word too long wraps and leaves that word alone on line two,
  // which looks like a mistake rather than a line break. `balance` then evens
  // out whatever still has to wrap.
  ctx.font = `400 34px "${BODY_FONT}"`;
  const subLines = sub ? balance(wrap(ctx, sub, measure ?? W * 0.8)) : [];

  const blockH =
    (logoImg ? logoH + GAP_LOGO : 0) +
    RULE_GAP +
    headLines.length * HEAD_LINE +
    (subLines.length ? 14 + subLines.length * SUB_LINE : 0) +
    (contact ? CONTACT_GAP + CONTACT_LINE : 0);

  // sit slightly above true centre — optically centred for a title card
  let y = (H - blockH) / 2 - 30;

  if (logoImg) {
    ctx.drawImage(logoImg, cx - logoW / 2, y, logoW, logoH);
    y += logoH + GAP_LOGO;
  }

  // the CTA green, verbatim — the one accent that reads against a blue field
  ctx.fillStyle = BRAND.green;
  ctx.fillRect(cx - 46, y, 92, 5);
  y += RULE_GAP;

  ctx.fillStyle = BRAND.text;
  ctx.font = `600 74px "${HEAD_FONT}"`;
  for (const line of headLines) {
    ctx.fillText(line, cx, y);
    y += HEAD_LINE;
  }

  if (subLines.length) {
    y += 14;
    ctx.fillStyle = BRAND.muted;
    ctx.font = `400 34px "${BODY_FONT}"`;
    for (const line of subLines) {
      ctx.fillText(line, cx, y);
      y += SUB_LINE;
    }
  }

  // full white and heavier than the muted subhead, so the address is the
  // thing the eye lands on last
  if (contact) {
    y += CONTACT_GAP;
    ctx.fillStyle = BRAND.text;
    ctx.font = `600 36px "${BODY_FONT}"`;
    ctx.fillText(contact, cx, y);
  }

  // the bubble's frame: a soft shadow and a white ring. The clip itself is
  // overlaid inside it by ffmpeg.
  if (bubble) {
    const r = bubble.d / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = BRAND.text;
    ctx.beginPath();
    ctx.arc(bubble.cx, bubble.cy, r + BUBBLE_RING, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  fs.writeFileSync(file, canvas.encodeSync('png'));
  return file;
}

// An avatar card keeps the title card and puts the presenter in a round
// bubble in its bottom-right corner: the copy stays the subject of the frame,
// the face does not take it over. The text block shifts left so the two never
// meet.
const BUBBLE_D = 460;
const BUBBLE_MARGIN = 64;
const BUBBLE = {
  d: BUBBLE_D,
  cx: W - BUBBLE_MARGIN - BUBBLE_D / 2,
  cy: H - BUBBLE_MARGIN - BUBBLE_D / 2,
  textCx: Math.round(W * 0.38),
  textW: Math.round(W * 0.6),
};
const BUBBLE_RING = 8;

// alpha mask for the clip: white disc on black, the bubble's size
function renderBubbleMask(file) {
  const canvas = createCanvas(BUBBLE.d, BUBBLE.d);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, BUBBLE.d, BUBBLE.d);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(BUBBLE.d / 2, BUBBLE.d / 2, BUBBLE.d / 2, 0, Math.PI * 2);
  ctx.fill();
  fs.writeFileSync(file, canvas.encodeSync('png'));
  return file;
}

function hasAudio(file) {
  const probe =
    process.env.FFPROBE ||
    (process.env.FFMPEG
      ? path.join(path.dirname(process.env.FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
      : 'ffprobe');
  const out = execFileSync(
    probe,
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return out.toString().trim().length > 0;
}

// The avatar's own audio is the voice. It gets the same LEAD/TAIL as a card
// (the first and last frames held), the same speech filter, and the same outer
// fades, so an avatar card joins the demo exactly like a still one. The clip is
// cropped square to fill the bubble — centred across, and biased to the top on
// a tall clip, where the face is.
function buildAvatarClip({ avatar, png, mask, out, fadeIn, fadeOut }) {
  const clipS = durationOf(avatar);
  const seconds = clipS + LEAD + TAIL;
  const delayMs = Math.round(LEAD * 1000);
  const D = BUBBLE.d;

  const fades = [];
  if (fadeIn) fades.push('fade=t=in:st=0:d=0.5');
  if (fadeOut) fades.push(`fade=t=out:st=${Math.max(0, seconds - 0.6).toFixed(2)}:d=0.6`);
  fades.push('format=yuv420p');

  const vf =
    `[1:v]scale=${D}:${D}:force_original_aspect_ratio=increase,` +
    `crop=${D}:${D}:(iw-ow)/2:(ih-oh)/4,setsar=1,fps=${FPS},` +
    `tpad=start_duration=${LEAD}:start_mode=clone:stop_duration=${TAIL}:stop_mode=clone,format=rgba[face];` +
    `[2:v]format=gray[mask];[face][mask]alphamerge[disc];` +
    `[0:v][disc]overlay=${BUBBLE.cx - D / 2}:${BUBBLE.cy - D / 2}:shortest=1,${fades.join(',')}[v];` +
    `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${delayMs}|${delayMs},apad,${SPEECH_FILTER}[a]`;

  ff([
    '-y', '-loglevel', 'error',
    '-loop', '1', '-framerate', String(FPS), '-t', seconds.toFixed(2), '-i', png,
    '-i', avatar,
    '-loop', '1', '-framerate', String(FPS), '-t', seconds.toFixed(2), '-i', mask,
    '-filter_complex', vf,
    '-map', '[v]', '-map', '[a]',
    '-r', String(FPS),
    '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast',
    '-crf', process.env.X264_CRF || '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
    '-t', seconds.toFixed(2),
    out,
  ]);
  return { file: out, seconds, clipS };
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
// A third part (`Headline | Subhead | support@example.com`) is a contact line
// under the subhead: shown, not spoken, since a voice reading an address out
// letter by letter helps nobody who can see it.
function splitCopy(kind, text) {
  const i = text.indexOf('|');
  if (i === -1) {
    return {
      headline: kind === 'intro' ? 'Product demo' : 'Thanks for watching',
      sub: text.trim(),
      contact: null,
      spoken: text.trim(),
    };
  }
  const [headline, sub, ...rest] = text.split('|').map((s) => s.trim());
  const contact = rest.join(' | ') || null;
  return { headline, sub, contact, spoken: `${headline}. ${sub}` };
}

async function makeCard(kind, text, avatar) {
  if (!text) return;

  const { headline, sub, contact, spoken } = splitCopy(kind, text);

  if (avatar) {
    if (!fs.existsSync(avatar)) {
      throw new Error(
        `${kind} avatar clip not found: ${avatar}\n` +
          `Generate it in ElevenCreative (Image & Video > Avatars) with this script, ` +
          `download the MP4 and save it there:\n\n  ${spoken}\n`,
      );
    }
    if (!hasAudio(avatar)) throw new Error(`${kind} avatar clip has no audio track: ${avatar}`);

    const png = await renderCard({ headline, sub, contact, file: path.join(tmp, `${kind}.png`), bubble: BUBBLE });
    const mask = renderBubbleMask(path.join(tmp, 'bubble-mask.png'));
    const clip = buildAvatarClip({
      avatar,
      png,
      mask,
      out: path.join(tmp, `${kind}.mp4`),
      fadeIn: kind === 'intro',
      fadeOut: kind === 'outro',
    });
    console.log(`  ${kind}: avatar ${path.basename(avatar)}, ${clip.clipS.toFixed(1)}s -> ${clip.seconds.toFixed(1)}s card`);
    console.log(`         should say: "${spoken}"`);
    parts.push({ kind, seconds: clip.seconds, file: clip.file });
    return;
  }

  const png = await renderCard({ headline, sub, contact, file: path.join(tmp, `${kind}.png`) });

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

await makeCard('intro', introText, introAvatar);
const introPart = parts.find((p) => p.kind === 'intro');
parts.length = 0;
await makeCard('outro', outroText, outroAvatar);
const outroPart = parts.find((p) => p.kind === 'outro');

// ---- section cards ----
// Each goes in where its beat begins (the page open before its first line, or
// just before that line when the take has no open there): the
// dissolve into the card takes the quiet end of the outgoing piece, and the
// dissolve out of it finishes GUARD before the line starts, so no voice fades.
const SXF = Number(process.env.CARD_SECTION_XFADE ?? 0.5);
const GUARD = 0.15;
const SECTION_MIN_S = 3;

// same discovery as narrate.mjs and qa.mjs: the take compose.mjs rendered from
function narrationCues() {
  try {
    const project = JSON.parse(fs.readFileSync(projectPath(), 'utf8').replace(/^﻿/, ''));
    const p = path.join(OUT, `${path.basename(project.videoPath)}.narration.json`);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // fall through
  }
  const p = [path.join(OUT, 'cut.mp4.narration.json'), path.join(OUT, 'raw.mp4.narration.json')].find((x) => fs.existsSync(x));
  if (!p) throw new Error("section cards need the take's narration cues (raw.mp4.narration.json): record and narrate first");
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function quietSpans(file, total) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'silencedetect=n=-40dB:d=0.2', '-f', 'null', '-'], { encoding: 'utf8' });
  const quiet = [];
  let qs = null;
  for (const line of (r.stderr ?? '').split('\n')) {
    const a = /silence_start: (-?[\d.]+)/.exec(line);
    if (a) qs = Math.max(0, Number(a[1]));
    const b = /silence_end: ([\d.]+)/.exec(line);
    if (b) {
      quiet.push([qs ?? 0, Number(b[1])]);
      qs = null;
    }
  }
  if (qs != null) quiet.push([qs, total]);
  return quiet;
}

const srcS = durationOf(src);
const placed = [];
if (sections.length) {
  const cues = narrationCues();
  // tighten moved the take's timeline; the narrated and composed videos are on it
  const map = /-tight\.mp4$/.test(src) ? readTimeMap(src) : { segments: [] };
  if (!map) throw new Error(`${path.basename(src)} has no time map: re-run tighten.mjs so section cards can be placed`);
  const quiet = quietSpans(src, srcS);

  let from = 0;
  for (const sec of sections) {
    const idx = cues.findIndex((c, i) => i >= from && c.text === sec.line);
    if (idx < 0) throw new Error(`section card "${sec.text}": no narration cue "${sec.line}" in this take: re-record it`);
    from = idx + 1;
    const lineAt = mapTime(map, cues[idx].atMs / 1000);
    // A card whose line is the take's first goes straight after the intro:
    // what comes before that line is only the opening load, and showing it
    // before the card reads as a flash of the app between two cards.
    // A beat opens its page before it speaks: the card goes where that open
    // began (leadAtMs, assemble.mjs), so the new page appears after the card
    // and not before it. A take without it falls back to just before the line.
    // The open can start while the previous line is still being spoken: the
    // card then waits for that line to end, so the dissolve into it stays in
    // the quiet before this beat's line and never fades a voice.
    const leadAt = cues[idx].leadAtMs != null ? mapTime(map, cues[idx].leadAtMs / 1000) : null;
    const lineQuiet = quiet.find(([a, b]) => a <= lineAt - 0.05 && b >= lineAt - 0.05);
    const latest = Math.max(0, lineAt - SXF - GUARD);
    const at = idx === 0 ? 0
      : leadAt != null && leadAt < lineAt
        ? Math.min(latest, Math.max(leadAt - SXF, lineQuiet ? lineQuiet[0] + SXF : 0, 0))
        : latest;
    const q = quiet.find(([a, b]) => a <= at - SXF + 0.05 && b >= at);
    if (idx > 0 && (!q || at - SXF < q[0] - 0.05)) {
      console.warn(`warning: section card "${sec.text}": only ${lineQuiet ? (at - lineQuiet[0]).toFixed(2) : '0'}s of quiet before it; the dissolve into it may touch speech`);
    }
    // Where the take resumes after the card: once the beat's page open has
    // finished (leadEndMs), so the previous screen never shows again after the
    // card (take 5 review). Never later than the dissolve before the line.
    const leadEnd = cues[idx].leadEndMs != null ? mapTime(map, cues[idx].leadEndMs / 1000) : null;
    const resume = idx === 0 || leadEnd == null ? at : Math.min(latest, Math.max(at, leadEnd));
    placed.push({ ...sec, at, resume, lineAt });
  }
}

for (const [i, sec] of placed.entries()) {
  const [headline, sub] = sec.text.split('|').map((x) => x.trim());
  sec.headline = headline;
  const png = await renderCard({ headline, sub: sub || null, contact: null, file: path.join(tmp, `section-${i + 1}.png`) });
  let audioFile = null;
  let seconds = SECTION_MIN_S;
  if (provider) {
    const { file, cached } = await speak(provider, `${headline}.`);
    audioFile = file;
    seconds = Math.max(seconds, audioDuration(file) + LEAD + 0.8);
  }
  console.log(`  section ${i + 1}: "${headline}" ${seconds.toFixed(1)}s card${provider ? '' : ', no voice'}, at ${sec.at.toFixed(2)}s${sec.resume > sec.at + 0.005 ? `, resumes at ${sec.resume.toFixed(2)}s` : ''}, before the line at ${sec.lineAt.toFixed(2)}s`);
  sec.seconds = seconds;
  sec.file = await buildClip({ png, seconds, audioFile, out: path.join(tmp, `section-${i + 1}.mp4`), fadeIn: false, fadeOut: false });
}

// ---- join ----
// xfade/acrossfade rather than concat: the card dissolves into the demo instead
// of cutting to it. Filters (not the concat demuxer) so mismatched encoder
// settings between the cards and the composed video cannot corrupt the join.
// Section cards cut the body into pieces; each input's `xf` is its dissolve
// with the input before it.

const xfAfter = (prev) => (!prev ? 0 : prev.kind === 'intro' ? XFADE : SXF);
const inputs = [];
if (introPart) inputs.push({ file: introPart.file, seconds: introPart.seconds, kind: 'intro', xf: 0 });
let bodyFrom = 0;
for (const sec of placed) {
  // a piece too short to dissolve on both sides is left out: the card then
  // follows the intro (or the previous card) and the next piece starts earlier
  const xfIn = xfAfter(inputs[inputs.length - 1]);
  if (sec.at - bodyFrom >= xfIn + SXF + 0.3) {
    inputs.push({ file: src, ss: bodyFrom, seconds: sec.at - bodyFrom, kind: 'body', xf: xfIn });
    bodyFrom = sec.at;
  }
  inputs.push({ file: sec.file, seconds: sec.seconds, kind: 'section', headline: sec.headline, xf: xfAfter(inputs[inputs.length - 1]) });
  // the quiet span [at, resume] is left out: it only shows the old page leaving
  if (sec.resume > bodyFrom) bodyFrom = sec.resume;
}
{
  const prev = inputs[inputs.length - 1];
  inputs.push({ file: src, ss: placed.length ? bodyFrom : null, seconds: srcS - bodyFrom, kind: 'body', xf: !prev ? 0 : prev.kind === 'section' ? SXF : XFADE });
}
if (outroPart) inputs.push({ file: outroPart.file, seconds: outroPart.seconds, kind: 'outro', xf: XFADE });

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

// Each dissolve overlaps the two clips, so the running total loses one
// dissolve per join: the next offset has to be measured against that shortened
// total, not against the sum of the source durations.
const steps = [];
let vPrev = '[v0]';
let aPrev = '[a0]';
let running = inputs[0].seconds;
const spans = [];
if (inputs[0].kind === 'section') spans.push({ headline: inputs[0].headline, start: 0, end: inputs[0].seconds });

for (let i = 1; i < n; i++) {
  const d = Math.max(0.06, Math.min(inputs[i].xf, running * 0.5, inputs[i].seconds * 0.5));
  const offset = Math.max(0, running - d);
  const vOut = i === n - 1 ? '[v]' : `[vx${i}]`;
  const aOut = i === n - 1 ? '[a]' : `[ax${i}]`;

  steps.push(
    `${vPrev}[v${i}]xfade=transition=fade:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}${vOut}`,
    `${aPrev}[a${i}]acrossfade=d=${d.toFixed(3)}:c1=tri:c2=tri${aOut}`,
  );
  if (inputs[i].kind === 'section') {
    spans.push({ headline: inputs[i].headline, start: Math.round(offset * 1000) / 1000, end: Math.round((offset + inputs[i].seconds) * 1000) / 1000 });
  }

  running = running + inputs[i].seconds - d;
  vPrev = vOut;
  aPrev = aOut;
}
if (n === 1) steps.push('[v0]null[v]', '[a0]anull[a]');

ff([
  '-y', '-loglevel', 'error',
  ...inputs.flatMap((s) => [...(s.ss != null ? ['-ss', s.ss.toFixed(3), '-t', s.seconds.toFixed(3)] : []), '-i', s.file]),
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
fs.writeFileSync(path.join(tmp, 'sections.json'), JSON.stringify({ video: path.basename(dst), spans }, null, 2) + '\n');

console.log(
  `  ${n} segments, ${n - 1} crossfade(s)` +
    `${introPart ? ', intro' : ''}${spans.length ? `, ${spans.length} section card(s)` : ''}${outroPart ? ' + outro' : ''} — ${running.toFixed(1)}s`,
);
