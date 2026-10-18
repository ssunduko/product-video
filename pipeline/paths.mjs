// Where the stages read and write a take's files.
//
// Default out/. DEMO_OUT points one build at its own folder, which is what lets
// join.mjs record and render several takes without one take's stage files
// overwriting another's (every stage writes fixed names: raw.mp4, final.mp4...).
// The TTS clip cache is NOT per-folder: it stays in out/tts so a line is never
// billed twice (see tts.mjs).

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_OUT = path.join(HERE, '..', 'out');
export const OUT = process.env.DEMO_OUT ? path.resolve(process.env.DEMO_OUT) : DEFAULT_OUT;
