// cards.mjs end to end: render the intro and outro, with the presenter avatar
// on and off, and join them onto a take. Needs ffmpeg; no network, no TTS
// spend (the avatar clips are the voice, and the plain cards run --no-voice).

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  hasFfmpeg, tempDir, runStage, makeClip, durationS, hasAudio, pixel, isRed, isBlue, ff,
} from './helpers.mjs';

// cards.mjs geometry and timing, restated: a change to either should be a
// deliberate one that updates this test too.
const W = 1920;
const H = 1080;
const BUBBLE = { cx: W - 64 - 230, cy: H - 64 - 230 };
const LEAD = 1.0; // max(0.6, XFADE + 0.25)
const TAIL = 1.2;
const XFADE = 0.75;

const CLIP_S = 2;
const TAKE_S = 3;

describe('cards.mjs', { skip: !hasFfmpeg && 'ffmpeg not found' }, () => {
  let dir;
  let take;
  let script;

  before(() => {
    dir = tempDir('cards');
    take = makeClip(path.join(dir, 'take.mp4'), { color: 'gray', size: `${W}x${H}`, seconds: TAKE_S });
    makeClip(path.join(dir, 'intro.mp4'), { color: 'red', size: '832x1088', seconds: CLIP_S, freq: 300 });
    makeClip(path.join(dir, 'outro.mp4'), { color: 'red', size: '640x480', seconds: CLIP_S, freq: 500 });
    script = path.join(dir, 'cards.demo');
    fs.writeFileSync(
      script,
      [
        'name: cards-test',
        'intro: Unit Tour | Every card a test can check',
        'outro: Thanks for watching | Questions? Reach out | help@example.com',
        `intro-avatar: ${path.join(dir, 'intro.mp4')}`,
        `outro-avatar: ${path.join(dir, 'outro.mp4')}`,
        '',
        'beat A',
        '  hold 1s',
        '',
      ].join('\n'),
    );
  });

  test('avatar on: the clips voice both cards from the bottom-right bubble', () => {
    const out = path.join(dir, 'on');
    const final = path.join(dir, 'on.mp4');
    // A dummy key: if anything tried to call the TTS API instead of using the
    // clips, the request would fail and so would this test.
    const r = runStage('cards.mjs', [take, '-o', final, '--script', script], {
      DEMO_OUT: out,
      DEMO_AVATAR: 'on',
      DEMO_AVATAR_VOICE: 'test-voice',
      ELEVENLABS_API_KEY: 'test-key',
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /voice : elevenlabs, test-voice/);
    assert.match(r.out, /should say: "Unit Tour\. Every card a test can check"/);
    assert.match(r.out, /should say: "Thanks for watching\. Questions\? Reach out"/, 'the contact line is not spoken');

    const intro = path.join(out, 'cards', 'intro.mp4');
    assert.ok(Math.abs(durationS(intro) - (CLIP_S + LEAD + TAIL)) < 0.1, `intro ${durationS(intro)}s`);
    assert.ok(hasAudio(intro));

    // the face sits in the bubble; the card around it is still the brand blue
    assert.ok(isRed(pixel(intro, 2, BUBBLE.cx, BUBBLE.cy)), 'bubble shows the clip');
    assert.ok(isBlue(pixel(intro, 2, 40, 40)), 'card background stays');
    assert.ok(!isRed(pixel(intro, 2, W / 2, 60)), 'the clip does not take the frame');
    // a portrait clip and a landscape one both fill the round bubble
    assert.ok(isRed(pixel(path.join(out, 'cards', 'outro.mp4'), 2, BUBBLE.cx, BUBBLE.cy)));

    const expected = 2 * (CLIP_S + LEAD + TAIL) + TAKE_S - 2 * XFADE;
    assert.ok(Math.abs(durationS(final) - expected) < 0.2, `final ${durationS(final)}s, expected ${expected}s`);
    assert.ok(hasAudio(final));
  });

  test('avatar off: plain cards, and the clips the script names are ignored', () => {
    const out = path.join(dir, 'off');
    const final = path.join(dir, 'off.mp4');
    const r = runStage('cards.mjs', [take, '-o', final, '--script', script, '--no-voice'], {
      DEMO_OUT: out,
      DEMO_AVATAR: 'off',
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /avatar: off/);
    assert.doesNotMatch(r.out, /should say/);

    const intro = path.join(out, 'cards', 'intro.mp4');
    assert.ok(!isRed(pixel(intro, 2, BUBBLE.cx, BUBBLE.cy)), 'no bubble on a plain card');
    assert.ok(Math.abs(durationS(intro) - 5) < 0.1, `plain intro holds its 5s floor, got ${durationS(intro)}s`);
    assert.ok(fs.existsSync(final));
  });

  test('avatar on with a clip missing: stops and prints the line to record', () => {
    const missing = path.join(dir, 'missing.demo');
    fs.writeFileSync(
      missing,
      `name: missing\nintro: Hello | World\nintro-avatar: ${path.join(dir, 'nope.mp4')}\n\nbeat A\n  hold 1s\n`,
    );
    const r = runStage('cards.mjs', [take, '-o', path.join(dir, 'missing.mp4'), '--script', missing], {
      DEMO_OUT: path.join(dir, 'missing'),
      DEMO_AVATAR: 'on',
      DEMO_AVATAR_VOICE: 'test-voice',
      ELEVENLABS_API_KEY: 'test-key',
    });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /intro avatar clip not found/);
    assert.match(r.out, /Generate it in ElevenCreative/);
    assert.match(r.out, /Hello\. World/);
  });

  test('a DEMO_AVATAR typo stops the stage instead of dropping the avatar', () => {
    const r = runStage('cards.mjs', [take, '-o', path.join(dir, 'typo.mp4'), '--script', script, '--no-voice'], {
      DEMO_OUT: path.join(dir, 'typo'),
      DEMO_AVATAR: 'yes',
    });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /DEMO_AVATAR must be on or off, got "yes"/);
  });
});

// Section cards go where their beat begins: a beat opens its page before it
// speaks, so a card at the line would follow the new page onto the screen.
describe('cards.mjs section placement', { skip: !hasFfmpeg && 'ffmpeg not found' }, () => {
  test('a card goes at the beat\'s page open (leadAtMs), not just before its line', () => {
    const dir = tempDir('sections');
    const take = makeClip(path.join(dir, 'take.mp4'), { color: 'gray', size: `${W}x${H}`, seconds: 8 });
    const script = path.join(dir, 'sections.demo');
    fs.writeFileSync(script, [
      'name: sections-test',
      '',
      'beat A',
      '  card "First | one"',
      '  say "Line one."',
      '',
      'beat B',
      '  card "Second | two"',
      '  say "Line two."',
      '',
    ].join('\n'));
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'raw.mp4.narration.json'), JSON.stringify([
      { atMs: 300, text: 'Line one.' },
      { atMs: 6000, leadAtMs: 3000, leadEndMs: 4200, text: 'Line two.' },
    ]));
    const r = runStage('cards.mjs', [take, '-o', path.join(dir, 'final.mp4'), '--script', script, '--no-voice'], {
      DEMO_OUT: out,
      DEMO_AVATAR: 'off',
    });
    assert.equal(r.code, 0, r.out);
    // 3.0s lead minus the 0.5s section dissolve, not 6.0 - 0.5 - 0.15; and the
    // take resumes when the open finished (4.2s), not back on the old page
    assert.match(r.out, /section 2: "Second".*, at 2\.50s, resumes at 4\.20s, before the line at 6\.00s/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a card waits for the previous line to end when the open starts during it', () => {
    const dir = tempDir('sections-overlap');
    // speech (a tone) until 4s, quiet after; the open starts at 3s, mid-line
    const take = path.join(dir, 'take.mp4');
    ff([
      '-f', 'lavfi', '-i', `color=c=gray:s=${W}x${H}:d=8`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
      '-af', "volume=enable='gte(t,4)':volume=0",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', take,
    ]);
    const script = path.join(dir, 'sections.demo');
    fs.writeFileSync(script, ['name: overlap-test', '', 'beat A', '  card "First | one"', '  say "Line one."', '',
      'beat B', '  card "Second | two"', '  say "Line two."', ''].join('\n'));
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'raw.mp4.narration.json'), JSON.stringify([
      { atMs: 300, text: 'Line one.' },
      { atMs: 6000, leadAtMs: 3000, text: 'Line two.' },
    ]));
    const r = runStage('cards.mjs', [take, '-o', path.join(dir, 'final.mp4'), '--script', script, '--no-voice'], {
      DEMO_OUT: out,
      DEMO_AVATAR: 'off',
    });
    assert.equal(r.code, 0, r.out);
    // quiet from ~4.0s + the 0.5s dissolve: the card is not at 2.5s, inside the line
    const at = Number(/section 2: "Second".*, at ([\d.]+)s/.exec(r.out)?.[1]);
    assert.ok(at >= 4.4 && at <= 4.7, `card at ${at}s, expected about 4.5s`);
    assert.doesNotMatch(r.out, /section card "Second \| two": only/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
