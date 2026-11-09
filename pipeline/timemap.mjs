// Take time -> output time across tighten.mjs.
//
// tighten writes <output>.timemap.json: the segments it kept, each with where it
// starts in the output. Stages after it that place something by a moment of
// the take (cards.mjs cuts a section card in before a narration line) map that
// moment through here. No segments means tighten changed nothing.

import fs from 'node:fs';

export function readTimeMap(video) {
  const file = `${video}.timemap.json`;
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// t in seconds of the take; returns seconds of the output. A moment that falls
// in no segment (past the end) maps from the last one.
export function mapTime(map, t) {
  const segs = map?.segments ?? [];
  if (!segs.length) return t;
  const seg = segs.find((s) => t >= s.from && t < s.to) ?? (t < segs[0].from ? segs[0] : segs[segs.length - 1]);
  return seg.outStart + (t - seg.from) / seg.speed;
}
