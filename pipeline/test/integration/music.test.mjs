// music.mjs end to end on generated media: a bed under a "voice" (tone bursts
// with silence between), a music file instead of a style, and the refusals.
// Needs ffmpeg; no network.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { hasFfmpeg, tempDir, runStage, ff, durationS, hasAudio, FFMPEG, FFPROBE } from './helpers.mjs';

const SECONDS = 12;
// the "voice": a tone from 2-5s and 8-10s, silence elsewhere
const SPEECH = [[2, 5], [8, 10]];

// RMS level (dB) of the audio between a and b seconds
function rmsDb(file, a, b) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-ss', String(a), '-t', String(b - a), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume: (-?[\d.]+) dB/.exec(r.stderr ?? '');
  return m ? Number(m[1]) : -Infinity;
}

function lufs(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number([...(r.stderr ?? '').matchAll(/^\s+I:\s+(-?[\d.]+) LUFS/gm)].pop()[1]);
}

const videoCodec = (file) =>
  execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', file]).toString().trim();

describe('music.mjs', { skip: !hasFfmpeg && 'ffmpeg not found' }, () => {
  let dir;
  let video;

  before(() => {
    dir = tempDir('music');
    video = path.join(dir, 'voice.mp4');
    const silent = SPEECH.map(([a, b]) => `between(t,${a},${b})`).join('+');
    ff([
      '-f', 'lavfi', '-i', `color=c=gray:s=640x360:r=25:d=${SECONDS}`,
      '-f', 'lavfi', '-i', `sine=f=220:d=${SECONDS}`,
      '-af', `volume=0:enable='not(${silent})'`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video,
    ]);
  });

  test('a style: the bed fills the pauses, ducks under the voice, and leaves the video alone', () => {
    const out = path.join(dir, 'styled.mp4');
    const r = runStage('music.mjs', ['--video', video, '-o', out, '--spec', '{"style":"calm","seed":2}']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /music: style calm, volume 0\.5, 2 speech span\(s\)/);
    assert.equal(videoCodec(out), videoCodec(video));
    assert.ok(Math.abs(durationS(out) - durationS(video)) < 0.1);
    assert.ok(hasAudio(out));
    // a pause (late enough to be past the piece's sparse opening section is not
    // needed: any music at all is far above the source's digital silence)
    assert.ok(rmsDb(video, 5.6, 7.6) < -80, 'the fixture pause is silent');
    assert.ok(rmsDb(out, 5.6, 7.6) > -70, 'music is audible in the pause');
    // under the voice the mix stays close to the voice alone
    assert.ok(Math.abs(rmsDb(out, 2.5, 4.5) - rmsDb(video, 2.5, 4.5)) < 1.5, 'the voice is not buried');
    assert.ok(Math.abs(lufs(out) - lufs(video)) < 1.5, 'integrated loudness barely moves');
  });

  test('the same spec gives the same mix', () => {
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    for (const f of [a, b]) assert.equal(runStage('music.mjs', ['--video', video, '-o', f, '--spec', '{"style":"tech"}']).code, 0);
    const bed = (f) => fs.readFileSync(path.join(dir, 'music', `${path.basename(f, '.mp4')}.bed.wav`));
    assert.ok(bed(a).equals(bed(b)));
  });

  test('a music file loops under the video and is credited in the log', () => {
    const track = path.join(dir, 'track.wav');
    ff(['-f', 'lavfi', '-i', 'sine=f=660:d=3', '-ac', '2', track]);
    const out = path.join(dir, 'file.mp4');
    const r = runStage('music.mjs', ['--video', video, '-o', out, '--spec', JSON.stringify({ src: track, credit: 'Test tone, CC0' })]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /music: file .*track\.wav/);
    assert.match(r.out, /credit "Test tone, CC0"/);
    // the 3s file is still playing in the last pause, so it looped
    assert.ok(rmsDb(out, 10.4, 11.2) > -70, 'the file loops into the last pause');
  });

  test('the output may be the input: it is replaced in place', () => {
    const copy = path.join(dir, 'inplace.mp4');
    fs.copyFileSync(video, copy);
    assert.equal(runStage('music.mjs', ['--video', copy, '--spec', '{"style":"warm"}']).code, 0);
    assert.ok(rmsDb(copy, 5.6, 7.6) > -70);
    assert.ok(!fs.existsSync(`${copy}.tmp.mp4`));
  });

  test('refuses an unknown style, a missing file, and a bad volume', () => {
    const out = path.join(dir, 'bad.mp4');
    let r = runStage('music.mjs', ['--video', video, '-o', out, '--spec', '{"style":"disco"}']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /unknown style "disco"/);
    r = runStage('music.mjs', ['--video', video, '-o', out, '--spec', '{"src":"brand/music/none.mp3"}']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /no file brand\/music\/none\.mp3/);
    r = runStage('music.mjs', ['--video', video, '-o', out, '--spec', '{"volume":3}']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /volume/);
    assert.ok(!fs.existsSync(out));
  });

  test('--styles lists every style with its description', () => {
    const r = runStage('music.mjs', ['--styles']);
    assert.equal(r.code, 0);
    for (const s of ['warm', 'upbeat', 'calm', 'tech', 'playful']) assert.match(r.out, new RegExp(`^${s}\\s+\\S`, 'm'));
  });
});
