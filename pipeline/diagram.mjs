// General-purpose diagrams as full-frame images in the brand's colours and type:
// boxes and circles with Lucide icons, labelled arrows, groups, and bar charts,
// laid out automatically (a flow left to right or top to bottom, or a grid) or at
// given positions. A diagram can build up in steps: one PNG per step, each with
// everything up to that step, which inserts.mjs shows in turn (it dissolves from
// one to the next).
//
//   node diagram.mjs <spec.json> [-o <dir>] [--size 1920x1080]
//   node diagram.mjs --icons <word>             # search the icon names
//
// Spec:
//   { "title": "How a booking reaches your calendar",   // optional heading
//     "subtitle": "...",                                 // optional
//     "theme": "light",            // light (default) | brand (white on the brand blue)
//     "layout": "right",           // right (default) | down | grid | manual
//     "columns": 3,                // grid only
//     "nodes": [ { "id": "sms", "label": "Contact texts", "icon": "message-square",
//                  "shape": "box", // box (default) | pill | circle
//                  "color": "blue",// blue | green | gray | orange | purple | red | #hex
//                  "x": 400, "y": 540,  // manual layout: centre, in pixels of the frame
//                  "step": 1 } ],  // appears from this step (default 1)
//     "edges": [ { "from": "sms", "to": "agent", "label": "asks for a time",
//                  "dashed": false, "bend": 0, "step": 2 } ],
//     "groups": [ { "label": "Your app", "nodes": ["agent", "cal"], "color": "gray", "step": 1 } ],
//     "chart": { "type": "bars", "data": [ { "label": "Mon", "value": 4 } ], "suffix": "", "step": 1 } }
//
// Icons are Lucide's (vendor/lucide, ISC), drawn as strokes on a 24-unit grid.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas, GlobalFonts, Path2D } from '@napi-rs/canvas';
import { readStyleGuide, mix, shade, BRAND_DIR } from './brand.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- icons ----
let ICONS = null;
export function icons() {
  ICONS ??= JSON.parse(fs.readFileSync(path.join(HERE, 'vendor', 'lucide', 'lucide.json'), 'utf8'));
  return ICONS;
}
export function iconPaths(name) {
  const { icons: all, aliases } = icons();
  return all[name] ?? all[aliases[name]] ?? null;
}
export function searchIcons(word) {
  const w = String(word).toLowerCase();
  return Object.keys(icons().icons).filter((k) => k.includes(w));
}

// ---- spec ----
const SHAPES = ['box', 'pill', 'circle'];
const LAYOUTS = ['right', 'down', 'grid', 'manual'];

export function normaliseDiagram(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('diagram: the spec must be an object');
  const nodes = (spec.nodes ?? []).map((n, i) => {
    if (!n.id) throw new Error(`diagram: node ${i + 1} has no id`);
    if (n.shape && !SHAPES.includes(n.shape)) throw new Error(`diagram: node "${n.id}" shape must be one of ${SHAPES.join(', ')}`);
    if (n.icon && !iconPaths(n.icon)) throw new Error(`diagram: node "${n.id}" icon "${n.icon}" is not a Lucide icon (try: node diagram.mjs --icons ${n.icon.split('-')[0]})`);
    return { shape: 'box', color: 'blue', step: 1, label: '', ...n };
  });
  const ids = new Set();
  for (const n of nodes) {
    if (ids.has(n.id)) throw new Error(`diagram: two nodes are called "${n.id}"`);
    ids.add(n.id);
  }
  const edges = (spec.edges ?? []).map((e, i) => {
    for (const k of ['from', 'to']) if (!ids.has(e[k])) throw new Error(`diagram: edge ${i + 1} ${k} "${e[k]}" is not a node`);
    return { step: 1, bend: 0, dashed: false, ...e };
  });
  const groups = (spec.groups ?? []).map((g, i) => {
    for (const id of g.nodes ?? []) if (!ids.has(id)) throw new Error(`diagram: group ${i + 1} names "${id}", which is not a node`);
    if (!(g.nodes ?? []).length) throw new Error(`diagram: group ${i + 1} has no nodes`);
    return { color: 'gray', step: 1, ...g };
  });
  const layout = spec.layout ?? (nodes.length && nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)) ? 'manual' : 'right');
  if (!LAYOUTS.includes(layout)) throw new Error(`diagram: layout must be one of ${LAYOUTS.join(', ')}`);
  if (layout === 'manual') for (const n of nodes) if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) throw new Error(`diagram: manual layout needs x and y on node "${n.id}"`);
  let chart = null;
  if (spec.chart) {
    if (spec.chart.type !== 'bars') throw new Error('diagram: chart type must be "bars"');
    if (!Array.isArray(spec.chart.data) || !spec.chart.data.length) throw new Error('diagram: a chart needs data');
    chart = { step: 1, suffix: '', ...spec.chart };
  }
  if (!nodes.length && !chart) throw new Error('diagram: nothing to draw (no nodes and no chart)');
  const theme = spec.theme ?? 'light';
  if (!['light', 'brand'].includes(theme)) throw new Error('diagram: theme must be light or brand');
  const steps = Math.max(1, ...nodes.map((n) => n.step), ...edges.map((e) => e.step), ...groups.map((g) => g.step), chart?.step ?? 1);
  return { title: spec.title ?? '', subtitle: spec.subtitle ?? '', theme, layout, columns: spec.columns, nodes, edges, groups, chart, steps };
}

// Rank of each node along the flow: the longest path to it from a node with no
// incoming edge. Back edges (cycles) are ignored.
export function ranks(nodes, edges) {
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) out.get(e.from).push(e.to);
  const state = new Map();
  const back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const t of out.get(id)) {
      if (state.get(t) === 1) back.add(`${id}>${t}`);
      else if (!state.get(t)) visit(t);
    }
    state.set(id, 2);
  };
  for (const n of nodes) if (!state.get(n.id)) visit(n.id);
  const rank = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const e of edges) {
      if (back.has(`${e.from}>${e.to}`)) continue;
      if (rank.get(e.to) < rank.get(e.from) + 1) { rank.set(e.to, rank.get(e.from) + 1); moved = true; }
    }
    if (!moved) break;
  }
  return rank;
}

// Centres for every node in the content area {x, y, w, h}. For a flow, each
// rank is as wide as its widest node and each gap as wide as the widest arrow
// label crossing it (at least minGap), so labels never sit on a box; the whole
// flow is centred. sizes: id -> {w, h}; labelW: "from>to" -> label width.
export function place(d, area, sizes = new Map(), { labelW = new Map(), minGap = 120, crossGap = 70, labelPad = 60 } = {}) {
  if (d.layout === 'manual') return new Map(d.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  if (d.layout === 'grid') {
    const cols = Math.max(1, d.columns ?? Math.ceil(Math.sqrt(d.nodes.length)));
    const rows = Math.ceil(d.nodes.length / cols);
    return new Map(d.nodes.map((n, i) => [n.id, { x: area.x + (((i % cols) + 0.5) * area.w) / cols, y: area.y + ((Math.floor(i / cols) + 0.5) * area.h) / rows }]));
  }
  const down = d.layout === 'down';
  const along = (id) => (down ? sizes.get(id)?.h : sizes.get(id)?.w) ?? 0;
  const across = (id) => (down ? sizes.get(id)?.w : sizes.get(id)?.h) ?? 0;
  const rank = ranks(d.nodes, d.edges);
  const nRanks = Math.max(...rank.values()) + 1;
  const byRank = Array.from({ length: nRanks }, () => []);
  for (const n of d.nodes) byRank[rank.get(n.id)].push(n.id);
  const size = byRank.map((ids) => Math.max(0, ...ids.map(along)));
  const gaps = Array.from({ length: Math.max(0, nRanks - 1) }, (_, r) => {
    let g = minGap;
    for (const e of d.edges) {
      const [ra, rb] = [rank.get(e.from), rank.get(e.to)];
      if (Math.min(ra, rb) <= r && Math.max(ra, rb) > r) g = Math.max(g, (down ? 0 : labelW.get(`${e.from}>${e.to}`) ?? 0) + labelPad);
    }
    return g;
  });
  const total = size.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
  const span = down ? area.h : area.w;
  let t = (down ? area.y : area.x) + Math.max(0, (span - total) / 2);
  const centreAlong = size.map((s, r) => { const c = t + s / 2; t += s + (gaps[r] ?? 0); return c; });
  const pos = new Map();
  byRank.forEach((ids, r) => {
    const tot = ids.reduce((a, id) => a + across(id), 0) + crossGap * (ids.length - 1);
    let u = (down ? area.x + area.w / 2 : area.y + area.h / 2) - tot / 2;
    for (const id of ids) {
      const c = u + across(id) / 2;
      u += across(id) + crossGap;
      pos.set(id, down ? { x: c, y: centreAlong[r] } : { x: centreAlong[r], y: c });
    }
  });
  pos.fits = total <= span;
  return pos;
}

// Where the segment from a node's centre towards (tx, ty) leaves its outline.
export function exitPoint(c, half, shape, tx, ty, gap = 12) {
  const dx = tx - c.x;
  const dy = ty - c.y;
  const len = Math.hypot(dx, dy) || 1;
  if (shape === 'circle') {
    const r = half.w + gap;
    return { x: c.x + (dx / len) * r, y: c.y + (dy / len) * r };
  }
  const sx = Math.abs(dx) > 1e-9 ? (half.w + gap) / Math.abs(dx) : Infinity;
  const sy = Math.abs(dy) > 1e-9 ? (half.h + gap) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

// ---- drawing ----
const NAMED = { blue: null, green: null, gray: '#64748b', orange: '#ea580c', purple: '#7c3aed', red: '#dc2626' };

let FONTS = null;
function fonts(style) {
  if (FONTS) return FONTS;
  for (const dir of [BRAND_DIR, path.join(BRAND_DIR, 'fonts')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (/\.(ttf|otf|ttc|woff2?)$/i.test(f)) GlobalFonts.registerFromPath(path.join(dir, f));
  }
  const pick = (want) => (GlobalFonts.has(want) ? want : ['Segoe UI', 'Helvetica Neue', 'Arial', 'DejaVu Sans'].find((f) => GlobalFonts.has(f)) ?? 'sans-serif');
  FONTS = { head: pick(style.headlineFont), body: pick(style.bodyFont) };
  return FONTS;
}

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function drawIcon(ctx, name, x, y, size, color) {
  const paths = iconPaths(name);
  if (!paths) return;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const d of paths) ctx.stroke(new Path2D(d));
  ctx.restore();
}

function arrowHead(ctx, x, y, angle, size) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(angle - 0.45), y - size * Math.sin(angle - 0.45));
  ctx.lineTo(x - size * Math.cos(angle + 0.45), y - size * Math.sin(angle + 0.45));
  ctx.closePath();
  ctx.fill();
}

export function renderDiagram(spec, { width = 1920, height = 1080, step } = {}) {
  const d = normaliseDiagram(spec);
  const upTo = step ?? d.steps;
  const style = readStyleGuide();
  const F = fonts(style);
  let k = width / 1920;
  const brand = d.theme === 'brand';
  const col = (c) => (c === 'blue' || !c ? style.blue : c === 'green' ? style.green : NAMED[c] ?? c);
  const ink = brand ? '#ffffff' : '#1f2937';
  const muted = brand ? mix('#ffffff', style.blue, 0.3) : '#64748b';

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (brand) {
    const g = ctx.createLinearGradient(0, 0, width, height);
    g.addColorStop(0, style.blue);
    g.addColorStop(1, shade(style.blue, 0.72));
    ctx.fillStyle = g;
  } else ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, width, height);

  // heading
  const margin = Math.round(width * 0.07);
  let top = Math.round(height * 0.08);
  if (d.title) {
    ctx.fillStyle = ink;
    ctx.font = `700 ${Math.round(60 * k)}px "${F.head}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(d.title, width / 2, top);
    top += Math.round(84 * k);
    if (d.subtitle) {
      ctx.fillStyle = muted;
      ctx.font = `400 ${Math.round(34 * k)}px "${F.body}"`;
      ctx.fillText(d.subtitle, width / 2, top);
      top += Math.round(56 * k);
    }
    top += Math.round(24 * k);
  }
  const area = { x: margin, y: top, w: width - 2 * margin, h: height - top - Math.round(height * 0.08) };

  // chart
  if (d.chart && d.chart.step <= upTo) {
    const data = d.chart.data;
    const max = Math.max(...data.map((x) => x.value), 1);
    const n = data.length;
    const slot = area.w / n;
    const barW = slot * 0.56;
    const base = area.y + area.h - Math.round(60 * k);
    const room = area.h - Math.round(130 * k);
    ctx.textAlign = 'center';
    data.forEach((x, i) => {
      const cx = area.x + slot * (i + 0.5);
      const h = (x.value / max) * room;
      ctx.fillStyle = col(x.color ?? 'blue');
      ctx.beginPath();
      ctx.roundRect(cx - barW / 2, base - h, barW, h, [12 * k, 12 * k, 0, 0]);
      ctx.fill();
      ctx.fillStyle = ink;
      ctx.font = `700 ${Math.round(36 * k)}px "${F.head}"`;
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${x.value}${d.chart.suffix}`, cx, base - h - 10 * k);
      ctx.fillStyle = muted;
      ctx.font = `400 ${Math.round(30 * k)}px "${F.body}"`;
      ctx.textBaseline = 'top';
      ctx.fillText(x.label, cx, base + 14 * k);
    });
  }

  if (!d.nodes.length) return { canvas, steps: d.steps };

  // node sizes, then positions: scaled down (to 60%) until the flow fits
  const ranksN = d.layout === 'right' ? Math.max(...ranks(d.nodes, d.edges).values()) + 1 : 3;
  const layoutAt = (kk) => {
    const font = Math.round(36 * kk);
    const iconSize = Math.round(64 * kk);
    const pad = Math.round(28 * kk);
    const maxLabel = Math.min(360 * kk, (area.w / Math.max(ranksN, 1)) * 0.5);
    ctx.font = `600 ${font}px "${F.body}"`;
    const geom = new Map();
    for (const n of d.nodes) {
      const lines = wrap(ctx, n.label, maxLabel);
      const textW = Math.max(...lines.map((l) => ctx.measureText(l).width), 0);
      const textH = lines.length * font * 1.2;
      const innerH = (n.icon ? iconSize + 14 * kk : 0) + (n.label ? textH : 0);
      let w = Math.max(textW, n.icon ? iconSize : 0) + 2 * pad;
      let h = innerH + 2 * pad;
      if (n.shape === 'circle') w = h = Math.max(w, h);
      geom.set(n.id, { lines, w, h, half: { w: w / 2, h: h / 2 }, textH });
    }
    ctx.font = `500 ${Math.round(28 * kk)}px "${F.body}"`;
    const labelW = new Map(d.edges.filter((e) => e.label).map((e) => [`${e.from}>${e.to}`, ctx.measureText(e.label).width + 28 * kk]));
    const pos = place(d, area, geom, { labelW, minGap: 110 * kk, crossGap: 70 * kk, labelPad: 90 * kk });
    return { font, iconSize, pad, geom, pos };
  };
  let L = layoutAt(k);
  for (let z = 0.9; L.pos.fits === false && z >= 0.6 - 1e-9; z -= 0.1) L = layoutAt(k * z);
  if (L.pos.fits === false) console.warn('diagram: the flow is wider than the frame even at 60%; shorten labels or use layout "down" or "grid"');
  k = (L.font / 36);
  const { font, iconSize, geom, pos } = L;
  const visible = (x) => x.step <= upTo;

  // groups (under everything)
  for (const g of d.groups.filter(visible)) {
    const shown = g.nodes.filter((id) => d.nodes.find((n) => n.id === id).step <= upTo);
    if (!shown.length) continue;
    const members = shown.map((id) => ({ c: pos.get(id), s: geom.get(id) }));
    const x0 = Math.min(...members.map((m) => m.c.x - m.s.half.w)) - 36 * k;
    const x1 = Math.max(...members.map((m) => m.c.x + m.s.half.w)) + 36 * k;
    const y0 = Math.min(...members.map((m) => m.c.y - m.s.half.h)) - 70 * k;
    const y1 = Math.max(...members.map((m) => m.c.y + m.s.half.h)) + 36 * k;
    ctx.save();
    ctx.setLineDash([14 * k, 10 * k]);
    ctx.strokeStyle = brand ? mix('#ffffff', style.blue, 0.4) : mix(col(g.color), '#ffffff', 0.35);
    ctx.fillStyle = brand ? 'rgba(255,255,255,0.06)' : mix(col(g.color), '#ffffff', 0.93);
    ctx.lineWidth = 3 * k;
    ctx.beginPath();
    ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 24 * k);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (g.label) {
      ctx.fillStyle = muted;
      ctx.font = `600 ${Math.round(28 * k)}px "${F.body}"`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(g.label, x0 + 22 * k, y0 + 16 * k);
    }
  }

  // edges
  for (const e of d.edges.filter(visible)) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    const na = d.nodes.find((n) => n.id === e.from);
    const nb = d.nodes.find((n) => n.id === e.to);
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // a bend moves the middle sideways, a quarter of the length at 1
    const mx = (a.x + b.x) / 2 + (-(b.y - a.y) / len) * e.bend * len * 0.25;
    const my = (a.y + b.y) / 2 + ((b.x - a.x) / len) * e.bend * len * 0.25;
    const p0 = exitPoint(a, geom.get(e.from).half, na.shape, e.bend ? mx : b.x, e.bend ? my : b.y, 12 * k);
    const p1 = exitPoint(b, geom.get(e.to).half, nb.shape, e.bend ? mx : a.x, e.bend ? my : a.y, 16 * k);
    const color = brand ? '#ffffff' : '#475569';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 4 * k;
    if (e.dashed) ctx.setLineDash([16 * k, 12 * k]);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    let angle;
    if (e.bend) {
      ctx.quadraticCurveTo(mx, my, p1.x, p1.y);
      angle = Math.atan2(p1.y - my, p1.x - mx);
    } else {
      ctx.lineTo(p1.x, p1.y);
      angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    arrowHead(ctx, p1.x, p1.y, angle, 22 * k);
    ctx.restore();
    if (e.label) {
      const lx = e.bend ? (p0.x + 2 * mx + p1.x) / 4 : (p0.x + p1.x) / 2;
      const ly = e.bend ? (p0.y + 2 * my + p1.y) / 4 : (p0.y + p1.y) / 2;
      ctx.font = `500 ${Math.round(28 * k)}px "${F.body}"`;
      const tw = ctx.measureText(e.label).width;
      const bw = tw + 28 * k;
      const bh = 44 * k;
      ctx.fillStyle = brand ? shade(style.blue, 0.35) : '#ffffff';
      ctx.strokeStyle = brand ? 'rgba(255,255,255,0.35)' : '#cbd5e1';
      ctx.lineWidth = 2 * k;
      ctx.beginPath();
      ctx.roundRect(lx - bw / 2, ly - bh / 2, bw, bh, bh / 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(e.label, lx, ly + 1);
    }
  }

  // nodes
  for (const n of d.nodes.filter(visible)) {
    const c = pos.get(n.id);
    const s = geom.get(n.id);
    const color = col(n.color);
    ctx.save();
    ctx.shadowColor = 'rgba(15,23,42,0.18)';
    ctx.shadowBlur = 24 * k;
    ctx.shadowOffsetY = 8 * k;
    ctx.fillStyle = brand ? '#ffffff' : mix(color, '#ffffff', 0.9);
    ctx.beginPath();
    if (n.shape === 'circle') ctx.arc(c.x, c.y, s.half.w, 0, Math.PI * 2);
    else ctx.roundRect(c.x - s.half.w, c.y - s.half.h, s.w, s.h, n.shape === 'pill' ? s.half.h : 20 * k);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = color;
    ctx.lineWidth = 4 * k;
    ctx.stroke();
    let y = c.y - (n.icon ? iconSize + 14 * k : 0) / 2 - (n.label ? s.textH : 0) / 2;
    if (n.icon) {
      drawIcon(ctx, n.icon, c.x, y + iconSize / 2, iconSize, color);
      y += iconSize + 14 * k;
    }
    ctx.fillStyle = '#1f2937';
    ctx.font = `600 ${font}px "${F.body}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const line of s.lines) {
      ctx.fillText(line, c.x, y + font * 0.1);
      y += font * 1.2;
    }
  }
  return { canvas, steps: d.steps };
}

// Writes <dir>/<name>-step-<n>.png for each step (all steps up to n), and
// <dir>/<name>.png with everything. Returns the files in step order.
export function writeDiagram(spec, { dir, name, width = 1920, height = 1080 }) {
  fs.mkdirSync(dir, { recursive: true });
  const { steps } = renderDiagram(spec, { width, height, step: 1 });
  const files = [];
  for (let s = 1; s <= steps; s++) {
    const f = path.join(dir, steps === 1 ? `${name}.png` : `${name}-step-${s}.png`);
    fs.writeFileSync(f, renderDiagram(spec, { width, height, step: s }).canvas.toBuffer('image/png'));
    files.push(f);
  }
  if (steps > 1) fs.copyFileSync(files[files.length - 1], path.join(dir, `${name}.png`));
  return files;
}

function main(argv) {
  if (argv[0] === '--icons') {
    const hits = searchIcons(argv[1] ?? '');
    console.log(hits.length ? hits.join('\n') : 'no icon matches');
    return;
  }
  let file = null;
  let dir = null;
  let size = '1920x1080';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-o') dir = argv[++i];
    else if (argv[i] === '--size') size = argv[++i];
    else if (!file) file = argv[i];
    else throw new Error(`unexpected argument ${argv[i]}`);
  }
  if (!file) throw new Error('usage: node diagram.mjs <spec.json> [-o <dir>] [--size 1920x1080]');
  const [width, height] = size.split('x').map(Number);
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const name = path.basename(file).replace(/\.diagram\.json$|\.json$/, '');
  const files = writeDiagram(spec, { dir: dir ?? path.dirname(path.resolve(file)), name, width, height });
  for (const f of files) console.log(`diagram: ${f}`);
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
