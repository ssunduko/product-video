// Target configuration: where a scenario runs and, optionally, how to sign in.
//
// A scenario describes a *flow*; a target describes the *deployment* it runs
// against. Keeping them apart means the same flow records against localhost,
// staging or a customer sandbox by swapping `--target`, and means credentials
// never land in a scenario file.
//
// Resolution, later wins:
//   targets/<name>.json          committed, no secrets
//   targets/<name>.local.json    gitignored, secrets
//   .env                   gitignored, KEY=VALUE for env: references
//   DEMO_APP / DEMO_USERNAME / DEMO_PASSWORD
//
// Any string value may be written as "env:VAR_NAME" and is read from the
// environment at load time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TARGETS_DIR = path.join(HERE, '..', 'targets');
const ENV_FILE = path.join(HERE, '..', '.env');

const AUTH_MODES = new Set(['none', 'form']);
const AUTH_STARTS = new Set(['signed-out', 'signed-in']);

const KNOWN_KEYS = new Set([
  'name',
  'description',
  'app',
  'startUrl',
  'viewport',
  'pageUrlMatch',
  'blockUrls',
  'hideSelectors',
  'blurSelectors',
  'replaceText',
  'profile',
  'auth',
  'secrets',
]);

const KNOWN_AUTH_KEYS = new Set([
  'mode',
  'start',
  'username',
  'password',
  'selectors',
]);

const KNOWN_AUTH_SELECTORS = new Set([
  'signInLink', // optional: clicked first if the landing page hides the form
  'username',
  'password',
  'submit', // omit to submit with Enter
  'signedIn', // anchor proving the app is loaded after submit
  'userMenu',
  'logoutItem',
  'loginHeading',
]);

// ---- .env ----

// Minimal KEY=VALUE reader. Only fills variables that are not already set, so
// an explicit shell export always wins over the file.
function loadDotEnv(file = ENV_FILE) {
  if (!fs.existsSync(file)) return;

  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq < 1) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// ---- helpers ----

const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  if (!isPlain(base) || !isPlain(over)) return over === undefined ? base : over;

  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlain(v) && isPlain(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

// Replace "env:VAR" strings with the environment's value. A missing variable
// resolves to null and is recorded, so the error names the variable instead of
// failing later with an empty password.
function resolveEnvRefs(value, missing, trail = []) {
  if (typeof value === 'string') {
    const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value.trim());
    if (!m) return value;

    const found = process.env[m[1]];
    if (found === undefined || found === '') {
      missing.push({ at: trail.join('.'), variable: m[1] });
      return null;
    }
    return found;
  }

  if (Array.isArray(value)) {
    return value.map((v, i) => resolveEnvRefs(v, missing, [...trail, i]));
  }

  if (isPlain(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        resolveEnvRefs(v, missing, [...trail, k]),
      ]),
    );
  }

  return value;
}

// JSON has no comments; keys starting with "//" are the convention used in the
// example targets and are ignored everywhere
function warnUnknown(obj, allowed, where) {
  for (const key of Object.keys(obj ?? {})) {
    if (!key.startsWith('//') && !allowed.has(key)) {
      console.warn(`warning: unknown key "${key}" in ${where} (ignored)`);
    }
  }
}

// ---- load ----

export function targetPathFor(ref) {
  // a ref containing a separator or ending in .json is a path; anything else
  // is a name looked up in targets/
  const pathish = /[\\/]/.test(ref) || ref.endsWith('.json');
  return pathish ? path.resolve(ref) : path.join(TARGETS_DIR, `${ref}.json`);
}

export function listTargets() {
  if (!fs.existsSync(TARGETS_DIR)) return [];
  return fs
    .readdirSync(TARGETS_DIR)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.local.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

/**
 * Load a target by name/path. Returns null when there is nothing to load —
 * no ref and no DEMO_* environment overrides — so callers can treat "no
 * target" as "use whatever the scenario declares".
 */
export function loadTarget(ref) {
  loadDotEnv();

  const envOnly =
    !ref &&
    (process.env.DEMO_APP || process.env.DEMO_USERNAME || process.env.DEMO_PASSWORD);

  if (!ref && !envOnly) return null;

  const sources = [];
  let raw = {};

  if (ref) {
    const base = targetPathFor(ref);
    const local = base.replace(/\.json$/, '.local.json');
    const baseJson = readJson(base);
    const localJson = readJson(local);

    if (!baseJson && !localJson) {
      const known = listTargets();
      throw new Error(
        `target "${ref}" not found (looked for ${base}).` +
          (known.length ? ` Known targets: ${known.join(', ')}` : '') +
          '\nCreate one from targets/signed-in.json, or point at the app with' +
          ' DEMO_APP / DEMO_USERNAME / DEMO_PASSWORD.',
      );
    }

    if (baseJson) sources.push(base);
    if (localJson) sources.push(local);
    raw = deepMerge(baseJson ?? {}, localJson ?? {});
  }

  warnUnknown(raw, KNOWN_KEYS, ref ? path.basename(targetPathFor(ref)) : 'target');
  warnUnknown(raw.auth, KNOWN_AUTH_KEYS, 'target.auth');
  warnUnknown(raw.auth?.selectors, KNOWN_AUTH_SELECTORS, 'target.auth.selectors');

  const missingEnv = [];
  const cfg = resolveEnvRefs(raw, missingEnv);

  // direct environment overrides — the "just point it somewhere" path
  if (process.env.DEMO_APP) {
    cfg.app = process.env.DEMO_APP;
    sources.push('DEMO_APP');
  }
  if (process.env.DEMO_USERNAME) {
    cfg.auth = { ...(cfg.auth ?? {}), username: process.env.DEMO_USERNAME };
    sources.push('DEMO_USERNAME');
  }
  if (process.env.DEMO_PASSWORD) {
    cfg.auth = { ...(cfg.auth ?? {}), password: process.env.DEMO_PASSWORD };
    sources.push('DEMO_PASSWORD');
  }

  const auth = cfg.auth ? normaliseAuth(cfg.auth) : null;

  if (cfg.app && !/^https?:\/\//i.test(cfg.app)) {
    throw new Error(`target app must be an http(s) URL, got "${cfg.app}"`);
  }

  return {
    name: cfg.name ?? (ref ? path.basename(String(ref)).replace(/\.json$/, '') : 'env'),
    description: cfg.description ?? null,
    sources,
    app: cfg.app ?? null,
    startUrl: cfg.startUrl ?? null,
    viewport: cfg.viewport ?? null,
    pageUrlMatch: cfg.pageUrlMatch ?? null,
    blockUrls: cfg.blockUrls ?? [],
    hideSelectors: cfg.hideSelectors ?? [],
    blurSelectors: cfg.blurSelectors ?? [],
    replaceText: normaliseReplace(cfg.replaceText),
    profile: cfg.profile ?? null,
    secrets: cfg.secrets ?? {},
    auth,
    missingEnv,
  };
}

// replaceText: [{ from, to, whole? }] — real names shown as invented ones.
function normaliseReplace(pairs) {
  if (pairs === undefined || pairs === null) return [];
  if (!Array.isArray(pairs)) throw new Error('target replaceText must be an array of { from, to, whole? }');
  return pairs.map((p, i) => {
    if (!isPlain(p) || typeof p.from !== 'string' || !p.from || typeof p.to !== 'string') {
      throw new Error(`target replaceText[${i}] needs a non-empty "from" and a "to" string`);
    }
    return { from: p.from, to: p.to, whole: p.whole === true };
  });
}

// Runs in the page (puppeteer serialises it, so it must stay self-contained).
// Shows `to` wherever the app draws `from`, in every text node, as it draws
// and whenever it redraws. Longer `from` first, so "Pat Lane" wins over
// "Text"; `whole` matches only a node whose trimmed text is exactly `from`
// (initials, short words). Only the browser's copy of the page changes:
// nothing is sent to the app.
export function textReplacer(pairs) {
  const list = [...pairs].sort((a, b) => b.from.length - a.from.length);
  const swap = (t) => {
    for (const p of list) {
      if (p.whole) { if (t.trim() === p.from) return t.replace(p.from, p.to); }
      else if (t.includes(p.from)) t = t.split(p.from).join(p.to);
    }
    return t;
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);
  const fix = (node) => {
    if (node.nodeType === 3) {
      if (node.parentNode && SKIP.has(node.parentNode.nodeName)) return;
      const next = swap(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    if (SKIP.has(node.nodeName)) return;
    const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fix(n);
  };
  // Input values are not text nodes (a contact's Phone field). The app writes
  // them through the `value` setter, so the setter is wrapped: the invented
  // value is what lands, with no frame of the real one in between (take 5 of
  // an earlier take flashed a real number while a 150ms timer was the
  // only swap). The timer stays for values set any other way. Never a
  // password, never the field being typed in. Only the shown value changes;
  // nothing is typed or saved.
  const proto = typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set && !desc.set.__demoReplace) {
    const set = function (v) {
      const swapped = this.type === 'password' || this === document.activeElement ? v : swap(String(v ?? ''));
      return desc.set.call(this, swapped);
    };
    set.__demoReplace = true;
    Object.defineProperty(proto, 'value', { ...desc, set });
  }
  const fixInputs = () => {
    for (const el of document.querySelectorAll('input')) {
      if (el.type === 'password' || el === document.activeElement) continue;
      const next = swap(el.value);
      if (next !== el.value) el.value = next;
    }
  };
  // Text that CSS draws from an attribute (`content: attr(data-name)`) is not
  // a text node: some apps draw a contact's avatar initials that way, and
  // a take showed the real initials next to the invented name. Those attributes
  // are swapped too, as they are set.
  const ATTRS = ['data-name'];
  const fixAttrs = (el) => {
    if (el?.nodeType !== 1 || typeof el.getAttribute !== 'function') return;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v == null) continue;
      const next = swap(v);
      if (next !== v) el.setAttribute(a, next);
    }
  };
  const fixAttrsUnder = (node) => {
    if (node?.nodeType !== 1 && node?.nodeType !== 9) return;
    if (node.nodeType === 1) fixAttrs(node);
    node.querySelectorAll?.(ATTRS.map((a) => `[${a}]`).join(',')).forEach(fixAttrs);
  };
  const start = () => {
    if (!document.documentElement || document.documentElement.__demoReplace) return;
    document.documentElement.__demoReplace = true;
    fix(document.documentElement);
    fixAttrsUnder(document.documentElement);
    fixInputs();
    setInterval(fixInputs, 150);
    new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === 'characterData') fix(m.target);
        else if (m.type === 'attributes') fixAttrs(m.target);
        else m.addedNodes.forEach((n) => { fix(n); fixAttrsUnder(n); });
      }
    }).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
  };
  start();
  document.addEventListener('DOMContentLoaded', start);
}

function normaliseAuth(auth) {
  const mode = auth.mode ?? (auth.username ? 'form' : 'none');
  if (!AUTH_MODES.has(mode)) {
    throw new Error(
      `target.auth.mode must be one of ${[...AUTH_MODES].join(', ')}, got "${mode}"`,
    );
  }

  const start = auth.start ?? 'signed-out';
  if (!AUTH_STARTS.has(start)) {
    throw new Error(
      `target.auth.start must be one of ${[...AUTH_STARTS].join(', ')}, got "${start}"`,
    );
  }

  return {
    mode,
    start,
    username: auth.username ?? null,
    password: auth.password ?? null,
    selectors: auth.selectors ?? {},
  };
}

// ---- reporting ----

// Usernames appear on camera during an on-camera login, so they are printed as
// given. Passwords are never printed, not even partially.
export function describeTarget(t) {
  if (!t) return 'target: none (using the scenario\'s own APP)';

  const lines = [
    `target: ${t.name}${t.description ? ` — ${t.description}` : ''}`,
    `  app: ${t.app ?? '(from scenario)'}`,
    `  from: ${t.sources.length ? t.sources.join(', ') : '(defaults)'}`,
  ];

  if (t.auth && t.auth.mode !== 'none') {
    lines.push(
      `  auth: ${t.auth.mode}, start ${t.auth.start}, user ${t.auth.username ?? '(not set)'}` +
        `, password ${t.auth.password ? '********' : '(not set)'}`,
    );
  }

  return lines.join('\n');
}

// Thrown when a flow actually needs credentials, not at load time — a target
// without a password is fine until something tries to sign in with it.
export function requireCredentials(t) {
  const missingList = (t?.missingEnv ?? [])
    .map((m) => `${m.variable} (for ${m.at})`)
    .join(', ');

  const hint =
    (missingList ? `\nUnset environment variables: ${missingList}.` : '') +
    '\nSupply them in targets/<name>.local.json, .env, or as' +
    ' DEMO_USERNAME / DEMO_PASSWORD.';

  if (!t?.auth || t.auth.mode !== 'form') {
    throw new Error(
      'this flow signs in, but the target has no auth block (auth.mode "form").' + hint,
    );
  }
  if (!t.auth.username) throw new Error('target auth.username is not set.' + hint);
  if (!t.auth.password) throw new Error('target auth.password is not set.' + hint);

  return t.auth;
}
