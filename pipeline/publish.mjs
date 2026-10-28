// Publish a finished video: upload it to the app's destination (a Google Drive
// folder) with the Drive API, under the user's own Google account, and record
// the publication in the video's state (memory/features/<app>/<name>.state.json),
// which goes to Zep. Posting the link on the Jira ticket is Claude's job (the
// Atlassian MCP tool); this prints the ticket and the comment for it.
//
//   node publish.mjs auth                 one-time: sign in with Google, store the refresh token in .env
//   node publish.mjs check <name>         what would be published, and whether it may be
//   node publish.mjs upload <name> --approved
//                                         upload (a new revision of the same file when it was
//                                         published before, so the link stays the same)
//   node publish.mjs jira <name> --ticket <KEY> --comment <id>
//                                         record that the link was posted on the ticket
//
// Final approval: upload refuses unless the video's state is "done" (through the
// quality gate and the visual review), "accepted" (the user took it with open
// findings: memory.mjs video accept) or already "published", and --approved is
// given. --approved means the user said to publish this video; never add it on
// your own.
//
// Destination: generic. memory/destinations.json names the kinds; each app's
// destination comes from .env as PUBLISH_DEST_<APP> (e.g. a Drive folder URL).
// Google: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (a Desktop-app OAuth
// client from Google Cloud) and GOOGLE_OAUTH_REFRESH_TOKEN (written by `auth`).

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTarget } from './target.mjs';
import { ROOT, videoHome, recordVideo } from './memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT, '.env');
const SCOPE = 'https://www.googleapis.com/auth/drive';
const CHUNK = 8 * 1024 * 1024; // resumable upload chunk (a multiple of 256 KiB)

loadTarget(undefined); // .env

function fail(msg) {
  console.error(`publish: ${msg}`);
  process.exit(1);
}

const readJson = (f, dflt) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return dflt;
  }
};

// ---------------------------------------------------------------- what to publish

function plan(name) {
  const home = videoHome(name) ?? fail(`no video page names videos/${name}.json`);
  const manifest = readJson(path.join(ROOT, 'videos', `${name}.json`), null) ?? fail(`no videos/${name}.json`);
  const state = readJson(home.state, null);
  const file = path.resolve(ROOT, manifest.output ?? `out/${name}.mp4`);
  const confFile = path.join(ROOT, 'memory', 'destinations.json');
  const conf = readJson(confFile, null) ?? fail(`${path.relative(ROOT, confFile)} is missing or not valid JSON`);
  const envVar = conf.env.replace('<APP>', home.app.toUpperCase().replace(/[^A-Z0-9]/g, '_'));
  const dest = process.env[envVar] || null;
  let kind = null;
  let folderId = null;
  for (const [k, def] of Object.entries(conf.kinds ?? {})) {
    const m = dest && new RegExp(def.match).exec(dest);
    if (m) {
      kind = k;
      folderId = m[1];
    }
  }
  const problems = [];
  if (!state) problems.push('the video has no state yet (build it first)');
  else if (!['done', 'accepted', 'published'].includes(state.status)) problems.push(`the video is "${state.status}", not "done": it needs the quality gate and the visual review first, or the user's acceptance (memory.mjs video accept)`);
  if (!fs.existsSync(file)) problems.push(`${path.relative(ROOT, file)} does not exist`);
  if (!dest) problems.push(`no destination: set ${envVar} in .env`);
  else if (kind !== 'google-drive-folder') problems.push(`${envVar} is not a destination kind memory/destinations.json knows`);
  for (const k of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REFRESH_TOKEN']) {
    if (!process.env[k]) problems.push(`${k} is not set in .env${k.endsWith('REFRESH_TOKEN') ? ' (run: node publish.mjs auth)' : ''}`);
  }
  return { name, home, manifest, state, file, envVar, kind, folderId, ticket: manifest.ticket ?? null, problems };
}

function check(name) {
  const p = plan(name);
  const size = fs.existsSync(p.file) ? `${(fs.statSync(p.file).size / 1048576).toFixed(1)} MB` : 'missing';
  console.log(`${name}: ${p.state?.status ?? 'no state'}`);
  console.log(`  file:        ${path.relative(ROOT, p.file)} (${size})`);
  console.log(`  destination: ${p.envVar} -> ${p.kind ?? 'not set'}${p.folderId ? ` ${p.folderId}` : ''}`);
  console.log(`  ticket:      ${p.ticket ?? 'none (add "ticket" to the manifest)'}`);
  if (p.state?.published) console.log(`  published:   ${p.state.published.at} ${p.state.published.url} (an upload adds a new revision)`);
  if (p.problems.length) {
    console.log('  cannot publish yet:');
    for (const x of p.problems) console.log(`  - ${x}`);
    process.exitCode = 1;
  } else console.log('  ready: publish only once the user has said to (upload --approved)');
}

// ---------------------------------------------------------------- Google auth

async function accessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!r.ok) fail(`Google token refresh failed: ${j.error_description ?? j.error ?? r.status} (run: node publish.mjs auth)`);
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
async function auth() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!id || !secret) fail('set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env first (Google Cloud > APIs & Services > Credentials > OAuth client ID, type Desktop app; enable the Google Drive API)');
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: id, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  })}`;
  console.log(`Sign in with the Google account that owns the destination folder:\n\n  ${url}\n`);
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
  setEnv('GOOGLE_OAUTH_REFRESH_TOKEN', j.refresh_token);
  console.log('Signed in. GOOGLE_OAUTH_REFRESH_TOKEN is stored in .env (gitignored).');
}

// ---------------------------------------------------------------- upload

async function upload(name, o) {
  const p = plan(name);
  if (p.problems.length) fail(`cannot publish ${name}:\n- ${p.problems.join('\n- ')}`);
  if (!o.approved) fail(`publishing needs the user's final approval: rerun with --approved once they have said to publish ${name}`);
  const token = await accessToken();
  const size = fs.statSync(p.file).size;
  const prior = p.state.published?.fileId ?? null;
  const title = `${p.manifest.title ?? name}.mp4`;
  const meta = prior ? {} : { name: title, parents: [p.folderId], description: p.manifest.description ?? '' };
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
  if (!start.ok) fail(`Drive refused the upload: ${start.status} ${await start.text()}`);
  const session = start.headers.get('location');
  const fd = fs.openSync(p.file, 'r');
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
      } else fail(`upload failed at ${sent} of ${size} bytes: ${r.status} ${await r.text()}`);
      process.stdout.write(`\r  uploaded ${(sent / 1048576).toFixed(1)} / ${(size / 1048576).toFixed(1)} MB`);
    }
  } finally {
    fs.closeSync(fd);
  }
  process.stdout.write('\n');
  const fileId = done.id;
  const url = `https://drive.google.com/file/d/${fileId}/view`;
  const { v } = recordVideo(name, {
    type: 'publish',
    url,
    fileId,
    destination: `${p.envVar} (${p.kind})`,
    title,
    bytes: size,
    revision: prior ? 'new revision of the published file' : 'first upload',
    ticket: p.ticket,
  });
  spawnSync(process.execPath, ['memory.mjs', 'video', 'sync', name], { cwd: HERE, stdio: 'inherit', timeout: 120000 });
  console.log(`\npublished ${name}: ${url}  (status: ${v.status})`);
  if (p.ticket) {
    console.log(`\nNext: post the link on ${p.ticket} (Claude, Atlassian MCP), then record it:`);
    console.log(`  node publish.mjs jira ${name} --ticket ${p.ticket} --comment <comment id>`);
    console.log(`Suggested comment:\n  The ${p.manifest.title ?? name} video is published: ${url}`);
  }
}

function jira(name, o) {
  if (!o.ticket || !o.comment) fail('jira needs --ticket <KEY> and --comment <id>');
  const { v } = recordVideo(name, { type: 'jira', ticket: o.ticket, comment: String(o.comment) });
  spawnSync(process.execPath, ['memory.mjs', 'video', 'sync', name], { cwd: HERE, stdio: 'inherit', timeout: 120000 });
  console.log(`${name}: link posted on ${o.ticket} (comment ${o.comment}); status ${v.status}`);
}

// ---------------------------------------------------------------- CLI

const [cmd, name, ...rest] = process.argv.slice(2);
const o = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) o[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
}
if (cmd === 'auth') await auth();
else if (cmd === 'check' && name) check(name);
else if (cmd === 'upload' && name) await upload(name, o);
else if (cmd === 'jira' && name) jira(name, o);
else fail('usage: node publish.mjs auth | check <name> | upload <name> --approved | jira <name> --ticket <KEY> --comment <id>');
