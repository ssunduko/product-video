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
// session's thread under that user, so notes saved with --session <id> land there.
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
      const thread = await sessionThread(session, user, payload.source ?? 'startup');
      lines.push(`It is Zep thread ${thread}. To save notes: node pipeline/memory.mjs zep session --session ${session} --title "<topic>" --file <notes.md>`);
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
  if (r.startsWith('memory/')) return 'project';
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
    ...walk(MEMORY).filter((f) => f.endsWith('.md')),
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
  const kind = r.startsWith('memory/features/') ? 'video page' : r.startsWith('memory/') ? 'project notes' : r.startsWith('scenarios/') ? 'trace' : 'video manifest';
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
  writeJson(ZEP_STATE, st);
  console.log(`zep: ${pushed} document(s) pushed, ${same} unchanged`);
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

// the Zep thread of a Claude session, opened under its user on first use
async function sessionThread(session, user, how = 'startup') {
  const client = await zepClient();
  const st = zepState();
  if (st.sessions[session]) {
    if (how !== 'startup') {
      await client.thread.addMessages(st.sessions[session].thread, {
        messages: [{ role: 'system', name: 'productvideo', content: `Session ${how} by ${user.name} (${user.id}).`, metadata: { claudeSessionId: session, user: user.id } }],
      });
    }
    return st.sessions[session].thread;
  }
  const thread = await client.thread.create({ userUuid: await zepUser(client, st, user) });
  await client.thread.addMessages(thread.uuid, {
    messages: [{ role: 'system', name: 'productvideo', content: `Claude Code session ${session} started by ${user.name} (${user.id}).`, metadata: { claudeSessionId: session, user: user.id } }],
  });
  st.sessions[session] = { thread: thread.uuid, user: user.id, startedAt: new Date().toISOString() };
  writeJson(ZEP_STATE, st);
  return thread.uuid;
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
  else if (cmd === 'source') source(o._[0]);
  else if (cmd === 'diff') diff(o._[0], o._[1]);
  else if (cmd === 'baseline') baseline(o._[0], o._[1]);
  else if (cmd === 'upsert') upsert(o._[0], o._[1], o);
  else if (cmd === 'mark') mark(o._[0], o._[1], o);
  else if (cmd === 'synced') synced(o._[0]);
  else if (cmd === 'zep' && o._[0] === 'push') await zepPush(o._.slice(1));
  else if (cmd === 'zep' && o._[0] === 'session') await zepSession(o);
  else if (cmd === 'zep' && o._[0] === 'search') await zepSearch(o._.slice(1).join(' '), o);
  else fail('usage: node memory.mjs status|hook|source|diff|baseline|upsert|mark|synced|zep push|zep session|zep search (see the header of this file)');
}
