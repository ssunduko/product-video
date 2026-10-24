// Project memory: each app's feature catalog, its online source, and Zep.
//
// An app is a folder memory/features/<app>/. Its feature catalog,
// data/features.json, is the initial feature set (one document per feature);
// the other .md pages there are written by video work, one per filmed feature.
// memory/sources.json is generic: it names no app or location. Each app's
// online source comes from .env as FEATURE_SOURCE_<APP>, and its kind (a Google
// Drive folder, ...) is recognised from that value.
//
// Only Claude can read those sources (they are MCP tools, not APIs this
// process can call), so the memory agent (.claude/agents/memory.md) lists the
// source, hands the listing to `diff`, reads what changed, and merges the
// features it found with `upsert`. This file keeps the bookkeeping and Zep:
//
//   node memory.mjs status [--json]            apps, catalog size, source, last sync, Zep configured?
//   node memory.mjs hook                       SessionStart hook: tell Claude to run the memory agent
//   node memory.mjs source <app>               the app's source: kind, id, and the tools to list/read it
//   node memory.mjs diff <app> <listing.json>  remote listing vs the app's data/sources.lock.json
//                                              (listing: [{id, title, modifiedTime}], as the tool returned it)
//   node memory.mjs baseline <app> <listing.json>   record files the catalog already covers (modified
//                                              on or before its `generated` date) without reading them
//   node memory.mjs upsert <app> <features.json> --source <title>
//                                              merge [{feature, category, subcategory, description, is_new}]
//                                              into the catalog; prints the ids it touched
//   node memory.mjs mark <app> <fileId> --title <t> --modified <iso> --kind feature|index|skip [--features <ids>]
//   node memory.mjs synced <app>               stamp the app's last full sync
//   node memory.mjs zep push [files...]        catalogs, video pages, rules, pipeline notes, traces, manifests
//                                              -> Zep (no files: everything; unchanged ones are skipped)
//   node memory.mjs session video <name> [--session <id>]   a new video: a new Zep session (thread) from here on
//   node memory.mjs session end [--session <id>] [--transcript <jsonl>]
//                                              SessionEnd hook: push the conversation and a summary per thread
//   node memory.mjs video state <name> [--json]  a video's status, last build, review, history
//   node memory.mjs video review <name> PASS|FAIL [--findings <file|->] [--note <t>]
//                                              record the visual review (video-qa)
//   node memory.mjs video sync <name>          the state to Zep (build.mjs runs it after every build)
//   node memory.mjs zep session [--session <id>] --title <t> --file <md|->
//                                              notes -> the Claude session's Zep thread (or a new one)
//   node memory.mjs zep search <query> [--app <app>]       facts from Zep
//
// Zep: Zep Cloud via @getzep/zep-cloud, key in ZEP_API_KEY (.env). One graph per
// app (productvideo-<app>) holds its catalog (one Zep document per feature), its
// video pages, and the traces and manifests a page of it names; the graph
// productvideo-project holds the rules and pipeline notes. A changed document
// replaces its old episodes.
//
// Sessions are attributed: every Claude session belongs to a user (MEMORY_USER,
// else git's user.email), one Zep user per person. The SessionStart hook opens the
// session's thread under that user; the SessionEnd hook pushes what was typed and
// answered (tool output left out, emails and phone numbers masked) and a summary.
// A new video starts a new thread (`session video <name>`), so each video is a
// session of its own.
//
// MEMORY_MAX_AGE_H (default 24): a source synced longer ago than this is stale,
// which the hook and build.mjs report.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadTarget } from './target.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');
const MEMORY = path.join(ROOT, 'memory');
const FEATURES = path.join(MEMORY, 'features');
const SOURCES = path.join(MEMORY, 'sources.json');
const ZEP_STATE = path.join(MEMORY, '.zep-state.json'); // per machine, gitignored
const EPISODE_CHARS = 9000; // Zep caps an episode's data at 10k characters
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const maxAgeH = () => Number(process.env.MEMORY_MAX_AGE_H || 24);

const readJson = (f, dflt) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return dflt;
  }
};
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');

const config = () => readJson(SOURCES, { env: 'FEATURE_SOURCE_<APP>', features: 'memory/features/<app>/data/features.json', indexOnly: [], kinds: {} });
// what was synced from an app's source: next to its catalog, so a private app's record stays private too
const lockPath = (app) => path.join(path.dirname(appInfo(app).featuresPath), 'sources.lock.json');
const lockOf = (app) => readJson(lockPath(app), { lastSyncAt: null, files: {} });
const saveLock = (app, v) => writeJson(lockPath(app), v);

export function apps() {
  return fs.existsSync(FEATURES) ? fs.readdirSync(FEATURES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
}

// everything known about one app: where its catalog is, and its source from .env
export function appInfo(app) {
  const c = config();
  const envVar = c.env.replace('<APP>', app.toUpperCase().replace(/[^A-Z0-9]/g, '_'));
  const location = process.env[envVar] || null;
  const featuresPath = path.join(ROOT, c.features.replace('<app>', app));
  let kind = null;
  let remoteId = null;
  for (const [k, def] of Object.entries(c.kinds ?? {})) {
    const m = location && new RegExp(def.match).exec(location);
    if (m) {
      kind = k;
      remoteId = m[1] ?? location;
    }
  }
  return { app, envVar, location, kind, remoteId, tools: kind ? c.kinds[kind] : null, featuresPath, catalog: readJson(featuresPath, null) };
}

// apps with a source whose last sync is older than MEMORY_MAX_AGE_H (or never)
export function staleSources(now = Date.now()) {
  loadTarget(undefined); // .env, for FEATURE_SOURCE_* when imported by build.mjs
  return apps()
    .map(appInfo)
    .filter((a) => a.location)
    .map(({ app }) => {
      const at = lockOf(app).lastSyncAt;
      return { app, lastSyncAt: at ?? null, ageH: at ? (now - Date.parse(at)) / 3.6e6 : Infinity };
    })
    .filter((s) => s.ageH > maxAgeH());
}

const ageText = (h) => (h === Infinity ? 'never synced' : `synced ${h < 1 ? 'under an hour' : `${Math.round(h)}h`} ago`);

// ---------------------------------------------------------------- source bookkeeping

function needSource(app) {
  const a = appInfo(app);
  if (!fs.existsSync(path.join(FEATURES, app))) fail(`unknown app "${app}" (no memory/features/${app}/)`);
  if (!a.location) fail(`no source for ${app}: set ${a.envVar} in .env`);
  if (!a.kind) fail(`${a.envVar} is not a kind memory/sources.json knows (${Object.keys(config().kinds).join(', ')})`);
  return a;
}

function source(app) {
  const a = needSource(app);
  console.log(JSON.stringify({ app, envVar: a.envVar, kind: a.kind, id: a.remoteId, list: a.tools.list.replace('<id>', a.remoteId), read: a.tools.read, catalogGenerated: a.catalog?.generated ?? null }, null, 2));
}

function readListing(file) {
  let listing = readJson(file, null);
  if (!listing) fail(`cannot read ${file}`);
  if (!Array.isArray(listing)) listing = listing.files ?? [];
  return listing;
}

const indexOnly = (title) => (config().indexOnly ?? []).some((p) => new RegExp(p, 'i').test(title));

// on or before the catalog's generated date: the catalog already covers it
function inBaseline(a, f) {
  const gen = a.catalog?.generated;
  return Boolean(gen) && Date.parse(f.modifiedTime) < Date.parse(gen) + 864e5;
}

function diff(app, file) {
  const a = needSource(app);
  const listing = readListing(file);
  const known = lockOf(app).files;
  const out = { app, new: [], changed: [], removed: [], baseline: [], unchanged: 0 };
  const seen = new Set();
  for (const f of listing) {
    seen.add(f.id);
    const k = known[f.id];
    const entry = { id: f.id, title: f.title, modifiedTime: f.modifiedTime, kind: k?.kind && k.kind !== 'baseline' ? k.kind : indexOnly(f.title) ? 'index' : 'feature' };
    if (!k && inBaseline(a, f)) out.baseline.push({ id: f.id, title: f.title });
    else if (!k) out.new.push(entry);
    else if (k.modifiedTime !== f.modifiedTime) out.changed.push({ ...entry, features: k.features ?? [] });
    else out.unchanged++;
  }
  for (const [id, k] of Object.entries(known)) if (!seen.has(id)) out.removed.push({ id, title: k.title, features: k.features ?? [] });
  console.log(JSON.stringify(out, null, 2));
}

function record(app, id, entry) {
  const l = lockOf(app);
  l.files[id] = { ...entry, syncedAt: new Date().toISOString() };
  l.files = Object.fromEntries(Object.entries(l.files).sort(([, x], [, y]) => x.title.localeCompare(y.title)));
  saveLock(app, l);
}

function baseline(app, file) {
  const a = needSource(app);
  const known = lockOf(app).files;
  let n = 0;
  for (const f of readListing(file)) {
    if (known[f.id] || !inBaseline(a, f)) continue;
    record(app, f.id, { title: f.title, modifiedTime: f.modifiedTime, kind: 'baseline', features: [] });
    n++;
  }
  console.log(`${app}: ${n} file(s) recorded as baseline (covered by the catalog generated ${a.catalog?.generated})`);
}

function mark(app, id, o) {
  needSource(app);
  if (!o.title || !o.modified || !o.kind) fail('mark needs --title, --modified and --kind');
  const features = o.features && o.features !== true ? String(o.features).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const ids = new Set((appInfo(app).catalog?.documents ?? []).map((d) => d.id));
  const unknown = features.filter((f) => !ids.has(f));
  if (unknown.length) fail(`not in the catalog: ${unknown.join(', ')}`);
  record(app, id, { title: o.title, modifiedTime: o.modified, kind: o.kind, features });
  console.log(`marked ${app}: ${o.title} (${o.kind}${features.length ? ` -> ${features.join(', ')}` : ''})`);
}

function synced(app) {
  needSource(app);
  const l = lockOf(app);
  l.lastSyncAt = new Date().toISOString();
  saveLock(app, l);
  console.log(`${app}: sync stamped ${l.lastSyncAt}`);
}

// ---------------------------------------------------------------- catalog

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function upsert(app, file, o) {
  const a = appInfo(app);
  if (!a.catalog) fail(`no catalog at ${rel(a.featuresPath)}`);
  if (!o.source || o.source === true) fail('upsert needs --source "<the file title the features came from>"');
  const incoming = readJson(file, null);
  if (!Array.isArray(incoming)) fail(`${file} must be a JSON array of {feature, category, subcategory, description, is_new}`);
  const cat = a.catalog;
  const byName = new Map(cat.documents.map((d) => [norm(d.feature), d]));
  let next = Math.max(0, ...cat.documents.map((d) => Number(/(\d+)$/.exec(d.id)?.[1] ?? 0))) + 1;
  const touched = [];
  for (const f of incoming) {
    if (!f.feature || !f.description || !f.category) fail(`every feature needs feature, category and description: ${JSON.stringify(f)}`);
    if (!cat.categories.includes(f.category)) {
      cat.categories.push(f.category);
      console.warn(`memory: new category "${f.category}"`);
    }
    let d = byName.get(norm(f.feature));
    const isNew = !d;
    if (isNew) {
      d = { id: `feature-${String(next++).padStart(3, '0')}` };
      cat.documents.push(d);
      byName.set(norm(f.feature), d);
    }
    Object.assign(d, {
      category: f.category,
      subcategory: f.subcategory ?? d.subcategory ?? '',
      feature: isNew ? f.feature : d.feature,
      description: f.description,
      is_new: f.is_new ?? d.is_new ?? isNew,
    });
    d.text = `${d.feature}: ${d.description}`;
    d.metadata = {
      category: d.category,
      subcategory: d.subcategory,
      feature_name: d.feature,
      is_new_feature: d.is_new,
      product: cat.product,
      source: o.source,
    };
    touched.push(`${d.id} ${isNew ? 'added' : 'updated'}: ${d.feature}`);
  }
  cat.total_features = cat.documents.length;
  cat.total_new_features = cat.documents.filter((d) => d.is_new).length;
  cat.updated = new Date().toISOString().slice(0, 10);
  writeJson(a.featuresPath, cat);
  for (const t of touched) console.log(t);
  console.log(`${app}: catalog now ${cat.total_features} feature(s)`);
}

// ---------------------------------------------------------------- status and hook

function status(json) {
  const stale = new Set(staleSources().map((s) => s.app));
  const rows = apps().map((app) => {
    const a = appInfo(app);
    const pages = fs.readdirSync(path.join(FEATURES, app)).filter((f) => f.endsWith('.md') && f !== 'README.md').length;
    const l = lockOf(app);
    const at = l.lastSyncAt;
    return {
      app,
      catalog: a.catalog ? `${a.catalog.documents.length} features (generated ${a.catalog.generated}${a.catalog.updated ? `, updated ${a.catalog.updated}` : ''})` : null,
      videoPages: pages,
      source: a.location ? `${a.envVar} -> ${a.kind ?? 'unknown kind'}` : null,
      remoteFiles: Object.keys(l.files).length,
      lastSyncAt: at,
      stale: stale.has(app),
      age: a.location ? ageText(at ? (Date.now() - Date.parse(at)) / 3.6e6 : Infinity) : null,
      envVar: a.envVar,
    };
  });
  const zep = Boolean(process.env.ZEP_API_KEY);
  if (json) return console.log(JSON.stringify({ apps: rows, zep, maxAgeH: maxAgeH() }, null, 2));
  for (const r of rows) {
    console.log(`${r.app}: ${r.catalog ?? 'no catalog'}; ${r.videoPages} video page(s)`);
    console.log(`  source: ${r.source ? `${r.source}, ${r.remoteFiles} file(s) tracked, ${r.age}${r.stale ? '  STALE' : ''}` : `none (set ${r.envVar} in .env to sync one)`}`);
  }
  console.log(`zep: ${zep ? 'ZEP_API_KEY set' : 'ZEP_API_KEY not set (add it to .env)'}`);
}

// who is running this session: MEMORY_USER, else git's user.email, else the OS account
export function currentUser() {
  const git = (k) => {
    try {
      return execFileSync('git', ['config', k], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const id = process.env.MEMORY_USER || git('user.email') || os.userInfo().username;
  return { id, email: id.includes('@') ? id : undefined, name: git('user.name') || id };
}

// SessionStart hook: attribute the session to its user, and hand Claude the sync job when a source is stale
async function hook() {
  let payload = {};
  if (!process.stdin.isTTY) {
    try {
      payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch {}
  }
  const user = currentUser();
  const session = payload.session_id ?? null;
  const lines = [`Project memory: this Claude session${session ? ` (${session})` : ''} is attributed to ${user.id}.`];
  if (process.env.ZEP_API_KEY && session) {
    try {
      const thread = await sessionThread(session, user, payload.source ?? 'startup', payload.transcript_path ?? null);
      lines.push(
        `It is Zep thread ${thread}. The conversation and a summary go there when the session ends (SessionEnd hook).`,
        `Starting work on a new video (a new flow, trace or manifest)? First run: node pipeline/memory.mjs session video <name> --session ${session} - the video becomes a new session in Zep.`,
        `Notes by hand: node pipeline/memory.mjs zep session --session ${session} --title "<topic>" --file <notes.md>`,
      );
    } catch (e) {
      lines.push(`Could not open its Zep thread: ${e.message}`);
    }
  }
  const stale = staleSources();
  if (stale.length) {
    lines.push(
      `Project memory: ${stale.map((s) => `${s.app} features ${ageText(s.ageH)}`).join('; ')}.`,
      'Before other work, launch the memory agent (.claude/agents/memory.md; if the type is not registered, a general-purpose agent with that file as its instructions) to check the online sources for deltas and update the feature catalogs and Zep. It only reads remote sources; tell the user what changed.',
    );
  }
  if (!process.env.ZEP_API_KEY) lines.push('Project memory: ZEP_API_KEY is not set in .env, so nothing is stored in Zep yet.');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }));
}

// ---------------------------------------------------------------- Zep

async function zepClient() {
  if (!process.env.ZEP_API_KEY) fail('ZEP_API_KEY is not set: add it to .env (Zep Cloud project key)');
  const { ZepClient } = await import('@getzep/zep-cloud');
  return new ZepClient({ apiKey: process.env.ZEP_API_KEY });
}

const zepState = () => ({ graphs: {}, docs: {}, users: {}, sessions: {}, ...readJson(ZEP_STATE, {}) });

async function graphFor(client, st, key) {
  if (st.graphs[key]) return st.graphs[key];
  const name = `productvideo-${key}`;
  for await (const g of await client.graph.list({ search: name })) {
    if (g.name === name) return (st.graphs[key] = g.uuid);
  }
  const g = await client.graph.create({ name, description: key === 'project' ? 'ProductVideo rules and pipeline notes' : `ProductVideo: ${key} features, traces and videos` });
  return (st.graphs[key] = g.uuid);
}

// the app a repo file belongs to: its features folder, or the app whose video page names it
function graphKey(file) {
  const r = rel(file);
  const own = /^memory\/features\/([^/]+)\//.exec(r);
  if (own) return own[1];
  if (r.startsWith('memory/') || r.startsWith('docs/')) return 'project';
  for (const app of apps()) {
    const dir = path.join(FEATURES, app);
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    if (pages.some((p) => p.includes(r))) return app;
  }
  return 'project';
}

function defaultFiles() {
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : [])
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const list = (d, re) => (fs.existsSync(path.join(ROOT, d)) ? fs.readdirSync(path.join(ROOT, d)).filter((f) => re.test(f)).map((f) => path.join(ROOT, d, f)) : []);
  return [
    ...walk(MEMORY).filter((f) => f.endsWith('.md') || f.endsWith('.state.json')),
    path.join(ROOT, 'docs', 'pipeline-lessons.md'),
    ...apps().map((app) => appInfo(app).featuresPath).filter((f) => fs.existsSync(f)),
    ...list('scenarios', /\.trace\.json$/),
    ...list('videos', /\.json$/),
  ];
}

function chunks(text) {
  if (text.length <= EPISODE_CHARS) return [text];
  const out = [];
  let cur = '';
  for (const part of text.split(/(?=^#{1,3} )/m)) {
    if (cur && cur.length + part.length > EPISODE_CHARS) {
      out.push(cur);
      cur = '';
    }
    cur += part;
    while (cur.length > EPISODE_CHARS) {
      out.push(cur.slice(0, EPISODE_CHARS));
      cur = cur.slice(EPISODE_CHARS);
    }
  }
  if (cur) out.push(cur);
  return out;
}

// the Zep documents one file becomes: a catalog is one per feature, anything else one per file
function documentsOf(file) {
  const r = rel(file);
  const text = fs.readFileSync(file, 'utf8');
  const catalog = apps().some((app) => path.resolve(appInfo(app).featuresPath) === path.resolve(file));
  if (catalog) {
    const cat = JSON.parse(text);
    return cat.documents.map((d) => ({
      key: `${r}#${d.id}`,
      kind: 'feature',
      episodes: [{ type: 'json', data: JSON.stringify({ product: cat.product, id: d.id, feature: d.feature, category: d.category, subcategory: d.subcategory, description: d.description, is_new: d.is_new, source: d.metadata?.source }) }],
    }));
  }
  const kind = r.endsWith('.state.json') ? 'video state' : r.startsWith('memory/features/') ? 'video page' : r.startsWith('memory/') || r.startsWith('docs/') ? 'project notes' : r.startsWith('scenarios/') ? 'trace' : 'video manifest';
  if (r.endsWith('.json')) {
    const compact = JSON.stringify(JSON.parse(text));
    const episodes = compact.length <= EPISODE_CHARS ? [{ type: 'json', data: compact }] : chunks(text).map((data) => ({ type: 'text', data }));
    return [{ key: r, kind, episodes }];
  }
  return [{ key: r, kind, episodes: chunks(text).map((data) => ({ type: 'text', data })) }];
}

// Zep document ids may not contain / ? # or control characters; the repo path stays in the metadata
const zepDocId = (key) => key.replace(/[/?#\x00-\x1f]/g, '_');

async function zepPush(files) {
  const client = await zepClient();
  const st = zepState();
  const todo = (files.length ? files.map((f) => path.resolve(f)) : defaultFiles()).filter((f) => fs.existsSync(f));
  let pushed = 0;
  let same = 0;
  for (const f of todo) {
    const key = graphKey(f);
    const graph = await graphFor(client, st, key);
    for (const doc of documentsOf(f)) {
      const hash = crypto.createHash('sha256').update(JSON.stringify(doc.episodes)).digest('hex');
      if (st.docs[doc.key]?.hash === hash) {
        same++;
        continue;
      }
      // a changed document replaces its old episodes
      for (const ep of st.docs[doc.key]?.episodes ?? []) {
        try {
          await client.graph.episode.delete(st.docs[doc.key].graph, ep);
        } catch {}
      }
      const uuids = [];
      for (const [i, ep] of doc.episodes.entries()) {
        const res = await client.graph.episode.add(graph, {
          data: ep.data,
          type: ep.type,
          documentId: zepDocId(doc.key),
          sourceDescription: `${doc.kind} ${doc.key}${doc.episodes.length > 1 ? ` (part ${i + 1}/${doc.episodes.length})` : ''}`,
          metadata: { path: rel(f), kind: doc.kind, app: key },
        });
        if (res.episode?.uuid) uuids.push(res.episode.uuid);
      }
      st.docs[doc.key] = { hash, graph, episodes: uuids, pushedAt: new Date().toISOString() };
      writeJson(ZEP_STATE, st);
      pushed++;
    }
    console.log(`zep: ${rel(f)} -> productvideo-${key}`);
  }
  // a full push also drops documents whose file (or catalog feature) is gone
  let removed = 0;
  if (!files.length) {
    const live = new Set(todo.flatMap((f) => documentsOf(f).map((d) => d.key)));
    for (const [k, d] of Object.entries(st.docs)) {
      if (live.has(k)) continue;
      for (const ep of d.episodes ?? []) {
        try {
          await client.graph.episode.delete(d.graph, ep);
        } catch {}
      }
      delete st.docs[k];
      removed++;
      console.log(`zep: removed ${k}`);
    }
  }
  writeJson(ZEP_STATE, st);
  console.log(`zep: ${pushed} document(s) pushed, ${same} unchanged${removed ? `, ${removed} removed` : ''}`);
}

// one Zep user per person, keyed by their id (an email, usually)
async function zepUser(client, st, user) {
  if (st.users[user.id]) return st.users[user.id];
  for await (const u of await client.user.list()) {
    if (u.userId === user.id) return (st.users[user.id] = u.uuid);
  }
  const u = await client.user.create({ userId: user.id, email: user.email, firstName: user.name, metadata: { repo: 'product-video' } });
  return (st.users[user.id] = u.uuid);
}

// A Claude session's record: the transcript it writes, how far that has been
// pushed to Zep, and its segments. Each segment is one Zep thread: the session
// starts in one, and every new video (`session video <name>`) starts another,
// so a video's work is a session of its own in Zep.
function sessionRecord(st, session) {
  const s = st.sessions[session];
  if (s && !s.segments) {
    // a record from before segments: its one thread is the first segment
    s.segments = [{ thread: s.thread, video: null, fromLine: 0, summarizedLine: 0 }];
    s.pushedLine ??= 0;
  }
  return s;
}

// the current Zep thread of a Claude session, opened under its user on first use
async function sessionThread(session, user, how = 'startup', transcript = null) {
  const client = await zepClient();
  const st = zepState();
  const meta = { claudeSessionId: session, user: user.id };
  const s = sessionRecord(st, session);
  if (s) {
    if (transcript) s.transcript = transcript;
    const current = s.segments.at(-1).thread;
    if (how !== 'startup') {
      await client.thread.addMessages(current, {
        messages: [{ role: 'system', name: 'productvideo', content: `Session ${how} by ${user.name} (${user.id}).`, metadata: meta }],
      });
    }
    writeJson(ZEP_STATE, st);
    return current;
  }
  const thread = await client.thread.create({ userUuid: await zepUser(client, st, user) });
  await client.thread.addMessages(thread.uuid, {
    messages: [{ role: 'system', name: 'productvideo', content: `Claude Code session ${session} started by ${user.name} (${user.id}).`, metadata: meta }],
  });
  st.sessions[session] = {
    thread: thread.uuid,
    user: user.id,
    startedAt: new Date().toISOString(),
    transcript,
    pushedLine: 0,
    segments: [{ thread: thread.uuid, video: null, fromLine: 0, summarizedLine: 0 }],
  };
  writeJson(ZEP_STATE, st);
  return thread.uuid;
}

// the session to act on: --session <id>, else the one started most recently on this machine
function pickSession(st, o) {
  if (o.session && o.session !== true) return o.session;
  const latest = Object.entries(st.sessions).sort(([, a], [, b]) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
  if (!latest) fail('no Claude session recorded yet: pass --session <id> (the SessionStart context names it)');
  return latest[0];
}

// ---- the transcript: what the person typed and what Claude answered, nothing else

// emails and phone numbers never leave the machine
const redact = (t) => t
  .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
  .replace(/\+\d{10,15}\b/g, '[phone]')
  .replace(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone]');

const MESSAGE_CHARS = 2400; // Zep messages are kept well under its content cap

function readTranscript(file) {
  if (!file || !fs.existsSync(file)) return { lines: 0, turns: [], tools: [], prs: [] };
  const raw = fs.readFileSync(file, 'utf8').split('\n');
  const turns = [];
  const tools = [];
  const prs = [];
  raw.forEach((line, i) => {
    if (!line.trim()) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (e.isSidechain) return; // subagents' own work
    const content = e.message?.content;
    if (e.type === 'user' && e.origin?.kind === 'human' && typeof content === 'string') {
      turns.push({ line: i, role: 'user', text: content.trim(), at: e.timestamp });
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (text) turns.push({ line: i, role: 'assistant', text, at: e.timestamp });
      for (const b of content.filter((b) => b.type === 'tool_use')) tools.push({ line: i, name: b.name, input: b.input ?? {} });
    } else if (e.type === 'user' && Array.isArray(content)) {
      // tool results are never pushed; only the pull requests they mention are kept
      const text = JSON.stringify(content);
      for (const m of text.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)) prs.push({ line: i, url: m[0] });
    }
  });
  return { lines: raw.length, turns, tools, prs };
}

// the segment (Zep thread) a transcript line belongs to
const segmentAt = (s, line) => [...s.segments].reverse().find((g) => g.fromLine <= line) ?? s.segments[0];

// push the turns not yet in Zep, each into the thread of its segment
async function flushTranscript(client, s, session, user) {
  const t = readTranscript(s.transcript);
  const fresh = t.turns.filter((x) => x.line >= (s.pushedLine ?? 0));
  const byThread = new Map();
  for (const x of fresh) {
    const g = segmentAt(s, x.line);
    const parts = [];
    for (let at = 0; at < x.text.length; at += MESSAGE_CHARS) parts.push(redact(x.text.slice(at, at + MESSAGE_CHARS)));
    for (const content of parts) {
      if (!byThread.has(g.thread)) byThread.set(g.thread, []);
      byThread.get(g.thread).push({
        role: x.role,
        name: x.role === 'user' ? user.name : 'claude',
        content,
        metadata: { claudeSessionId: session, user: user.id, video: g.video ?? undefined, at: x.at },
      });
    }
  }
  for (const [thread, messages] of byThread) {
    for (let i = 0; i < messages.length; i += 30) await client.thread.addMessages(thread, { messages: messages.slice(i, i + 30) });
  }
  s.pushedLine = t.lines;
  return { t, pushed: fresh.length };
}

// what a stretch of the transcript did, from the record itself (no model involved)
function summarize(t, from, to, session, user, video) {
  const inRange = (x) => x.line >= from && x.line < to;
  const turns = t.turns.filter(inRange);
  if (!turns.length) return null;
  const prompts = turns.filter((x) => x.role === 'user');
  const last = turns.filter((x) => x.role === 'assistant').at(-1);
  const files = [...new Set(t.tools.filter(inRange)
    .filter((x) => ['Edit', 'Write', 'NotebookEdit'].includes(x.name) && x.input.file_path)
    .map((x) => { const p = path.resolve(x.input.file_path); return p.startsWith(ROOT) ? rel(p) : path.basename(p); }))];
  const commits = t.tools.filter(inRange)
    .filter((x) => x.name === 'Bash' && /git commit/.test(x.input.command ?? ''))
    .map((x) => (/-m\s+"([^"\n]+)/.exec(x.input.command)?.[1] ?? /<<'?EOF'?\n([^\n]+)/.exec(x.input.command)?.[1] ?? 'commit'));
  const prs = [...new Set(t.prs.filter(inRange).map((x) => x.url))];
  const lines = [
    `Session summary${video ? ` - video ${video}` : ''}`,
    `Claude Code session ${session}, ${user.name} (${user.id}), ${turns[0].at ?? '?'} to ${turns.at(-1).at ?? '?'}.`,
    '',
    `Asked (${prompts.length}):`,
    ...prompts.slice(0, 40).map((x) => `- ${x.text.replace(/\s+/g, ' ').slice(0, 200)}`),
    ...(prompts.length > 40 ? [`- ... and ${prompts.length - 40} more`] : []),
  ];
  if (files.length) lines.push('', `Files changed (${files.length}):`, ...files.slice(0, 60).map((f) => `- ${f}`));
  if (commits.length) lines.push('', 'Commits:', ...commits.map((c) => `- ${c}`));
  if (prs.length) lines.push('', 'Pull requests:', ...prs.map((u) => `- ${u}`));
  if (last) lines.push('', 'Where it ended:', last.text.slice(0, 1500));
  return redact(lines.join('\n'));
}

// summaries for every segment that has turns not summarized yet
async function summarizeSegments(client, s, t, session, user) {
  let n = 0;
  for (const [i, g] of s.segments.entries()) {
    const to = s.segments[i + 1]?.fromLine ?? t.lines;
    const from = Math.max(g.fromLine, g.summarizedLine ?? 0);
    if (from >= to) continue;
    const text = summarize(t, g.fromLine, to, session, user, g.video);
    if (!text || !t.turns.some((x) => x.line >= from && x.line < to)) continue;
    const parts = [];
    for (let at = 0; at < text.length; at += MESSAGE_CHARS) parts.push(text.slice(at, at + MESSAGE_CHARS));
    await client.thread.addMessages(g.thread, {
      messages: parts.map((content) => ({ role: 'system', name: 'productvideo', content, metadata: { claudeSessionId: session, user: user.id, video: g.video ?? undefined, kind: 'summary' } })),
    });
    g.summarizedLine = to;
    n++;
  }
  return n;
}

// `session video <name>`: the work from here on is a new session in Zep, named for the video
async function sessionVideo(name, o) {
  if (!name) fail('session video needs the video name (the videos/<name>.json it builds)');
  const client = await zepClient();
  const st = zepState();
  const session = pickSession(st, o);
  const user = currentUser();
  if (!sessionRecord(st, session)) await sessionThread(session, user, 'startup', o.transcript ?? null);
  const fresh = zepState();
  const s = sessionRecord(fresh, session);
  if (o.transcript && o.transcript !== true) s.transcript = o.transcript;
  // close out what came before: push it and summarize it in its own thread
  const { t } = await flushTranscript(client, s, session, user);
  await summarizeSegments(client, s, t, session, user);
  const thread = await client.thread.create({ userUuid: await zepUser(client, fresh, user) });
  await client.thread.addMessages(thread.uuid, {
    messages: [{ role: 'system', name: 'productvideo', content: `Video ${name}: new session, started by ${user.name} (${user.id}) in Claude Code session ${session}.`, metadata: { claudeSessionId: session, user: user.id, video: name } }],
  });
  s.segments.push({ thread: thread.uuid, video: name, fromLine: t.lines, summarizedLine: t.lines });
  s.thread = thread.uuid;
  writeJson(ZEP_STATE, fresh);
  console.log(`zep: video ${name} -> new thread ${thread.uuid} for ${user.id} (Claude session ${session})`);
}

// SessionEnd hook (or by hand): push the rest of the transcript and summarize each segment
async function sessionEnd(o) {
  let payload = {};
  if (!process.stdin.isTTY && !o.session) {
    try {
      payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch {}
  }
  if (o['dry-run']) {
    // what would be pushed, without Zep: the turns (masked) and the summary
    const t = readTranscript(o.transcript);
    const user = currentUser();
    const masked = t.turns.filter((x) => redact(x.text) !== x.text).length;
    console.log(`${t.turns.length} turn(s) (${t.turns.filter((x) => x.role === 'user').length} typed), ${masked} with an email or phone masked, ${t.prs.length} PR link(s)\n`);
    console.log(summarize(t, 0, t.lines, o.session ?? '?', user, null));
    return;
  }
  if (!process.env.ZEP_API_KEY) return;
  const st = zepState();
  const session = payload.session_id ?? pickSession(st, o);
  const user = currentUser();
  const transcript = payload.transcript_path ?? (o.transcript !== true ? o.transcript : null) ?? st.sessions[session]?.transcript ?? null;
  if (!sessionRecord(st, session)) await sessionThread(session, user, 'startup', transcript);
  const fresh = zepState();
  const s = sessionRecord(fresh, session);
  if (transcript) s.transcript = transcript;
  if (!s.transcript) fail(`no transcript known for session ${session}: pass --transcript <path to its .jsonl>`);
  const client = await zepClient();
  const { t, pushed } = await flushTranscript(client, s, session, user);
  const summaries = await summarizeSegments(client, s, t, session, user);
  s.endedAt = new Date().toISOString();
  writeJson(ZEP_STATE, fresh);
  console.log(`zep: session ${session} - ${pushed} turn(s) pushed, ${summaries} summary(ies) across ${s.segments.length} thread(s)${payload.reason ? ` (${payload.reason})` : ''}`);
}

async function zepSession(o) {
  if (!o.title || !o.file) fail('zep session needs --title and --file (a path, or - for stdin); --session <id> adds to that session');
  const text = o.file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(o.file, 'utf8');
  const user = currentUser();
  const client = await zepClient();
  let thread;
  if (o.session && o.session !== true) thread = await sessionThread(o.session, user, 'continued');
  else {
    const st = zepState();
    thread = (await client.thread.create({ userUuid: await zepUser(client, st, user) })).uuid;
    writeJson(ZEP_STATE, st);
  }
  const meta = { user: user.id, ...(o.session && o.session !== true ? { claudeSessionId: o.session } : {}) };
  const messages = chunks(text).map((content, i) => ({ role: 'assistant', name: 'claude', content: i ? content : `${o.title}\n\n${content}`, metadata: meta }));
  await client.thread.addMessages(thread, { messages });
  console.log(`zep: "${o.title}" -> thread ${thread} for ${user.id} (${messages.length} message(s))`);
}

async function zepSearch(query, o) {
  if (!query) fail('zep search needs a query');
  const client = await zepClient();
  const st = zepState();
  for (const key of o.app ? [o.app] : [...apps(), 'project']) {
    const graph = await graphFor(client, st, key);
    const page = await client.graph.searchEdges(graph, { query, pageSize: 8 });
    const facts = page.data ?? [];
    if (!facts.length) continue;
    console.log(`# ${key}`);
    for (const e of facts) console.log(`- ${e.fact}`);
  }
  writeJson(ZEP_STATE, st);
}

// ---------------------------------------------------------------- video state
//
// One record per video, memory/features/<app>/<name>.state.json, next to the
// page that names videos/<name>.json (private with its app). build.mjs records
// every build (built, failed the quality gate, or failed outright) and the
// visual review is recorded with `video review`. The status is derived from
// the record, the page's "Video status" section is generated from it, and each
// change goes to the video's Zep thread.

// the app and page of a video: the page that names its manifest
export function videoHome(name) {
  for (const app of apps()) {
    const dir = path.join(FEATURES, app);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md') && x !== 'README.md')) {
      if (fs.readFileSync(path.join(dir, f), 'utf8').includes(`videos/${name}.json`)) {
        return { app, page: path.join(dir, f), state: path.join(dir, `${name}.state.json`) };
      }
    }
  }
  return null;
}

const STATUS_TEXT = {
  'not built': 'Not built yet.',
  'build failed': 'The last build failed before the quality gate.',
  'qa failed': 'The last build failed the quality gate (qa.mjs).',
  'awaiting review': 'Built and through the quality gate; the visual review (video-qa) has not been recorded.',
  'review failed': 'Through the quality gate, but the visual review failed: see the findings.',
  done: 'Done: through the quality gate and the visual review.',
};

function deriveStatus(v) {
  const b = v.build;
  if (!b) return 'not built';
  if (b.outcome === 'failed') return 'build failed';
  if (b.outcome === 'qa-fail') return 'qa failed';
  if (v.review && v.review.at >= b.at) return v.review.verdict === 'PASS' ? 'done' : 'review failed';
  return 'awaiting review';
}

function renderStatus(name, v) {
  const out = [`<!-- video-state:${name} (generated from ${name}.state.json by memory.mjs; do not edit) -->`];
  out.push(`**${name}: ${v.status}.** ${STATUS_TEXT[v.status]} Updated ${v.updatedAt}.`, '');
  if (v.build) {
    const b = v.build;
    out.push(`Last build ${b.at}${b.scope ? ` (${b.scope})` : ''}: ${b.outcome}${b.message ? ` - ${b.message}` : ''}.`);
    if (b.output) out.push(`Output: \`${b.output}\`${b.durationS ? ` (${b.durationS.toFixed(1)}s)` : ''}.`);
    if (b.parts?.length) {
      out.push('', '| Part | qa | Fail | Warn | Checked |', '|---|---|---|---|---|');
      for (const p of b.parts) out.push(`| ${p.part} | ${p.qa} | ${p.fail ?? ''} | ${p.warn ?? ''} | ${p.at ?? ''} |`);
      if (b.joinedQa) out.push(`| joined | ${b.joinedQa} | ${b.joined?.fail ?? ''} | ${b.joined?.warn ?? ''} | ${b.at} |`);
    }
  }
  if (v.review) {
    const r = v.review;
    out.push('', `Visual review ${r.at}: **${r.verdict}**${r.note ? ` - ${r.note}` : ''}.`);
    if (r.findings?.length) out.push(...r.findings.map((f, i) => `${i + 1}. ${f}`));
  }
  if (v.history?.length > 1) {
    out.push('', 'History (newest first):', ...v.history.slice(-8).reverse().map((h) => `- ${h.at}: ${h.event}`));
  }
  out.push(`<!-- /video-state:${name} -->`);
  return out.join('\n');
}

// put the generated block in the page: replace it if present, else make it the
// body of "## Video status" (added at the end when the page has none)
function writeStatusSection(page, name, block) {
  let s = fs.readFileSync(page, 'utf8');
  const marked = new RegExp(`<!-- video-state:${name}[^>]*-->[\\s\\S]*?<!-- /video-state:${name} -->`);
  if (marked.test(s)) s = s.replace(marked, block);
  else {
    const h = /^## Video status.*$/m.exec(s);
    if (h) {
      const rest = s.slice(h.index + h[0].length);
      const next = /^## /m.exec(rest);
      s = s.slice(0, h.index) + `## Video status\n\n${block}\n` + (next ? `\n${rest.slice(next.index)}` : '');
    } else s = `${s.trimEnd()}\n\n## Video status\n\n${block}\n`;
  }
  fs.writeFileSync(page, s);
}

// record one event (synchronous, so build.mjs can call it on its way out)
export function recordVideo(name, event) {
  const home = videoHome(name);
  if (!home) throw new Error(`no video page names videos/${name}.json`);
  const v = readJson(home.state, { name, app: home.app, manifest: `videos/${name}.json`, page: rel(home.page), history: [] });
  // an event can carry its own time (recording one after the fact); otherwise now
  const at = event.at ?? new Date().toISOString();
  if (event.type === 'build') v.build = { ...event, at, type: undefined };
  if (event.type === 'review') v.review = { at, verdict: event.verdict, note: event.note, findings: event.findings ?? [] };
  const summary = event.type === 'build'
    ? `build ${event.outcome}${event.scope ? ` (${event.scope})` : ''}${event.joinedQa ? `, joined qa ${event.joinedQa}` : ''}${event.message ? `: ${event.message}` : ''}`
    : `visual review ${event.verdict}${event.findings?.length ? ` (${event.findings.length} finding(s))` : ''}`;
  v.history = [...(v.history ?? []), { at, event: summary }].slice(-30);
  v.status = deriveStatus(v);
  v.updatedAt = at;
  writeJson(home.state, v);
  writeStatusSection(home.page, name, renderStatus(name, v));
  return { home, v, summary };
}

// a part's quality-gate counts, from its qa.json
export function qaCounts(file) {
  const q = readJson(file, null);
  if (!q) return null;
  return { qa: q.verdict, fail: q.counts?.fail ?? 0, warn: q.counts?.warn ?? 0, at: fs.statSync(file).mtime.toISOString() };
}

function videoState(name, o) {
  const home = videoHome(name) ?? fail(`no video page names videos/${name}.json`);
  const v = readJson(home.state, null);
  if (!v) return console.log(`${name}: not built (no ${rel(home.state)} yet)`);
  if (o.json) return console.log(JSON.stringify(v, null, 2));
  console.log(renderStatus(name, v).split('\n').filter((l) => !l.startsWith('<!--')).join('\n'));
}

function videoReview(name, verdict, o) {
  if (!['PASS', 'FAIL'].includes(String(verdict).toUpperCase())) fail('video review needs PASS or FAIL');
  let findings = [];
  if (o.findings && o.findings !== true) {
    const text = o.findings === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(o.findings, 'utf8');
    try {
      findings = JSON.parse(text);
    } catch {
      findings = text.split(/\r?\n/).map((l) => l.replace(/^\s*(\d+[.)]|[-*])\s*/, '').trim()).filter(Boolean);
    }
  }
  const { summary } = recordVideo(name, { type: 'review', verdict: String(verdict).toUpperCase(), note: o.note !== true ? o.note : undefined, findings: findings.map((f) => redact(String(f))) });
  console.log(`${name}: ${summary}`);
}

// `video sync <name>`: the state record and page to the app graph, the latest event to the video's thread(s)
async function videoSync(name) {
  const home = videoHome(name) ?? fail(`no video page names videos/${name}.json`);
  const v = readJson(home.state, null);
  if (!v) return console.log(`${name}: no state yet`);
  if (!process.env.ZEP_API_KEY) return console.log('zep: ZEP_API_KEY not set, state kept locally');
  await zepPush([home.state, home.page]);
  const client = await zepClient();
  const st = zepState();
  const threads = Object.entries(st.sessions).flatMap(([session, s]) => (sessionRecord(st, session).segments ?? [])
    .filter((g) => g.video === name).map((g) => ({ session, thread: g.thread })));
  const last = v.history.at(-1);
  for (const { session, thread } of threads.slice(-1)) {
    await client.thread.addMessages(thread, {
      messages: [{ role: 'system', name: 'productvideo', content: `Video ${name} is now "${v.status}": ${last?.event ?? ''}`, metadata: { claudeSessionId: session, video: name, kind: 'video-state' } }],
    });
  }
  writeJson(ZEP_STATE, st);
  console.log(`zep: ${name} state "${v.status}" pushed${threads.length ? ' and posted to its video thread' : ''}`);
}

// ---------------------------------------------------------------- CLI

function fail(msg) {
  console.error(`memory: ${msg}`);
  process.exit(1);
}

function opts(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const k = args[i].slice(2);
      o[k] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    } else o._.push(args[i]);
  }
  return o;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  loadTarget(undefined); // .env: FEATURE_SOURCE_*, ZEP_API_KEY
  const [cmd, ...rest] = process.argv.slice(2);
  const o = opts(rest);
  if (cmd === 'status') status(o.json);
  else if (cmd === 'hook') await hook();
  else if (cmd === 'session' && o._[0] === 'video') await sessionVideo(o._[1], o);
  else if (cmd === 'session' && o._[0] === 'end') await sessionEnd(o);
  else if (cmd === 'video' && o._[0] === 'state') videoState(o._[1], o);
  else if (cmd === 'video' && o._[0] === 'review') videoReview(o._[1], o._[2], o);
  else if (cmd === 'video' && o._[0] === 'sync') await videoSync(o._[1]);
  else if (cmd === 'source') source(o._[0]);
  else if (cmd === 'diff') diff(o._[0], o._[1]);
  else if (cmd === 'baseline') baseline(o._[0], o._[1]);
  else if (cmd === 'upsert') upsert(o._[0], o._[1], o);
  else if (cmd === 'mark') mark(o._[0], o._[1], o);
  else if (cmd === 'synced') synced(o._[0]);
  else if (cmd === 'zep' && o._[0] === 'push') await zepPush(o._.slice(1));
  else if (cmd === 'zep' && o._[0] === 'session') await zepSession(o);
  else if (cmd === 'zep' && o._[0] === 'search') await zepSearch(o._.slice(1).join(' '), o);
  else fail('usage: node memory.mjs status|hook|source|diff|baseline|upsert|mark|synced|session video|session end|video state|video review|video sync|zep push|zep session|zep search (see the header of this file)');
}
