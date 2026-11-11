// publish.mjs: which destinations .env names (PUBLISH_DEST, PUBLISH_YOUTUBE_CHANNEL),
// the YouTube metadata built from the manifest and the video's cards, the
// thumbnail template, and the channel check that keeps uploads off the wrong channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDestinations, youtubeMeta, channelMatches, chapters, timestamp, thumbnailPath } from '../../publish.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory/destinations.json'), 'utf8'));

test('destinations come from generic variables, each with its kind', () => {
  const d = readDestinations({ PUBLISH_DEST: 'https://drive.google.com/drive/u/0/folders/abc_123', PUBLISH_YOUTUBE_CHANNEL: 'https://www.youtube.com/@Acme.Videos/videos' }, conf);
  assert.deepEqual(d.map((x) => [x.kind, x.env, x.id]), [['google-drive-folder', 'PUBLISH_DEST', 'abc_123'], ['youtube-channel', 'PUBLISH_YOUTUBE_CHANNEL', '@Acme.Videos']]);
  assert.equal(readDestinations({ PUBLISH_YOUTUBE_CHANNEL: '@acme' }, conf)[0].id, '@acme');
  assert.equal(readDestinations({ PUBLISH_YOUTUBE_CHANNEL: 'https://www.youtube.com/channel/UCabc-DEF_1' }, conf)[0].id, 'UCabc-DEF_1');
  assert.deepEqual(readDestinations({}, conf), []);
  assert.equal(readDestinations({ PUBLISH_DEST: 'https://example.com/videos' }, conf)[0].id, null);
  assert.ok(Object.values(conf.destinations).every((x) => !/_[A-Z]+_?<APP>|<APP>/.test(x.env)), 'no app in a variable name');
});

test('timestamps and chapters: 0:00 first, three or more, each 10s or longer', () => {
  assert.equal(timestamp(31.58), '0:31');
  assert.equal(timestamp(3725), '1:02:05');
  const s = [{ headline: 'Callbacks', start: 31.5 }, { headline: 'Stop', start: 71.2 }];
  assert.deepEqual(chapters(s, 120), ['0:00 Intro', '0:31 Callbacks', '1:11 Stop']);
  assert.deepEqual(chapters([{ headline: 'Only', start: 20 }], 60), []);
  assert.deepEqual(chapters([{ headline: 'A', start: 20 }, { headline: 'B', start: 25 }], 60), []);
  assert.deepEqual(chapters([{ headline: 'A', start: 20 }, { headline: 'B', start: 55 }], 60), []);
});

test('youtube metadata is built from the cards when the manifest sets none', () => {
  const m = { title: 'Acme Monthly Update', description: 'internal note' };
  const ctx = {
    env: {},
    intro: 'Acme Monthly Update | Three new ways to <win> deals',
    outro: 'Thanks for watching | Do you have any questions? Reach out anytime | help@example.com',
    sections: [{ headline: 'Callbacks', start: 31.5 }, { headline: 'Stop', start: 71.2 }, { headline: 'Callbacks', start: 90 }],
    durationS: 120,
    avatar: true,
    recordedAt: '2026-11-09T01:43:08.582Z',
    thumbnail: '/x/intro.png',
  };
  const y = youtubeMeta(m, 'acme', ctx);
  assert.equal(y.title, 'Acme Monthly Update');
  assert.equal(y.description, 'Three new ways to win deals\n\n0:00 Intro\n0:31 Callbacks\n1:11 Stop\n1:30 Callbacks\n\nDo you have any questions? Reach out anytime: help@example.com');
  assert.deepEqual(y.tags, ['Callbacks', 'Stop']);
  assert.equal(y.privacy, 'public');
  assert.equal(y.language, 'en');
  assert.equal(y.categoryId, '28');
  assert.equal(y.syntheticMedia, true);
  assert.equal(y.recordingDate, '2026-11-09T01:43:08.582Z');
  assert.equal(y.thumbnail, '/x/intro.png');
  // without cards: the manifest description, no chapters, no disclosure
  const bare = youtubeMeta(m, 'acme', { env: { PUBLISH_YOUTUBE_PRIVACY: 'unlisted', PUBLISH_YOUTUBE_LANGUAGE: 'de' } });
  assert.deepEqual([bare.description, bare.privacy, bare.language, bare.syntheticMedia, bare.thumbnail], ['internal note', 'unlisted', 'de', false, null]);
});

test('the manifest youtube block wins field by field', () => {
  const y = youtubeMeta({ title: 'T', youtube: { title: 'x'.repeat(150), description: 'Own copy', tags: ['demo'], privacy: 'private', language: 'fr', syntheticMedia: false } }, 'acme', { env: { PUBLISH_YOUTUBE_PRIVACY: 'unlisted' }, avatar: true, intro: 'A | B' });
  assert.deepEqual([y.title.length, y.description, y.tags, y.privacy, y.language, y.syntheticMedia], [100, 'Own copy', ['demo'], 'private', 'fr', false]);
  assert.equal(youtubeMeta({}, 'acme', { env: {} }).title, 'acme');
  assert.throws(() => youtubeMeta({ youtube: { privacy: 'secret' } }, 'acme', { env: {} }), /not public, unlisted or private/);
});

test('the thumbnail template fills in the video name', () => {
  assert.equal(thumbnailPath('/designs/<name>/social/youtube.png', 'acme-tour'), path.resolve('/designs/acme-tour/social/youtube.png'));
  assert.equal(thumbnailPath('', 'acme-tour'), null);
  assert.equal(thumbnailPath(undefined, 'acme-tour'), null);
});

test('the channel check: handle by customUrl (any case), id by channel id, nothing else', () => {
  const ch = { id: 'UCabc', snippet: { customUrl: '@acmevideos' } };
  assert.equal(channelMatches('@AcmeVideos', ch), true);
  assert.equal(channelMatches('UCabc', ch), true);
  assert.equal(channelMatches('channel/UCabc', ch), true);
  assert.equal(channelMatches('@OtherChannel', ch), false);
  assert.equal(channelMatches('UCxyz', ch), false);
  assert.equal(channelMatches('@AcmeVideos', undefined), false);
  assert.equal(channelMatches(undefined, ch), false);
});

test('HD gate: 1920x1080 or larger, H.264 yuv420p; a low bit rate only warns', async () => {
  const { hdCheck } = await import('../../publish.mjs');
  const ok = { width: 1920, height: 1080, codec: 'h264', pixFmt: 'yuv420p', fps: 60, bitrate: 583405 };
  assert.deepEqual(hdCheck(ok), { problems: [], warnings: [] });
  assert.equal(hdCheck({ ...ok, width: 3840, height: 2160 }).problems.length, 0);
  assert.match(hdCheck({ ...ok, width: 1280, height: 720 }).problems[0], /not HD/);
  assert.match(hdCheck({ ...ok, codec: 'hevc' }).problems[0], /not H.264/);
  assert.match(hdCheck({ ...ok, pixFmt: 'yuv444p' }).problems[0], /yuv420p/);
  assert.equal(hdCheck({ ...ok, bitrate: 200000 }).warnings.length, 1);
  assert.match(hdCheck(null).problems[0], /ffprobe/);
});

test('subtitles: SRT times, balanced chunks, lines snapped to speech after each card', async () => {
  const { srtTime, chunkLine, buildSubtitles, toSrt } = await import('../../publish.mjs');
  assert.equal(srtTime(3725.0456), '01:02:05,046');
  const long = chunkLine('Your team gets an internal note right away, and every request lands on the Calls tab.', 10, 20);
  assert.deepEqual(long.map((c) => c.text), ['Your team gets an internal note right away,', 'and every request lands on the Calls tab.']);
  assert.equal(long[0].start, 10);
  assert.ok(Math.abs(long.at(-1).end - 20) < 1e-9);
  assert.deepEqual(chunkLine('Short one. Two.', 0, 2).map((c) => c.text), ['Short one. Two.']);
  // intro card 10s (0.75s dissolve), one section card at 30-33s introducing cue 2
  const subs = buildSubtitles({
    cues: [{ atMs: 2000, text: 'Welcome.' }, { atMs: 15000, text: 'First, callbacks.' }],
    timemap: { segments: [{ from: 0, to: 100, speed: 1, outStart: 0 }] },
    sections: [{ headline: 'Callbacks', start: 30, end: 33, line: 'First, callbacks.' }],
    introS: 10, introText: 'Acme Update. Big news', xfade: 0.75, lead: 1, totalS: 60,
    speech: [[1.02, 4.5], [11.3, 13], [31.05, 32], [34.2, 36.1]],
  });
  assert.deepEqual(subs.map((c) => [c.text, +c.start.toFixed(2), +c.end.toFixed(2)]), [
    ['Acme Update. Big news', 1.02, 4.5],
    ['Welcome.', 11.3, 13],
    ['Callbacks', 31.05, 32.05], // shown at least 1s
    ['First, callbacks.', 34.2, 36.1],
  ]);
  assert.match(toSrt(subs), /^1\n00:00:01,020 --> 00:00:04,500\nAcme Update\. Big news\n/);
});
