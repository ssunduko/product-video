// Documentation as code: keep the docs in step with the code they describe.
//
//   node docs/check.mjs            regenerate the diagrams, then check coverage
//   node docs/check.mjs --ci       same, but also fail if regeneration changed a
//                                  committed file (the PR forgot to regenerate)
//   node docs/check.mjs --hook     Claude Code PostToolUse hook: reads the hook
//                                  payload on stdin, runs only when the edited
//                                  file is code or the model, and hands any gap
//                                  back to Claude as context (never blocks)
//
// Two kinds of drift, two answers:
//
// 1. Generated docs. Everything in docs/ except this file, c4-model.mjs and
//    pipeline-lessons.md (prose) is rendered from c4-model.mjs. They are regenerated here, never edited by hand,
//    so they cannot drift from the model.
//
// 2. Prose. The model's descriptions and README.md are written by people, so they
//    can only be CHECKED, not generated. The rules below derive what must be
//    documented from the code itself — the stage files, the env vars the code
//    reads, the npm scripts, the target options, the script commands — and fail
//    with the exact list of what is missing, so the fix is obvious.
//
// Exit 1 on any gap (or, with --ci, on stale generated files). No dependencies.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MODE = process.argv.includes('--ci') ? 'ci' : process.argv.includes('--hook') ? 'hook' : 'local';

// Files whose change can make the docs stale. Edits elsewhere are ignored by --hook.
const WATCHED = [/^pipeline\/[^/]+\.mjs$/, /^pipeline\/package\.json$/, /^docs\/c4-model\.mjs$/, /^README\.md$/];

// Env vars the code reads that belong to the OS, not to this project.
const OS_ENV = new Set(['LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'PROGRAMFILES', 'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']);

// ---------------------------------------------------------------- hook gate
let hookFile = null;
if (MODE === 'hook') {
  let payload = '';
  try {
    payload = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }
  try {
    const j = JSON.parse(payload || '{}');
    hookFile = j.tool_input?.file_path ?? j.tool_response?.filePath ?? null;
  } catch {
    process.exit(0);
  }
  if (!hookFile) process.exit(0);
  // Git Bash style /c/Repair/... -> C:/Repair/... so it resolves on Windows too
  if (process.platform === 'win32') hookFile = hookFile.replace(/^\/([a-zA-Z])\//, '$1:/');
  const r = rel(path.resolve(hookFile));
  if (!WATCHED.some((re) => re.test(r))) process.exit(0);
  hookFile = r;
}

// ---------------------------------------------------------------- 1. regenerate
const GENERATED_DIR = path.join(ROOT, 'docs');
const isGenerated = (f) => /\.(puml|mdj)$/.test(f) || f === 'C4.md';
// Hashed with line endings normalised: a checkout made with core.autocrlf=true
// holds CRLF while the generator writes LF, and that alone is not a change.
const snapshot = () =>
  Object.fromEntries(
    fs.readdirSync(GENERATED_DIR)
      .filter(isGenerated)
      .map((f) => [f, crypto.createHash('sha1')
        .update(fs.readFileSync(path.join(GENERATED_DIR, f), 'utf8').replace(/\r\n/g, '\n'))
        .digest('hex')]),
  );

const before = snapshot();
const gen = spawnSync(process.execPath, [path.join(GENERATED_DIR, 'c4-model.mjs')], { cwd: ROOT, encoding: 'utf8' });
const problems = [];
if (gen.status !== 0) {
  problems.push(`docs/c4-model.mjs failed to generate:\n${(gen.stdout + gen.stderr).trim().split('\n').slice(-8).join('\n')}`);
}
const after = snapshot();
const regenerated = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((f) => before[f] !== after[f])
  .map((f) => `docs/${f}`);

// ---------------------------------------------------------------- 2. coverage
const model = read('docs/c4-model.mjs');
const readme = read('README.md');
const grammar = fs.existsSync(path.join(ROOT, 'scripts/grammar-tour.demo')) ? read('scripts/grammar-tour.demo') : '';
const pipelineFiles = fs.readdirSync(path.join(ROOT, 'pipeline')).filter((f) => f.endsWith('.mjs')).sort();
const code = Object.fromEntries(pipelineFiles.map((f) => [f, read(`pipeline/${f}`)]));
const word = (s) => new RegExp(`(^|[^A-Za-z0-9_])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`);

function rule(name, items, documented, where) {
  const missing = items.filter((x) => !documented(x));
  if (missing.length) problems.push(`${name} not documented in ${where}: ${missing.join(', ')}`);
}

// every stage / module is a box in the architecture and has a line in the README
rule('pipeline file(s)', pipelineFiles, (f) => model.includes(f), 'docs/c4-model.mjs (add a container or component that names it)');
rule('pipeline file(s)', pipelineFiles, (f) => readme.includes(f), 'README.md (the Layout block, at least)');

// every env var the code reads
const envVars = [...new Set(Object.values(code).flatMap((s) => [...s.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)].map((m) => m[1])))]
  .filter((v) => !OS_ENV.has(v))
  .sort();
rule('environment variable(s)', envVars, (v) => word(v).test(readme), 'README.md');

// every npm alias
const scripts = Object.keys(JSON.parse(read('pipeline/package.json')).scripts ?? {}).sort();
rule('npm script(s)', scripts, (s) => readme.includes(`npm run ${s}`), 'README.md (as `npm run <name>`)');

// every option a target file accepts
const targetSrc = code['target.mjs'] ?? '';
const targetKeys = [...new Set(
  ['KNOWN_KEYS', 'KNOWN_AUTH_KEYS', 'KNOWN_AUTH_SELECTORS'].flatMap((k) => {
    const m = new RegExp(`const ${k} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(targetSrc);
    return m ? [...m[1].matchAll(/'([A-Za-z]+)'/g)].map((x) => x[1]) : [];
  }),
)].sort();
rule('target option(s)', targetKeys, (k) => readme.includes(`"${k}"`) || readme.includes(`\`${k}\``), 'README.md (as "key" or `key`)');

// every command the .demo grammar accepts
const scriptSrc = code['script.mjs'] ?? '';
const commands = [...new Set([...scriptSrc.matchAll(/^\s+case '([a-z]+)':/gm)].map((m) => m[1]))].sort();
// shown either as a line of a script, or in backticks in the README's tables
const usedAt = (c) => new RegExp(`^\\s*${c}(:|\\s|$)`, 'm');
const quoted = (c) => new RegExp('`' + c + '(:|\\s|`)');
rule('script command(s)', commands, (c) => usedAt(c).test(grammar) || usedAt(c).test(readme) || quoted(c).test(readme),
  'README.md or scripts/grammar-tour.demo (as `command ...` or a script line starting with it)');

// every video manifest is named on a feature page in memory/, so what each video covers is on record
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : [])
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const featurePages = walk(path.join(ROOT, 'memory/features')).filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(f, 'utf8'));
const videos = fs.existsSync(path.join(ROOT, 'videos'))
  ? fs.readdirSync(path.join(ROOT, 'videos')).filter((f) => f.endsWith('.json')).map((f) => `videos/${f}`).sort()
  : [];
rule('video manifest(s)', videos, (v) => featurePages.some((p) => p.includes(v)), 'memory/features/ (name it on the page of the feature it covers)');

// .env.example lists the same keys as .env, in the same order (local only: CI has no .env)
const envKeys = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)
  .map((l) => /^#?\s?([A-Z][A-Z0-9_]*)=/.exec(l)?.[1]).filter(Boolean);
if (fs.existsSync(path.join(ROOT, '.env')) && fs.existsSync(path.join(ROOT, '.env.example'))) {
  const [local, example] = [envKeys('.env'), envKeys('.env.example')];
  const onlyLocal = local.filter((k) => !example.includes(k));
  const onlyExample = example.filter((k) => !local.includes(k));
  if (onlyLocal.length) problems.push(`.env.example is missing key(s) that .env has: ${onlyLocal.join(', ')}`);
  if (onlyExample.length) problems.push(`.env is missing key(s) that .env.example lists (add them, empty or commented): ${onlyExample.join(', ')}`);
}

// nothing committed depends on a private target: a trace, script or manifest whose
// target file is gitignored (Salesmessage) is private too and must be gitignored
const git = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
if (git.status === 0) {
  const tracked = new Set(git.stdout.split(/\r?\n/).filter(Boolean));
  const privateTarget = (t) => t && fs.existsSync(path.join(ROOT, 'targets', `${t}.json`)) && !tracked.has(`targets/${t}.json`);
  const targetOf = (f) => {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) return null;
    const text = fs.readFileSync(abs, 'utf8');
    if (f.endsWith('.demo')) return /^target:\s*(\S+)/m.exec(text)?.[1] ?? null;
    try {
      const j = JSON.parse(text);
      if (j.target) return j.target;
      const script = j.parts?.[0]?.script;
      return script ? targetOf(`scenarios/${path.basename(script).replace(/\.demo$/, '.trace.json')}`) : null;
    } catch {
      return null;
    }
  };
  const leaks = [...tracked].filter((f) => /^(scenarios\/.*\.trace\.json|scripts\/.*\.demo|videos\/.*\.json)$/.test(f) && privateTarget(targetOf(f)));
  if (leaks.length) problems.push(`committed file(s) use a gitignored target, so they are private too: ${leaks.join(', ')} - add them to .gitignore and git rm --cached them`);
}

// ---------------------------------------------------------------- report
const staleInCi = MODE === 'ci' && regenerated.length;
if (staleInCi) {
  problems.unshift(`generated docs were stale — regenerate and commit: node docs/c4-model.mjs\n  changed: ${regenerated.join(', ')}`);
}

if (MODE === 'hook') {
  // Feed back to Claude only when there is something to act on.
  const lines = [];
  if (regenerated.length) lines.push(`Docs regenerated after editing ${hookFile}: ${regenerated.join(', ')} — include them in the commit.`);
  if (problems.length) {
    lines.push(`Documentation is now out of step with ${hookFile}. Update it in this same change:`);
    for (const p of problems) lines.push(`- ${p}`);
    lines.push('If the change alters what a stage does (not just its name), also update its description in docs/c4-model.mjs and the README section for it, then rerun: node docs/check.mjs');
  }
  if (lines.length) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') },
    }));
  }
  process.exit(0);
}

if (regenerated.length && MODE === 'local') console.log(`regenerated: ${regenerated.join(', ')}`);
if (problems.length) {
  console.error(`docs check FAILED (${problems.length}):`);
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
console.log(`docs check passed: ${pipelineFiles.length} pipeline files, ${envVars.length} env vars, ${scripts.length} npm scripts, ` +
  `${targetKeys.length} target options, ${commands.length} script commands, ${videos.length} videos documented; diagrams ${regenerated.length ? 'regenerated' : 'up to date'}.`);
