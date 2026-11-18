// Where the stages read and write a take's files.
//
// Default out/. DEMO_OUT points one build at its own folder, which is what lets
// join.mjs record and render several takes without one take's stage files
// overwriting another's (every stage writes fixed names: raw.mp4, final.mp4...).
// The TTS clip cache is NOT per-folder: it stays in out/tts so a line is never
// billed twice (see tts.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_OUT = path.join(HERE, '..', 'out');
export const OUT = process.env.DEMO_OUT ? path.resolve(process.env.DEMO_OUT) : DEFAULT_OUT;

// The take's zoom project, named after the take: driver.mjs writes the script's
// file name into actions.json, so scripts/acme-tour.demo -> acme-tour.recordly.
// A take recorded before the name was written falls back to demo.recordly.
export function projectPath() {
  let name = 'demo';
  try {
    name = JSON.parse(fs.readFileSync(path.join(OUT, 'actions.json'), 'utf8')).name || name;
  } catch {}
  return path.join(OUT, `${name}.recordly`);
}

// The pixel space the take's element boxes and cursor samples are measured in:
// the size of the captured frames. The driver logs the viewport it asked for,
// but the screencast can come out a few pixels different (a take on 2026-11-17
// captured 1456x799 for a 1440x810 viewport), and normalising by the logged
// size then drew every red frame and the cursor off target, more so toward the
// bottom right. Falls back to the logged viewport when the frame size is
// unknown. `differs` says whether the two disagree, for a warning.
export function captureSpace(viewport, frame) {
  const ok = (s) => s && Number.isFinite(s.width) && Number.isFinite(s.height) && s.width > 0 && s.height > 0;
  if (!ok(frame)) return { width: viewport.width, height: viewport.height, differs: false };
  const differs = !ok(viewport) || frame.width !== viewport.width || frame.height !== viewport.height;
  return { width: frame.width, height: frame.height, differs };
}
