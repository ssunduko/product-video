// Publish a finished video: upload it to each configured destination (a Google
// Drive folder with the Drive API, a YouTube channel with the YouTube Data API),
// under the user's own Google account, and record the publication in the
// video's state (memory/features/<app>/<name>.state.json), which goes to Zep.
// Posting the links on the Jira ticket is Claude's job (the Atlassian MCP tool);
// this prints the ticket and the comment for it.
//
//   node publish.mjs auth                 one-time: sign in with Google (Drive), store the refresh token in .env
//   node publish.mjs auth youtube         one-time: sign in as the YouTube channel, store its refresh token in .env
//   node publish.mjs check <name>         what would be published (with the full YouTube metadata), and whether it may be
//   node publish.mjs upload <name> --approved [--replace-youtube]
//                                         upload to every destination: Drive gets a new revision
//                                         of the same file when it was published before (the link
//                                         stays the same); YouTube gets the video with its title,
//                                         description (intro copy, chapters, contact line), tags,
//                                         language, category, recording date, AI disclosure and
//                                         the intro title card as its thumbnail. YouTube cannot
//                                         replace a video, so a video already on the channel is
//                                         skipped unless --replace-youtube (a new video; the old one stays)
//   node publish.mjs thumbnail <name> --approved
//                                         set (again) the title card as the thumbnail of the video on YouTube
//   node publish.mjs subtitles <name>     write out/<name>.srt: timed English subtitles from the narration and cards
//   node publish.mjs jira <name> --ticket <KEY> --comment <id>
//                                         record that the link was posted on the ticket
//
// Final approval: upload refuses unless the video's state is "done" (through the
// quality gate and the visual review), "accepted" (the user took it with open
// findings: memory.mjs video accept) or already "published", and --approved is
// given. --approved means the user said to publish this video; never add it on
// your own.
//
// Destinations: generic. memory/destinations.json names each kind and the .env
// variable that holds it: PUBLISH_DEST (a Drive folder URL) and
// PUBLISH_YOUTUBE_CHANNEL (a channel: @handle, its URL, or a UC... channel id).
// Either may be left unset. No app is named in a variable. PUBLISH_YOUTUBE_THUMBNAIL
// is a path template (<name> = the video name) to a designed thumbnail.
// Google: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (a Desktop-app OAuth
// client from Google Cloud), GOOGLE_OAUTH_REFRESH_TOKEN (Drive, written by `auth`)
// and YOUTUBE_OAUTH_REFRESH_TOKEN (the channel, written by `auth youtube`). Before
// every YouTube call the channel the token signs in as is checked against
// PUBLISH_YOUTUBE_CHANNEL, so a video never lands on the wrong channel.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTarget } from './target.mjs';
import { ROOT, videoHome, recordVideo } from './memory.mjs';
import { parseScript, sectionCards } from './script.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT, '.env');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const SCOPES = {
  drive: { scope: 'https://www.googleapis.com/auth/drive', env: 'GOOGLE_OAUTH_REFRESH_TOKEN', who: 'the Google account that owns the destination folder' },
  youtube: {
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    env: 'YOUTUBE_OAUTH_REFRESH_TOKEN',
    who: 'the Google account that manages the YouTube channel, and pick that channel (a brand account) when Google asks',
  },
};
const CHUNK = 8 * 1024 * 1024; // resumable upload chunk (a multiple of 256 KiB)
const THUMB_MAX = 2 * 1024 * 1024; // YouTube's thumbnail size limit

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) loadTarget(undefined); // .env

function fail(msg) {
  console.error(`publish: ${msg}`);
  process.exit(1);
}

// a path as the user reads it: repo-relative inside the repo, absolute outside it
const show = (f) => (path.relative(ROOT, f).startsWith('..') ? f : path.relative(ROOT, f));

const readJson = (f, dflt) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return dflt;
  }
};

// ---------------------------------------------------------------- what to publish

// the configured destinations: each kind whose .env variable is set, with the
// folder or channel its `match` finds in the value (id null when it does not match)
export function readDestinations(env, conf) {
  const out = [];
  for (const [kind, def] of Object.entries(conf?.destinations ?? {})) {
    const value = String(env[def.env] ?? '').trim();
    if (!value) continue;
    const m = new RegExp(def.match).exec(value);
    out.push({ kind, env: def.env, url: value, id: m ? m[1].replace(/^channel\//, '') : null });
  }
  return out;
}

// m:ss (h:mm:ss past an hour), as YouTube reads chapter timestamps
export function timestamp(s) {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// chapters from the section cards: 0:00 for the intro, then each section at its
// start. YouTube shows chapters only with three or more, each 10s or longer, so
// anything shorter returns none rather than a list YouTube ignores.
export function chapters(sections, durationS) {
  const list = [{ at: 0, label: 'Intro' }, ...sections.map((x) => ({ at: x.start, label: x.headline }))];
  if (list.length < 3) return [];
  const ends = [...list.slice(1).map((c) => c.at), durationS ?? Infinity];
  if (list.some((c, i) => ends[i] - c.at < 10)) return [];
  return list.map((c) => `${timestamp(c.at)} ${c.label}`);
}

// "Headline | Sub | contact" card copy
const cardParts = (text) => String(text ?? '').split('|').map((s) => s.trim()).filter(Boolean);

// The YouTube metadata of a video. The manifest's "youtube" block wins field by
// field; otherwise it is built from what the video already says:
//   title        the manifest title
//   description  the intro card's subhead (else the manifest description), the
//                chapters from the section cards, and the outro card's contact line
//   tags         the section headlines
//   thumbnail    the designed image (PUBLISH_YOUTUBE_THUMBNAIL), else the intro title card
// ctx: { env, intro, outro, sections: [{headline, start}], durationS, avatar, recordedAt, thumbnail }
export function youtubeMeta(manifest, name, ctx = {}) {
  const env = ctx.env ?? process.env;
  const y = manifest.youtube ?? {};
  const privacy = y.privacy ?? (env.PUBLISH_YOUTUBE_PRIVACY || 'public');
  if (!['public', 'unlisted', 'private'].includes(privacy)) throw new Error(`youtube privacy "${privacy}" is not public, unlisted or private`);
  const sections = ctx.sections ?? [];
  let description = y.description;
  if (description == null) {
    const [, introSub] = cardParts(ctx.intro);
    const [, outroSub, ...contact] = cardParts(ctx.outro);
    const lead = introSub ?? manifest.description ?? '';
    const ch = chapters(sections, ctx.durationS);
    const close = outroSub ? (contact.length ? `${outroSub.replace(/[.:]$/, '')}: ${contact.join(' | ')}` : outroSub) : '';
    description = [lead, ch.length ? ch.join('\n') : '', close].filter(Boolean).join('\n\n');
  }
  // YouTube limits: 500 characters of tags in all, no angle brackets anywhere
  const tags = [];
  for (const t of (y.tags ?? sections.map((x) => x.headline)).map((x) => String(x).replace(/[<>]/g, '').trim()).filter(Boolean)) {
    if (!tags.includes(t) && [...tags, t].join(',').length <= 500) tags.push(t);
  }
  const language = y.language ?? (env.PUBLISH_YOUTUBE_LANGUAGE || 'en');
  return {
    title: String(y.title ?? manifest.title ?? name).replace(/[<>]/g, '').slice(0, 100),
    description: String(description).replace(/[<>]/g, '').slice(0, 5000),
    tags,
    categoryId: String(y.categoryId ?? '28'), // Science & Technology
    language,
    privacy,
    // an AI presenter (avatar card) is realistic synthetic media: YouTube asks for the disclosure
    syntheticMedia: y.syntheticMedia ?? !!ctx.avatar,
    recordingDate: ctx.recordedAt ?? null,
    thumbnail: y.thumbnail ? path.resolve(ROOT, y.thumbnail) : ctx.thumbnail ?? null,
  };
}

// a thumbnail path template with <name> filled in (relative paths from the repo root)
export function thumbnailPath(template, name) {
  const t = String(template ?? '').trim();
  return t ? path.resolve(ROOT, t.replaceAll('<name>', name)) : null;
}

// what the built video says about itself: its first part's intro and outro card
// copy, the section cards of every part placed on the joined timeline, the
// intro title card image and when it was built
function videoContext(name, manifest, file) {
  const build = readJson(path.join(path.dirname(file), name, 'build.json'), null);
  const parts = build?.parts ?? [];
  const sections = [];
  for (const part of parts) {
    const s = readJson(path.join(path.dirname(part.file), 'cards', 'sections.json'), null);
    for (const x of s?.spans ?? []) sections.push({ headline: x.headline, start: (part.startS ?? 0) + x.start });
  }
  let intro = null;
  let outro = null;
  let avatar = false;
  for (const [i, part] of (manifest.parts ?? []).entries()) {
    const f = part.script && path.resolve(ROOT, part.script);
    if (!f || !fs.existsSync(f)) continue;
    const { meta } = parseScript(fs.readFileSync(f, 'utf8'), { file: f });
    if (i === 0) intro = meta.intro;
    if (meta.outro) outro = meta.outro;
    if (meta.introAvatar || meta.outroAvatar) avatar = true;
  }
  // the thumbnail: the designed one from PUBLISH_YOUTUBE_THUMBNAIL (a path with
  // <name> for the video name) when it exists, else the intro title card
  const first = parts[0]?.file;
  const designed = thumbnailPath(process.env.PUBLISH_YOUTUBE_THUMBNAIL, name);
  const card = first ? path.join(path.dirname(first), 'cards', 'intro.png') : null;
  const thumbnail = designed && fs.existsSync(designed) ? designed : card;
  return {
    intro,
    outro,
    avatar,
    sections,
    durationS: parts.length ? parts[parts.length - 1].endS : undefined,
    recordedAt: build?.builtAt ?? null,
    thumbnail: thumbnail && fs.existsSync(thumbnail) ? thumbnail : null,
  };
}

// the first video stream of a file: size, frame rate, codec, pixel format, bit rate
function probeVideo(file) {
  const r = spawnSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name,pix_fmt,r_frame_rate,bit_rate', '-of', 'json', file], { encoding: 'utf8' });
  const s = r.status === 0 ? JSON.parse(r.stdout).streams?.[0] : null;
  if (!s) return null;
  const [n, d] = String(s.r_frame_rate ?? '0/1').split('/').map(Number);
  return { width: s.width, height: s.height, codec: s.codec_name, pixFmt: s.pix_fmt, fps: d ? n / d : 0, bitrate: Number(s.bit_rate) || null };
}

// Every published video is Full HD: at least 1920x1080 (YouTube marks it HD
// from the file itself; the API has no setting), H.264 in yuv420p so YouTube
// and Drive play it without a lossy detour. A low bit rate is only a warning:
// screen recordings compress well.
export function hdCheck(v) {
  const problems = [];
  const warnings = [];
  if (!v) return { problems: ['ffprobe could not read the video (is ffprobe on PATH?)'], warnings };
  if (v.width < 1920 || v.height < 1080) problems.push(`the video is ${v.width}x${v.height}, not HD: every published video is at least 1920x1080 (rebuild it at 1920x1080)`);
  if (v.codec !== 'h264') problems.push(`the video is ${v.codec}, not H.264`);
  if (v.pixFmt && v.pixFmt !== 'yuv420p') problems.push(`the video's pixel format is ${v.pixFmt}, not yuv420p`);
  if (v.bitrate && v.bitrate < 0.4e6) warnings.push(`the video bit rate is ${(v.bitrate / 1e6).toFixed(2)} Mbps: HD by size, but check it still looks sharp`);
  return { problems, warnings };
}

function plan(name) {
  const home = videoHome(name) ?? fail(`no video page names videos/${name}.json`);
  const manifest = readJson(path.join(ROOT, 'videos', `${name}.json`), null) ?? fail(`no videos/${name}.json`);
  const state = readJson(home.state, null);
  const file = path.resolve(ROOT, manifest.output ?? `out/${name}.mp4`);
  const confFile = path.join(ROOT, 'memory', 'destinations.json');
  const conf = readJson(confFile, null) ?? fail(`${path.relative(ROOT, confFile)} is missing or not valid JSON`);
  const dests = readDestinations(process.env, conf);
  const drive = dests.find((d) => d.kind === 'google-drive-folder') ?? null;
  const youtube = dests.find((d) => d.kind === 'youtube-channel') ?? null;
  const problems = [];
  const warnings = [];
  if (!state) problems.push('the video has no state yet (build it first)');
  else if (!['done', 'accepted', 'published'].includes(state.status)) problems.push(`the video is "${state.status}", not "done": it needs the quality gate and the visual review first, or the user's acceptance (memory.mjs video accept)`);
  let video = null;
  if (!fs.existsSync(file)) problems.push(`${path.relative(ROOT, file)} does not exist`);
  else {
    video = probeVideo(file);
    const hd = hdCheck(video);
    problems.push(...hd.problems);
    warnings.push(...hd.warnings);
  }
  const names =Object.values(conf.destinations ?? {}).map((d) => d.env).join(' or ');
  if (!dests.length) problems.push(`no destination: set ${names} in .env`);
  for (const d of dests.filter((x) => !x.id)) problems.push(`${d.env} is not a ${d.kind} (see memory/destinations.json)`);
  const need = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'];
  if (drive) need.push('GOOGLE_OAUTH_REFRESH_TOKEN');
  if (youtube) need.push('YOUTUBE_OAUTH_REFRESH_TOKEN');
  for (const k of need) {
    if (!process.env[k]) problems.push(`${k} is not set in .env${k === 'GOOGLE_OAUTH_REFRESH_TOKEN' ? ' (run: node publish.mjs auth)' : k === 'YOUTUBE_OAUTH_REFRESH_TOKEN' ? ' (run: node publish.mjs auth youtube)' : ''}`);
  }
  let yt = null;
  if (youtube) {
    try {
      yt = youtubeMeta(manifest, name, videoContext(name, manifest, file));
      const designed = thumbnailPath(process.env.PUBLISH_YOUTUBE_THUMBNAIL, name);
      if (designed && !fs.existsSync(designed) && !manifest.youtube?.thumbnail) warnings.push(`no designed thumbnail at ${designed}: using the intro title card`);
      if (!yt.thumbnail) warnings.push('no thumbnail (PUBLISH_YOUTUBE_THUMBNAIL or cards/intro.png of the first part): YouTube picks a frame');
      else if (!fs.existsSync(yt.thumbnail)) problems.push(`the thumbnail ${path.relative(ROOT, yt.thumbnail)} does not exist`);
    } catch (e) {
      problems.push(e.message);
    }
  }
  return { name, home, manifest, state, file, video, drive, youtube, yt, ticket: manifest.ticket ?? null, problems, warnings };
}

async function check(name) {
  const p = plan(name);
  const size = fs.existsSync(p.file) ? `${(fs.statSync(p.file).size / 1048576).toFixed(1)} MB` : 'missing';
  console.log(`${name}: ${p.state?.status ?? 'no state'}`);
  console.log(`  file:        ${path.relative(ROOT, p.file)} (${size}${p.video ? `, ${p.video.width}x${p.video.height} ${Math.round(p.video.fps)} fps ${p.video.codec}${p.video.bitrate ? ` ${(p.video.bitrate / 1e6).toFixed(2)} Mbps` : ''}` : ''})`);
  if (p.drive) console.log(`  drive:       ${p.drive.env} folder ${p.drive.id}${p.state?.published?.fileId ? ` (published: ${p.state.published.url}; an upload adds a new revision)` : ''}`);
  if (p.youtube) {
    console.log(`  youtube:     ${p.youtube.env} ${p.youtube.id}`);
    if (p.state?.youtube) console.log(`               already on the channel: ${p.state.youtube.url} (skipped on upload unless --replace-youtube)`);
    if (process.env.YOUTUBE_OAUTH_REFRESH_TOKEN && process.env.GOOGLE_OAUTH_CLIENT_ID) {
      const r = await youtubeChannelCheck(p.youtube, false);
      console.log(`               signed in as ${r.found}${r.ok ? '' : ` - NOT ${p.youtube.id}`}`);
      if (!r.ok) p.problems.push(`the YouTube token signs in as ${r.found}, not ${p.youtube.id} (run: node publish.mjs auth youtube, and pick that channel)`);
    }
    if (p.yt) {
      const y = p.yt;
      console.log(`    title:     ${y.title}`);
      console.log(`    privacy:   ${y.privacy}   category ${y.categoryId}   language ${y.language}   made for kids: no   AI disclosure: ${y.syntheticMedia ? 'yes' : 'no'}`);
      console.log(`    recorded:  ${y.recordingDate ?? 'unknown'}`);
      console.log(`    tags:      ${y.tags.join(', ') || 'none'}`);
      console.log(`    thumbnail: ${y.thumbnail ? show(y.thumbnail) : 'none'}`);
      console.log(`    description:\n${y.description.split('\n').map((l) => `      ${l}`).join('\n')}`);
    }
  }
  console.log(`  ticket:      ${p.ticket ?? 'none (add "ticket" to the manifest)'}`);
  for (const w of p.warnings) console.log(`  note: ${w}`);
  if (p.problems.length) {
    console.log('  cannot publish yet:');
    for (const x of p.problems) console.log(`  - ${x}`);
    process.exitCode = 1;
  } else console.log('  ready: publish only once the user has said to (upload --approved)');
}

// ---------------------------------------------------------------- Google auth

async function accessToken(which = 'drive') {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env[SCOPES[which].env],
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!r.ok) fail(`Google token refresh failed: ${j.error_description ?? j.error ?? r.status} (run: node publish.mjs auth${which === 'drive' ? '' : ` ${which}`})`);
  return j.access_token;
}

// put KEY=value in .env, replacing the line (or the commented one) if it is there
function setEnv(key, value) {
  let s = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const re = new RegExp(`^#?\\s?${key}=.*$`, 'm');
  s = re.test(s) ? s.replace(re, `${key}=${value}`) : `${s.trimEnd()}\n${key}=${value}\n`;
  fs.writeFileSync(ENV_FILE, s);
}

// one-time loopback sign-in: the browser asks for consent, Google redirects to
// 127.0.0.1 with a code, and the refresh token goes into .env (never printed)
async function auth(which = 'drive') {
  if (!SCOPES[which]) fail(`auth knows drive and youtube, not ${which}`);
  const { scope, env, who } = SCOPES[which];
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!id || !secret) fail('set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env first (Google Cloud > APIs & Services > Credentials > OAuth client ID, type Desktop app; enable the Google Drive API and the YouTube Data API v3)');
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: id, redirect_uri: redirect, response_type: 'code', scope,
    access_type: 'offline', prompt: which === 'youtube' ? 'select_account consent' : 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  })}`;
  console.log(`Sign in with ${who}:\n\n  ${url}\n`);
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')], { detached: true, stdio: 'ignore' }).unref();
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no sign-in within 5 minutes')), 300000);
    server.on('request', (req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      if (!q.get('code') && !q.get('error')) return res.end();
      res.end(q.get('code') ? 'Signed in. You can close this tab and return to the terminal.' : `Sign-in failed: ${q.get('error')}`);
      clearTimeout(timer);
      if (q.get('state') !== state) return reject(new Error('state mismatch'));
      q.get('code') ? resolve(q.get('code')) : reject(new Error(q.get('error')));
    });
  }).finally(() => server.close());
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' }),
  });
  const j = await r.json();
  if (!r.ok || !j.refresh_token) fail(`token exchange failed: ${j.error_description ?? j.error ?? 'no refresh token returned'}`);
  setEnv(env, j.refresh_token);
  process.env[env] = j.refresh_token;
  console.log(`Signed in. ${env} is stored in .env (gitignored).`);
  if (which === 'youtube') {
    const c = await youtubeChannelCheck(null, false);
    console.log(`The token uploads to the channel ${c.found}.`);
  }
}

// ---------------------------------------------------------------- upload

// send a file to a resumable upload session in CHUNK pieces; resolves to the final JSON
async function sendResumable(session, file, size, label) {
  const fd = fs.openSync(file, 'r');
  let sent = 0;
  let done = null;
  try {
    while (sent < size) {
      const len = Math.min(CHUNK, size - sent);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, sent);
      const r = await fetch(session, { method: 'PUT', headers: { 'content-range': `bytes ${sent}-${sent + len - 1}/${size}` }, body: buf });
      if (r.status === 308) {
        const range = r.headers.get('range');
        sent = range ? Number(range.split('-')[1]) + 1 : sent + len;
      } else if (r.ok) {
        done = await r.json();
        sent = size;
      } else throw new Error(`${label} upload failed at ${sent} of ${size} bytes: ${r.status} ${await r.text()}`);
      process.stdout.write(`\r  ${label}: uploaded ${(sent / 1048576).toFixed(1)} / ${(size / 1048576).toFixed(1)} MB`);
    }
  } finally {
    fs.closeSync(fd);
    process.stdout.write('\n');
  }
  return done;
}

async function uploadDrive(p, size) {
  const token = await accessToken('drive');
  const prior = p.state.published?.fileId ?? null;
  const title = `${p.manifest.title ?? p.name}.mp4`;
  const meta = prior ? {} : { name: title, parents: [p.drive.id], description: p.manifest.description ?? '' };
  // start a resumable session: a new file, or a new revision of the one already published
  const start = await fetch(
    prior
      ? `https://www.googleapis.com/upload/drive/v3/files/${prior}?uploadType=resumable&supportsAllDrives=true`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',
    {
      method: prior ? 'PATCH' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(size) },
      body: JSON.stringify(meta),
    },
  );
  if (!start.ok) throw new Error(`Drive refused the upload: ${start.status} ${await start.text()}`);
  const done = await sendResumable(start.headers.get('location'), p.file, size, 'drive');
  return { url: `https://drive.google.com/file/d/${done.id}/view`, fileId: done.id, title, revision: prior ? 'new revision of the published file' : 'first upload' };
}

// does a channel (from channels.list mine=true) match the configured one?
// a @handle is compared with the channel's customUrl, a UC... id with its id
export function channelMatches(want, ch) {
  if (!ch || !want) return false;
  return want.startsWith('@') ? (ch.snippet?.customUrl ?? '').toLowerCase() === want.toLowerCase() : ch.id === want.replace(/^channel\//, '');
}

// which channel the YouTube token signs in as, and whether it is the configured one
async function youtubeChannelCheck(dest, strict = true) {
  const token = await accessToken('youtube');
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!r.ok) fail(`YouTube channel lookup failed: ${j.error?.message ?? r.status}`);
  const ch = j.items?.[0];
  const found = ch ? `${ch.snippet?.customUrl ?? ch.id} (${ch.snippet?.title ?? ''})` : 'no channel';
  const ok = channelMatches(dest?.id, ch);
  if (strict && !ok) throw new Error(`the YouTube token signs in as ${found}, not ${dest?.id}: nothing sent to YouTube (run: node publish.mjs auth youtube, and pick that channel)`);
  return { ok, found, token };
}

// the thumbnail as YouTube takes it: the PNG when it is under 2 MB, else a JPEG of it
export function thumbnailFile(src) {
  if (fs.statSync(src).size <= THUMB_MAX) return { file: src, type: 'image/png' };
  const out = path.join(ROOT, 'out', `${path.basename(src, path.extname(src))}-youtube-thumbnail.jpg`);
  for (const q of [2, 4, 8]) {
    const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', src, '-vf', 'scale=1280:-2', '-q:v', String(q), out]);
    if (r.status === 0 && fs.statSync(out).size <= THUMB_MAX) return { file: out, type: 'image/jpeg' };
  }
  throw new Error(`the thumbnail ${path.relative(ROOT, src)} could not be brought under 2 MB`);
}

// set the title card as the video's thumbnail; YouTube allows custom thumbnails
// only on a verified channel, so a refusal is reported, not fatal
async function setThumbnail(token, videoId, src) {
  const { file, type } = thumbnailFile(src);
  const r = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': type },
    body: fs.readFileSync(file),
  });
  if (r.ok) return { ok: true, file: show(src) };
  const j = await r.json().catch(() => ({}));
  return { ok: false, error: `${r.status} ${j.error?.message ?? ''}`.trim() };
}

async function uploadYoutube(p, size) {
  const { token, found } = await youtubeChannelCheck(p.youtube, true);
  const y = p.yt;
  const body = {
    snippet: { title: y.title, description: y.description, tags: y.tags, categoryId: y.categoryId, defaultLanguage: y.language, defaultAudioLanguage: y.language },
    status: {
      privacyStatus: y.privacy,
      selfDeclaredMadeForKids: false,
      embeddable: true,
      publicStatsViewable: true,
      license: 'youtube',
      containsSyntheticMedia: y.syntheticMedia,
    },
    ...(y.recordingDate ? { recordingDetails: { recordingDate: y.recordingDate } } : {}),
  };
  const parts = ['snippet', 'status', ...(y.recordingDate ? ['recordingDetails'] : [])].join(',');
  const start = await fetch(`https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=${parts}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(size) },
    body: JSON.stringify(body),
  });
  if (!start.ok) throw new Error(`YouTube refused the upload: ${start.status} ${await start.text()}`);
  const done = await sendResumable(start.headers.get('location'), p.file, size, 'youtube');
  const privacy = done.status?.privacyStatus ?? y.privacy;
  if (privacy !== y.privacy) {
    console.log(`  note: YouTube set the video to "${privacy}", not "${y.privacy}". Uploads from an unaudited Google Cloud project are locked to private until the project passes the YouTube API audit; change it in YouTube Studio.`);
  }
  let thumbnail = null;
  if (y.thumbnail) {
    const t = await setThumbnail(token, done.id, y.thumbnail);
    thumbnail = t.ok ? t.file : null;
    console.log(t.ok ? `  youtube: thumbnail set from ${t.file}` : `  youtube: thumbnail not set (${t.error}). Custom thumbnails need a verified channel (youtube.com/verify); then run: node publish.mjs thumbnail ${p.name} --approved`);
  }
  return { url: `https://www.youtube.com/watch?v=${done.id}`, videoId: done.id, channel: found, title: y.title, privacy, thumbnail, tags: y.tags };
}

async function upload(name, o) {
  const p = plan(name);
  if (p.problems.length) fail(`cannot publish ${name}:\n- ${p.problems.join('\n- ')}`);
  if (!o.approved) fail(`publishing needs the user's final approval: rerun with --approved once they have said to publish ${name}`);
  for (const w of p.warnings) console.log(`  note: ${w}`);
  const size = fs.statSync(p.file).size;
  const links = [];
  const errors = [];
  let drive = null;
  if (p.drive) {
    try {
      drive = await uploadDrive(p, size);
      links.push(drive.url);
    } catch (e) {
      errors.push(e.message);
    }
  }
  let youtube = null;
  if (p.youtube) {
    if (p.state.youtube && !o['replace-youtube']) {
      console.log(`  youtube: already on the channel at ${p.state.youtube.url}; skipped (--replace-youtube uploads a new video)`);
      links.push(p.state.youtube.url);
    } else {
      try {
        youtube = await uploadYoutube(p, size);
        links.push(youtube.url);
        if (p.state.youtube) console.log(`  the earlier YouTube video ${p.state.youtube.url} is still on the channel: unlist or delete it in YouTube Studio`);
      } catch (e) {
        errors.push(e.message);
      }
    }
  }
  if (youtube) recordVideo(name, { type: 'youtube', ...youtube, destination: `${p.youtube.env} (youtube-channel)` });
  const ytUrl = youtube?.url ?? p.state.youtube?.url;
  if (drive || youtube) {
    const first = drive ?? youtube;
    recordVideo(name, {
      type: 'publish',
      url: first.url,
      fileId: drive?.fileId ?? p.state.published?.fileId,
      destination: [drive && `${p.drive.env} (google-drive-folder)`, ytUrl && `${p.youtube?.env ?? 'PUBLISH_YOUTUBE_CHANNEL'} (youtube-channel)`].filter(Boolean).join(' + '),
      title: first.title,
      bytes: size,
      revision: drive?.revision ?? 'youtube only',
      youtube: ytUrl,
      ticket: p.ticket,
    });
    spawnSync(process.execPath, ['memory.mjs', 'video', 'sync', name], { cwd: HERE, stdio: 'inherit', timeout: 120000 });
  }
  const v = readJson(p.home.state, {});
  console.log(`\npublished ${name}: ${links.join('  ') || 'nothing'}  (status: ${v.status})`);
  if (errors.length) {
    console.error(`\nnot every destination was published:\n- ${errors.join('\n- ')}\nfix it and rerun upload --approved (Drive gets another revision; a video already on YouTube is skipped)`);
    process.exitCode = 1;
  }
  if (p.ticket && links.length) {
    console.log(`\nNext: post the link(s) on ${p.ticket} (Claude, Atlassian MCP), then record it:`);
    console.log(`  node publish.mjs jira ${name} --ticket ${p.ticket} --comment <comment id>`);
    console.log(`Suggested comment:\n  The ${p.manifest.title ?? name} video is published: ${links.join(' and ')}`);
  }
}

// set the thumbnail on the video already on YouTube (after verifying the channel)
async function thumbnail(name, o) {
  const p = plan(name);
  if (!p.youtube || !p.yt) fail(`no YouTube channel configured (PUBLISH_YOUTUBE_CHANNEL)${p.problems.length ? `:\n- ${p.problems.join('\n- ')}` : ''}`);
  if (!p.state?.youtube) fail(`${name} is not on YouTube yet: upload it first`);
  if (!p.yt.thumbnail) fail(`${name} has no title card image to use`);
  if (!o.approved) fail(`changing the published video needs the user's approval: rerun with --approved once they have said to`);
  const { token } = await youtubeChannelCheck(p.youtube, true).catch((e) => fail(e.message));
  const t = await setThumbnail(token, p.state.youtube.videoId, p.yt.thumbnail);
  if (!t.ok) fail(`thumbnail not set: ${t.error}`);
  recordVideo(name, { type: 'youtube', ...p.state.youtube, at: undefined, thumbnail: t.file });
  console.log(`${name}: thumbnail set from ${t.file} on ${p.state.youtube.url}`);
}

// ---------------------------------------------------------------- subtitles

// HH:MM:SS,mmm
export function srtTime(s) {
  const ms = Math.max(0, Math.round(s * 1000));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

// a spoken line in readable pieces: sentences, then clauses, at most `max`
// characters each (two subtitle lines), timed in proportion to their length
// a sentence too long for one subtitle in n even parts, each break at the word
// gap nearest its share of the length, a gap after a comma winning within 15 chars
function splitEven(sentence, max) {
  const words = sentence.split(/\s+/).filter(Boolean);
  const n = Math.ceil(sentence.length / max);
  if (n <= 1) return [sentence];
  const gaps = [];
  let len = 0;
  for (let i = 0; i < words.length - 1; i++) {
    len += words[i].length + (i ? 1 : 0);
    gaps.push({ i, at: len, comma: /[,;:]$/.test(words[i]) });
  }
  const cuts = [];
  for (let k = 1; k < n; k++) {
    const target = (sentence.length * k) / n;
    const score = (g) => Math.abs(g.at - target) - (g.comma ? 15 : 0);
    const best = gaps.filter((g) => !cuts.includes(g.i) && (!cuts.length || g.i > cuts.at(-1))).sort((a, b) => score(a) - score(b))[0];
    if (best) cuts.push(best.i);
  }
  const out = [];
  let from = 0;
  for (const c of [...cuts, words.length - 1]) {
    out.push(words.slice(from, c + 1).join(' '));
    from = c + 1;
  }
  return out.filter(Boolean);
}

export function chunkLine(text, start, end, max = 84) {
  const sentences = String(text).trim().match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const pieces = [];
  for (const s of sentences.flatMap((x) => splitEven(x, max))) {
    // short neighbours share a subtitle
    if (pieces.length && `${pieces.at(-1)} ${s}`.length <= max && (pieces.at(-1).length < max / 2 || s.length < max / 2)) pieces[pieces.length - 1] = `${pieces.at(-1)} ${s}`;
    else pieces.push(s);
  }
  const total = pieces.reduce((a, x) => a + x.length, 0) || 1;
  let t = start;
  return pieces.map((x) => {
    const d = ((end - start) * x.length) / total;
    const c = { start: t, end: t + d, text: x };
    t += d;
    return c;
  });
}

// Subtitles for a built video, on its final timeline. Each utterance (the intro
// card's voice, every narration line, every section card's headline, the outro
// card's voice) has a predicted start from the edit: a narration line is its
// cue mapped through tighten's time map, plus the offset of the body piece it
// is in. The first piece follows the intro card (its length less the
// dissolve); each later piece's offset comes from where speech resumes after
// its section card, which is the line that card introduces. The predicted
// start is then snapped to the nearest speech onset in the final audio, and an
// utterance ends where the speech before the next one stops.
// ctx: { cues: [{atMs, text}], timemap, sections: [{headline, start, end, line}],
//        introS, introText, outroS, outroText, totalS, xfade, lead, speech: [[start, end]] }
export function buildSubtitles(ctx) {
  const { cues, timemap, sections = [], speech = [] } = ctx;
  const onsets = speech.map((s) => s[0]);
  const nearest = (t, within = 1.5) => {
    let best = null;
    for (const o of onsets) if (Math.abs(o - t) <= within && (best == null || Math.abs(o - t) < Math.abs(best - t))) best = o;
    return best ?? t;
  };
  const map = (ms) => {
    const t = ms / 1000;
    const segs = timemap?.segments ?? [];
    if (!segs.length) return t;
    const s = segs.find((x) => t >= x.from && t < x.to) ?? (t < segs[0].from ? segs[0] : segs[segs.length - 1]);
    return s.outStart + (t - s.from) / s.speed;
  };
  const utter = [];
  if (ctx.introText) utter.push({ at: nearest(ctx.lead ?? 1, 2), text: ctx.introText, snapped: true });
  // which cue each section card introduces, and the offset of the body after it
  const cardAt = new Map();
  let from = 0;
  for (const sec of sections) {
    const idx = cues.findIndex((c, i) => i >= from && c.text === sec.line);
    if (idx < 0) continue;
    from = idx + 1;
    const resumed = onsets.find((o) => o >= sec.end - 0.1);
    cardAt.set(idx, { sec, offset: resumed != null ? resumed - map(cues[idx].atMs) : null });
  }
  let offset = (ctx.introS ?? 0) - (ctx.introS ? ctx.xfade ?? 0 : 0);
  for (const [i, c] of cues.entries()) {
    const card = cardAt.get(i);
    if (card) {
      utter.push({ at: nearest(card.sec.start + (ctx.lead ?? 1), 1), text: card.sec.headline });
      if (card.offset != null) offset = card.offset;
    }
    utter.push({ at: nearest(map(c.atMs) + offset), text: c.text });
  }
  if (ctx.outroText && ctx.outroS) utter.push({ at: nearest(ctx.totalS - ctx.outroS + (ctx.lead ?? 1), 2), text: ctx.outroText });
  utter.sort((a, b) => a.at - b.at);
  const out = [];
  for (const [i, u] of utter.entries()) {
    const nextAt = utter[i + 1]?.at ?? ctx.totalS ?? u.at + 5;
    // the end of the last stretch of speech that starts before the next utterance
    const last = speech.filter((s) => s[0] >= u.at - 0.05 && s[0] < nextAt - 0.05).pop();
    const end = Math.min(last ? last[1] : nextAt, nextAt - 0.05);
    out.push(...chunkLine(u.text, u.at, Math.max(end, u.at + 1)));
  }
  return out;
}

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

// stretches of speech in a file's audio (between silences of 0.35s or more)
function speechSpans(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'silencedetect=n=-40dB:d=0.35', '-f', 'null', '-'], { encoding: 'utf8' });
  const quiet = [];
  let qs = null;
  for (const line of (r.stderr ?? '').split('\n')) {
    const a = /silence_start: (-?[\d.]+)/.exec(line);
    if (a) qs = Math.max(0, Number(a[1]));
    const b = /silence_end: ([\d.]+)/.exec(line);
    if (b) {
      quiet.push([qs ?? 0, Number(b[1])]);
      qs = null;
    }
  }
  const total = Number(/Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr ?? '')?.slice(1).reduce((a, x, i) => a + Number(x) * [3600, 60, 1][i], 0)) || 0;
  if (qs != null) quiet.push([qs, total]);
  const spans = [];
  let t = 0;
  for (const [a, b] of quiet) {
    if (a > t + 0.05) spans.push([t, a]);
    t = b;
  }
  if (total > t + 0.05) spans.push([t, total]);
  return { spans, total };
}

const durationOf = (f) => Number(spawnSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout) || 0;

// "Headline | Sub | contact" as the card voice says it (cards.mjs: headline. sub)
const spokenCard = (text) => {
  const [h, s] = cardParts(text);
  return s ? `${h}. ${s}` : h ?? '';
};

// write out/<name>.srt for a built video (one or more parts)
function subtitles(name) {
  const manifest = readJson(path.join(ROOT, 'videos', `${name}.json`), null) ?? fail(`no videos/${name}.json`);
  const file = path.resolve(ROOT, manifest.output ?? `out/${name}.mp4`);
  const build = readJson(path.join(path.dirname(file), name, 'build.json'), null) ?? fail(`no build record for ${name}: build it first`);
  const { spans: speech, total } = speechSpans(file);
  const all = [];
  for (const [i, part] of build.parts.entries()) {
    const dir = path.dirname(part.file);
    const cuesFile = [path.join(dir, 'cut.mp4.narration.json'), path.join(dir, 'raw.mp4.narration.json')].find((f) => fs.existsSync(f)) ?? fail(`part ${part.part}: no narration cues`);
    const tight = fs.readdirSync(dir).find((f) => f.endsWith('-tight.mp4.timemap.json'));
    const mp = manifest.parts?.[i];
    const { meta } = mp?.script ? parseScript(fs.readFileSync(path.resolve(ROOT, mp.script), 'utf8')) : { meta: {} };
    const cards = path.join(dir, 'cards');
    const introS = fs.existsSync(path.join(cards, 'intro.mp4')) ? durationOf(path.join(cards, 'intro.mp4')) : 0;
    const outroS = fs.existsSync(path.join(cards, 'outro.mp4')) ? durationOf(path.join(cards, 'outro.mp4')) : 0;
    // the narration line each section card introduces (script.mjs sectionCards)
    const lines = mp?.script ? sectionCards(parseScript(fs.readFileSync(path.resolve(ROOT, mp.script), 'utf8')).steps).map((c) => c.line) : [];
    const sec = readJson(path.join(cards, 'sections.json'), { spans: [] }).spans;
    const base = part.startS ?? 0;
    const local = speech.filter(([a]) => a >= base && a < part.endS).map(([a, b]) => [a - base, b - base]);
    const cues = readJson(cuesFile, []);
    const sections = sec.map((x, k) => ({ ...x, line: lines[k] }));
    const subs = buildSubtitles({
      cues,
      timemap: tight ? readJson(path.join(dir, tight), null) : null,
      sections,
      introS,
      introText: introS ? spokenCard(meta.intro) : null,
      outroS,
      outroText: outroS ? spokenCard(meta.outro) : null,
      totalS: part.endS - base,
      xfade: Number(process.env.CARD_XFADE ?? 0.75),
      lead: Math.max(0.6, Number(process.env.CARD_XFADE ?? 0.75) + 0.25),
      speech: local,
    });
    all.push(...subs.map((c) => ({ ...c, start: c.start + base, end: c.end + base })));
  }
  const out = path.join(path.dirname(file), `${name}.srt`);
  fs.writeFileSync(out, toSrt(all));
  console.log(`${name}: ${all.length} subtitles, ${srtTime(all[0]?.start ?? 0)} to ${srtTime(all.at(-1)?.end ?? total)} -> ${path.relative(ROOT, out)}`);
}

function jira(name, o) {
  if (!o.ticket || !o.comment) fail('jira needs --ticket <KEY> and --comment <id>');
  const { v } = recordVideo(name, { type: 'jira', ticket: o.ticket, comment: String(o.comment) });
  spawnSync(process.execPath, ['memory.mjs', 'video', 'sync', name], { cwd: HERE, stdio: 'inherit', timeout: 120000 });
  console.log(`${name}: link posted on ${o.ticket} (comment ${o.comment}); status ${v.status}`);
}

// ---------------------------------------------------------------- CLI

if (isMain) {
  const [cmd, name, ...rest] = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) o[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
  if (cmd === 'auth') await auth(name ?? 'drive');
  else if (cmd === 'check' && name) await check(name);
  else if (cmd === 'upload' && name) await upload(name, o);
  else if (cmd === 'thumbnail' && name) await thumbnail(name, o);
  else if (cmd === 'subtitles' && name) subtitles(name);
  else if (cmd === 'jira' && name) jira(name, o);
  else fail('usage: node publish.mjs auth [youtube] | check <name> | upload <name> --approved [--replace-youtube] | thumbnail <name> --approved | subtitles <name> | jira <name> --ticket <KEY> --comment <id>');
}
