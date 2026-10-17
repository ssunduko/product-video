// The brand, read from one place.
//
// brand/StyleGuide.txt is the source of truth for colour and
// type. Every stage that paints anything imports this — compose.mjs for the
// video's own frame, cards.mjs for the title cards — so the style-guide hex
// cannot end up in one and not the other.
//
// Lines are "Label: value". Labels are matched on what they say rather than on
// exact wording, so the file stays human-editable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BRAND_DIR = path.join(HERE, '..', 'brand');
export const STYLEGUIDE = path.join(BRAND_DIR, 'StyleGuide.txt');
export const LOGO_WHITE = path.join(BRAND_DIR, 'salesmsg-logo-white.png');

// Only used if a line is missing from the file — these mirror it.
const DEFAULTS = {
  blue: '#1d94ef',
  green: '#13cb6e',
  headlineFont: 'Neue Einstellung',
  bodyFont: 'Inter',
};

export function readStyleGuide() {
  const style = { ...DEFAULTS };

  if (!fs.existsSync(STYLEGUIDE)) {
    console.warn(`warning: ${STYLEGUIDE} not found — using built-in brand defaults`);
    return style;
  }

  for (const raw of fs.readFileSync(STYLEGUIDE, 'utf8').split(/\r?\n/)) {
    const m = /^([^:]+):(.*)$/.exec(raw.trim());
    if (!m) continue;
    const label = m[1].toLowerCase();
    const value = m[2].trim();
    if (!value) continue;

    if (/blue/.test(label)) style.blue = value;
    else if (/green/.test(label)) style.green = value;
    else if (/headline|display|heading/.test(label)) style.headlineFont = value;
    else if (/body|text/.test(label)) style.bodyFont = value;
  }

  return style;
}

// ---- colour maths ----
export const rgbOf = (hex) => {
  const h = hex.replace('#', '').trim();
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export const hexOf = (rgb) =>
  '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');

export const mix = (a, b, t) => hexOf(rgbOf(a).map((c, i) => c + (rgbOf(b)[i] - c) * t));

// A darker relative of a hex that keeps its hue — used for the bottom of a
// gradient, so the field still reads as the brand colour rather than as navy.
export const shade = (hex, t) => mix(hex, '#062744', t);
