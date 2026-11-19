// Show still images inside a finished part: a screenshot of something the take
// could not record live (an event in another app, a result that arrived after
// the take) placed in the app window for a section, after its card.
//
//   node inserts.mjs --spec '<json>' [--video <carded.mp4>] [-o <out.mp4>]
//
// The spec is the manifest part's "inserts" array (build.mjs passes it):
//   [{ "section": "<card headline>",            // after this card ...
//      "images": [                               // ... until the next card (or the outro)
//        { "file": "out/<name>/stills/a.jpg",    // relative to the repo root
//          "frame": [x, y, w, h],                // optional red frame round this box (image px; drawn 6px outside it)
//          "share": 0.4 },                       // optional share of the span (default: equal)
//        ...] }]
//
// Each image is drawn into the app window of the frame it replaces: the window
// rect is measured from the video itself (the brand background around it), so
// padding, corners and shadow stay exactly as compose drew them. The image is
// fitted inside the window, letterboxed with its own edge colour, and dissolves
// in and out. Audio is copied: the narration plays on over the stills.
// Writes final-narrated-tight-carded-inserted.mp4 next to the input.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas, loadImage, ImageData } from '@napi-rs/canvas';
import { OUT } from './paths.mjs';
import { renderDiagram, normaliseDiagram } from './diagram.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE =
  process.env.FFPROBE ||
  (process.env.FFMPEG
    ? path.join(path.dirname(process.env.FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : 'ffprobe');
const HIGHLIGHT_COLOR = process.env.HIGHLIGHT_COLOR || '#E5322D';
export const FADE_S = 0.4;
export const CARD_XF = Number(process.env.CARD_SECTION_XFADE ?? 0.5); // cards.mjs's section dissolve
export const INSERTED = 'final-narrated-tight-carded-inserted.mp4';

// ---- pure helpers (unit tested) ----

// When each image shows: from the end of the named section's card to the start
// of the next card, or to `endS` (the outro's start) when it is the last.
export function insertSchedule(spans, insert, endS) {
  const i = spans.findIndex((s) => s.headline === insert.section);
  if (i < 0) throw new Error(`inserts: no section card "${insert.section}" (cards: ${spans.map((s) => s.headline).join(', ')})`);
  const from = spans[i].end;
  const to = i + 1 < spans.length ? spans[i + 1].start : endS;
  if (!(to - from > 2 * FADE_S)) throw new Error(`inserts: section "${insert.section}" leaves no room (${from.toFixed(2)}-${to.toFixed(2)}s)`);
  const images = insert.images ?? [];
  if (!images.length) throw new Error(`inserts: section "${insert.section}" has no images`);
  const shares = images.map((im) => im.share ?? 1 / images.length);
  if (shares.some((s) => !(s > 0))) throw new Error('inserts: every share must be > 0');
  const sum = shares.reduce((a, b) => a + b, 0);
  let t = from;
  return images.map((im, k) => {
    const d = ((to - from) * shares[k]) / sum;
    const slot = { ...im, startS: t, endS: k === images.length - 1 ? to : t + d };
    t += d;
    return slot;
  });
}

// An image entry { "diagram": "<spec.json>" } stands for the diagram's build-up:
// one full-frame image per step (its share split evenly), or only { "step": n }.
export function expandDiagrams(images, stepsOf) {
  return images.flatMap((im) => {
    if (!im.diagram) return [im];
    if (im.step != null) return [{ fit: 'frame', ...im }];
    const n = stepsOf(im.diagram);
    const share = (im.share ?? 1) / n;
    return Array.from({ length: n }, (_, k) => ({ ...im, fit: im.fit ?? 'frame', step: k + 1, share }));
  });
}

function readDiagram(file) {
  const spec = JSON.parse(fs.readFileSync(path.resolve(ROOT, file), 'utf8'));
  return { spec, steps: normaliseDiagram(spec).steps };
}

// When each plate is on screen, and how it fades, so the take never shows: the
// card's own dissolve (xf, CARD_SECTION_XFADE) runs from the card into the take,
// so for its length a still of the card is laid over the video and the first
// plate dissolves in over that; each later plate dissolves over the one before,
// which stays fully up until it is covered; the last dissolves out over a still
// of the next card for the length of that card's dissolve in. Plates are full
// frames, so these are true card-to-screenshot dissolves.
export function overlayTimes(slots, xf = CARD_XF) {
  return slots.map((s, k) => {
    const first = k === 0;
    const last = k === slots.length - 1;
    return {
      from: first ? s.startS - xf : s.startS,
      to: last ? s.endS + xf : s.endS + FADE_S,
      fadeIn: first ? xf : FADE_S,
      fadeOut: last ? xf : 0,
    };
  });
}

// The card stills laid under the first and last dissolves: when each shows, and
// a moment inside the card to take it from (clear of both of its dissolves).
export function cardHolds(slots, xf = CARD_XF) {
  const a = slots[0];
  const z = slots[slots.length - 1];
  return [
    { from: a.startS - xf, to: a.startS, grabS: a.startS - xf - 0.1 },
    { from: z.endS, to: z.endS + xf, grabS: z.endS + xf + 0.1 },
  ];
}

// The app window inside a composed frame: the bounding box of everything that
// is not the brand background (blue-dominant pixels), scanned along the middle
// row and column so the window's content cannot confuse it.
export function findWindowRect(data, width, height) {
  const isBg = (x, y) => {
    const o = (y * width + x) * 4;
    const [r, g, b] = [data[o], data[o + 1], data[o + 2]];
    return b > r + 40 && b > g + 15 && r < 120;
  };
  const my = Math.floor(height / 2);
  const mx = Math.floor(width / 2);
  let left = 0;
  while (left < width && isBg(left, my)) left++;
  let right = width - 1;
  while (right > left && isBg(right, my)) right--;
  let top = 0;
  while (top < height && isBg(mx, top)) top++;
  let bottom = height - 1;
  while (bottom > top && isBg(mx, bottom)) bottom--;
  if (right - left < width * 0.5 || bottom - top < height * 0.5) throw new Error('inserts: could not find the app window in the frame');
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

// Fit an image inside a box, aspect kept, centred.
export function fitRect(box, iw, ih) {
  const k = Math.min(box.w / iw, box.h / ih);
  const w = Math.round(iw * k);
  const h = Math.round(ih * k);
  return { x: box.x + Math.round((box.w - w) / 2), y: box.y + Math.round((box.h - h) / 2), w, h, scale: k };
}

// ---- stage ----

function probe(file) {
  const j = JSON.parse(
    execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', file]).toString(),
  );
  const s = j.streams[0];
  const [n, d] = s.r_frame_rate.split('/').map(Number);
  return { width: s.width, height: s.height, fps: n / (d || 1), durationS: Number(j.format.duration) };
}

function grabFrame(file, atS, width, height) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(atS), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: width * height * 4 + 1024 });
  if (r.status !== 0 || r.stdout.length < width * height * 4) throw new Error(`inserts: could not read a frame at ${atS}s`);
  return new Uint8ClampedArray(r.stdout.buffer, r.stdout.byteOffset, width * height * 4);
}

async function renderPlate(slot, win, size, radius, outFile, under) {
  const img = await loadImage(path.resolve(ROOT, slot.file));
  const full = createCanvas(size.width, size.height);
  if (slot.fit === 'frame') {
    // the whole frame (a diagram): the image covers it, no app window
    const fx = full.getContext('2d');
    const f = fitRect({ x: 0, y: 0, w: size.width, h: size.height }, img.width, img.height);
    fx.fillStyle = '#ffffff';
    fx.fillRect(0, 0, size.width, size.height);
    fx.imageSmoothingQuality = 'high';
    fx.drawImage(img, f.x, f.y, f.w, f.h);
    fs.writeFileSync(outFile, full.toBuffer('image/png'));
    return;
  }
  // the take's own frame (brand background, shadow) around the window
  full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(under), size.width, size.height), 0, 0);
  const c = createCanvas(win.w, win.h);
  const x = c.getContext('2d');
  // letterbox with the image's own top-left colour, so the bars read as page
  const probeC = createCanvas(1, 1);
  probeC.getContext('2d').drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
  const [r, g, b] = probeC.getContext('2d').getImageData(0, 0, 1, 1).data;
  x.save();
  x.beginPath();
  x.roundRect(0, 0, win.w, win.h, radius);
  x.clip();
  x.fillStyle = `rgb(${r},${g},${b})`;
  x.fillRect(0, 0, win.w, win.h);
  const f = fitRect({ x: 0, y: 0, w: win.w, h: win.h }, img.width, img.height);
  x.imageSmoothingQuality = 'high';
  x.drawImage(img, f.x, f.y, f.w, f.h);
  if (slot.frame) {
    const [fx, fy, fw, fh] = slot.frame;
    const pad = 6 * f.scale;
    x.strokeStyle = HIGHLIGHT_COLOR;
    x.lineWidth = 4 * (size.width / 1920);
    x.beginPath();
    x.roundRect(f.x + (fx * f.scale) - pad, f.y + (fy * f.scale) - pad, fw * f.scale + 2 * pad, fh * f.scale + 2 * pad, 8);
    x.stroke();
  }
  x.restore();
  full.getContext('2d').drawImage(c, win.x, win.y);
  fs.writeFileSync(outFile, full.toBuffer('image/png'));
}

async function main(argv) {
  let spec = null;
  let video = path.join(OUT, 'final-narrated-tight-carded.mp4');
  let output = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--spec') spec = JSON.parse(argv[++i]);
    else if (argv[i] === '--video') video = path.resolve(argv[++i]);
    else if (argv[i] === '-o') output = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!Array.isArray(spec) || !spec.length) throw new Error('usage: node inserts.mjs --spec \'[{"section": ..., "images": [...]}]\'');
  output ??= path.join(path.dirname(video), INSERTED);
  const sectionsFile = path.join(path.dirname(video), 'cards', 'sections.json');
  if (!fs.existsSync(sectionsFile)) throw new Error(`inserts: no ${path.relative(ROOT, sectionsFile)} — inserts are placed after section cards`);
  const { spans } = JSON.parse(fs.readFileSync(sectionsFile, 'utf8'));
  const v = probe(video);
  const outroFile = path.join(path.dirname(video), 'cards', 'outro.mp4');
  const endS = fs.existsSync(outroFile) ? v.durationS - probe(outroFile).durationS : v.durationS;

  const plateDir = path.join(path.dirname(video), 'inserts');
  fs.mkdirSync(plateDir, { recursive: true });
  const expanded = spec.map((ins) => ({ ...ins, images: expandDiagrams(ins.images ?? [], (file) => readDiagram(file).steps) }));
  for (const ins of expanded) {
    for (const im of ins.images) {
      if (!im.diagram) continue;
      const out = path.join(plateDir, `${path.basename(im.diagram).replace(/.diagram.json$|.json$/, '')}-step-${im.step}.png`);
      fs.writeFileSync(out, renderDiagram(readDiagram(im.diagram).spec, { width: v.width, height: v.height, step: im.step }).canvas.toBuffer('image/png'));
      im.file = path.relative(ROOT, out);
    }
  }
  const slots = expanded.flatMap((ins) => insertSchedule(spans, ins, endS));
  for (const s of slots) if (!fs.existsSync(path.resolve(ROOT, s.file))) throw new Error(`inserts: no image ${s.file}`);

  const inputs = ['-i', video];
  const chains = [];
  let last = '0:v';
  let n = 0;
  const layer = (file, from, to, filters) => {
    n++;
    inputs.push('-loop', '1', '-framerate', String(v.fps), '-t', (to - from).toFixed(3), '-i', file);
    chains.push(
      `[${n}:v]format=rgba${filters.length ? ',' + filters.join(',') : ''},setpts=PTS-STARTPTS+${from.toFixed(3)}/TB[p${n}]`,
      `[${last}][p${n}]overlay=x=0:y=0:eof_action=pass[o${n}]`,
    );
    last = `o${n}`;
  };
  // the card stills under the first and last dissolves
  for (const [k, h] of cardHolds(slots).entries()) {
    const still = path.join(plateDir, `card-${k + 1}.png`);
    const c = createCanvas(v.width, v.height);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(grabFrame(video, h.grabS, v.width, v.height)), v.width, v.height), 0, 0);
    fs.writeFileSync(still, c.toBuffer('image/png'));
    layer(still, h.from, h.to, []);
  }
  const times = overlayTimes(slots);
  for (const [k, s] of slots.entries()) {
    const frame = grabFrame(video, s.startS + FADE_S, v.width, v.height);
    const win = findWindowRect(frame, v.width, v.height);
    const radius = Math.round(16 * (v.width / 1920) * 1.2);
    const plate = path.join(plateDir, `insert-${k + 1}.png`);
    await renderPlate(s, win, v, radius, plate, frame);
    const t = times[k];
    console.log(`inserts: ${s.file} -> ${t.from.toFixed(2)}-${t.to.toFixed(2)}s ${s.fit === 'frame' ? 'full frame' : `in window ${win.w}x${win.h}+${win.x}+${win.y}`}`);
    const dur = t.to - t.from;
    layer(plate, t.from, t.to, [`fade=in:st=0:d=${t.fadeIn}:alpha=1`, ...(t.fadeOut ? [`fade=out:st=${(dur - t.fadeOut).toFixed(3)}:d=${t.fadeOut}:alpha=1`] : [])]);
  }
  const args = [
    '-y', '-v', 'error', ...inputs,
    '-filter_complex', chains.join(';'),
    '-map', `[${last}]`, '-map', '0:a?',
    '-c:v', 'libx264', '-preset', process.env.X264_PRESET || 'veryfast', '-crf', process.env.X264_CRF || '18',
    '-pix_fmt', 'yuv420p', '-r', String(v.fps), '-c:a', 'copy', '-movflags', '+faststart',
    output,
  ];
  const r = spawnSync(FFMPEG, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('inserts: ffmpeg failed');
  console.log(`inserts: ${slots.length} image(s) -> ${path.relative(ROOT, output)}`);
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
