// Shared by the integration tests: run a stage as its CLI, make synthetic
// media with ffmpeg, and read results back out of a video.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PIPELINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ROOT = path.join(PIPELINE, '..');
export const FFMPEG = process.env.FFMPEG || 'ffmpeg';
export const FFPROBE =
  process.env.FFPROBE ||
  (process.env.FFMPEG
    ? path.join(path.dirname(process.env.FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : 'ffprobe');

export const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    execFileSync(FFPROBE, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

export const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `pv-${prefix}-`));

// Every variable a stage reads to pick a voice or an avatar, cleared, so a
// developer's own shell cannot change a result. .env only fills variables that
// are unset, so setting them here (even to '') also wins over .env.
const ISOLATE = {
  DEMO_AVATAR: '',
  DEMO_AVATAR_VOICE: '',
  DEMO_TTS: '',
  DEMO_TTS_VOICE: '',
  ELEVENLABS_API_KEY: '',
  OPENAI_API_KEY: '',
  HIGHLIGHT: '0',
};

// Runs `node <stage> ...args` from pipeline/, as a user would.
export function runStage(stage, args, env = {}) {
  const r = spawnSync(process.execPath, [stage, ...args], {
    cwd: PIPELINE,
    env: { ...process.env, ...ISOLATE, ...env },
    encoding: 'utf8',
    timeout: 240000,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export function ff(args) {
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

// A solid-colour clip with a tone on it: a stand-in for a talking-head clip
// or a composed take.
export function makeClip(file, { color, size, seconds, freq = 440 }) {
  ff([
    '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=25:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=f=${freq}:d=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    file,
  ]);
  return file;
}

export function durationS(file) {
  return Number(
    execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
      .toString()
      .trim(),
  );
}

export function hasAudio(file) {
  return execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file])
    .toString()
    .trim().length > 0;
}

// The colour of one pixel at time `atS`, as [r, g, b].
export function pixel(file, atS, x, y) {
  const buf = execFileSync(FFMPEG, [
    '-loglevel', 'error', '-ss', String(atS), '-i', file,
    // to RGB before the crop: a 1x1 crop of 4:2:0 video has no whole chroma sample
    '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  return [...buf.subarray(0, 3)];
}

export const isRed = ([r, g, b]) => r > 180 && g < 80 && b < 80;
export const isBlue = ([r, g, b]) => b > 150 && b > r + 60;
