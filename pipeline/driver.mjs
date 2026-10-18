import puppeteer from 'puppeteer-core';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTarget, describeTarget, requireCredentials } from './target.mjs';
import { compileScript } from './script.mjs';

// usage: node driver.mjs <scenario.mjs|flow.demo> [--target <name|path>]
//
// The input is either a scenario module or a plain-text script (anything not
// ending in .mjs/.js), which is compiled to a scenario first.
//
// A target (--target, or DEMO_TARGET, or a TARGET export on the scenario)
// supplies the app URL and, optionally, credentials — see target.mjs.
const argv = process.argv.slice(2);
let inputPath = null;
let targetRef = null;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--target' || a === '-t') targetRef = argv[++i];
  else if (a.startsWith('--target=')) targetRef = a.slice('--target='.length);
  else if (!a.startsWith('-') && !inputPath) inputPath = a;
  else {
    console.error(`unexpected argument "${a}"`);
    process.exit(1);
  }
}

if (!inputPath) {
  console.error('usage: node driver.mjs <scenario.mjs|flow.demo> [--target <name>]');
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'out');
const FRAMES = path.join(OUT, 'frames');
// Overridden per target (target.profile) when a video needs two signed-in users:
// each records from its own Chrome profile instead of signing in on camera.
let PROFILE = path.join(HERE, '..', 'profile');
const PORT = Number(process.env.CDP_PORT || 9333);

fs.mkdirSync(OUT, { recursive: true });

// ---- load the flow ----
// a scenario module must export SEL, run(d), and APP unless a target supplies
// one; optionally VIEWPORT, PAGE_URL_MATCH, START_URL and TARGET.
const resolvedInput = path.resolve(inputPath);
let scenarioPath = resolvedInput;

if (!/\.(mjs|js)$/i.test(resolvedInput)) {
  const { source, warnings } = compileScript(fs.readFileSync(resolvedInput, 'utf8'), {
    file: path.basename(resolvedInput),
    sourcePath: inputPath,
    // the real path, so `ask` selectors find their sidecar. Unresolved ones
    // throw here — before Chrome is up and the recording has started.
    scriptPath: resolvedInput,
  });

  for (const w of warnings) console.warn(`warning: ${w}`);

  const genDir = path.join(OUT, 'generated');
  fs.mkdirSync(genDir, { recursive: true });
  scenarioPath = path.join(
    genDir,
    `${path.basename(resolvedInput).replace(/\.[^.]+$/, '')}.mjs`,
  );
  fs.writeFileSync(scenarioPath, source);
  console.log(`compiled ${inputPath} -> ${scenarioPath}`);
}

const scenario = await import(pathToFileURL(scenarioPath).href);
const { run } = scenario;

if (typeof run !== 'function') {
  throw new Error(`${inputPath} must export run(d)`);
}

// ---- resolve the target ----
const target = loadTarget(targetRef ?? process.env.DEMO_TARGET ?? scenario.TARGET);
console.log(describeTarget(target));

// target beats scenario: the point of a target is to redirect a flow at another
// deployment without touching the flow
const APP = target?.app ?? scenario.APP;

if (!APP) {
  throw new Error(
    `no app URL: ${inputPath} exports no APP and no target supplied one.\n` +
      'Add `export const APP = ...`, pass --target <name>, or set DEMO_APP.',
  );
}

const VIEWPORT = target?.viewport ?? scenario.VIEWPORT ?? { width: 1440, height: 810 };

if (target?.profile) {
  PROFILE = path.resolve(HERE, '..', target.profile);
  console.log(`profile: ${PROFILE}`);
}

// which tabs count as "the app" — always includes the app's own host, plus
// anything the scenario or target lists (e.g. an external identity provider)
const PAGE_URL_MATCH = [
  ...new Set([
    new URL(APP).host,
    ...(scenario.PAGE_URL_MATCH ?? []),
    ...(target?.pageUrlMatch ?? []),
  ]),
];

// where the take begins; an explicit start path is re-applied after any
// off-camera sign-in, which usually redirects elsewhere
const explicitStart = target?.startUrl ?? scenario.START_URL ?? null;
const START_URL = explicitStart ? new URL(explicitStart, APP).href : new URL(APP).href;

const auth = target?.auth && target.auth.mode !== 'none' ? target.auth : null;
const authSel = auth?.selectors ?? {};

// auth selectors from the target fill in the driver's canonical keys; anything
// the scenario declares itself wins
const SEL = {
  ...(authSel.loginHeading && { loginHeading: authSel.loginHeading }),
  ...(authSel.userMenu && { userMenu: authSel.userMenu }),
  ...(authSel.logoutItem && { logoutItem: authSel.logoutItem }),
  ...(authSel.signedIn && { ready: authSel.signedIn }),
  ...(scenario.SEL ?? {}),
};

// Chrome location: CHROME_PATH wins, else the usual Windows/macOS/Linux spots.
// Edge is last-resort — same CDP surface, different default UI chrome.
function resolveChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    ...(process.platform === 'win32'
      ? [
          `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']),
  ].filter(Boolean);

  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `Chrome not found. Set CHROME_PATH. Looked in:\n  ${candidates.join('\n  ')}`,
    );
  }
  return found;
}

const CHROME = resolveChrome();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

console.log(`chrome: ${CHROME}`);
console.log(`app: ${APP}${explicitStart ? ` (starting at ${START_URL})` : ''}`);

const chrome = spawn(
  CHROME,
  [
    `--user-data-dir=${PROFILE}`,
    `--app=${START_URL}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height + 50}`,
    `--remote-debugging-port=${PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--hide-crash-restore-bubble',
    '--disable-session-crashed-bubble',
    // Windows display scaling (125%/150%) otherwise makes innerWidth and the
    // screencast size disagree; pin DPR so every take is byte-comparable
    '--force-device-scale-factor=1',
    // macOS only: profile is copied from a puppeteer-launched Chrome, whose
    // cookies are encrypted with the mock keychain key, so we must match it
    ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []),
  ],
  { stdio: 'ignore' },
);

function killChrome() {
  if (chrome.exitCode !== null || chrome.signalCode !== null) return;
  if (process.platform === 'win32') {
    // chrome spawns a process tree; .kill() only reaps the launcher
    try {
      execFileSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } catch {}
  } else {
    chrome.kill();
  }
}

// Shut Chrome down cleanly, falling back to the hard kill.
//
// This matters more than it looks: Chrome writes cookies and session state to
// disk lazily, and `taskkill /F` loses whatever has not been flushed. Killing
// hard after a take signs the profile out, so the *next* take starts logged
// out — which breaks every flow whose login cannot be scripted (SSO, email
// code) and depends on the profile holding the session.
async function shutdownChrome() {
  try {
    await Promise.race([browser.close(), sleep(10000)]);
  } catch {
    await browser.disconnect().catch(() => {});
  }

  // give the process tree a moment to exit on its own before forcing it
  for (let i = 0; i < 20; i++) {
    if (chrome.exitCode !== null || chrome.signalCode !== null) return;
    await sleep(250);
  }

  killChrome();
}

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      return await puppeteer.connect({
        browserURL: `http://127.0.0.1:${PORT}`,
        defaultViewport: null,
      });
    } catch {
      await sleep(300);
    }
  }
  throw new Error('could not connect to Chrome CDP');
}

const browser = await connect();

async function findAppPage() {
  for (let i = 0; i < 50; i++) {
    const pages = await browser.pages();
    const page = pages.find((p) => PAGE_URL_MATCH.some((m) => p.url().includes(m)));
    if (page) return page;
    await sleep(200);
  }
  throw new Error(`app page not found (matching ${PAGE_URL_MATCH.join(', ')})`);
}

const page = await findAppPage();
await page.bringToFront();

const cdp = await page.createCDPSession();

// Third-party widgets that pop up mid-take (a chat bubble, a survey) cover the
// very controls a flow clicks. A target can keep them from loading at all.
if (target?.blockUrls?.length) {
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: target.blockUrls });
  console.log(`blocking: ${target.blockUrls.join(', ')}`);
}

// App-rendered banners that have nothing to do with the flow ("integration
// disconnected", "notifications are blocked") eat the top of every frame. A
// target can hide them with CSS, on this page and on every page loaded later.
if (target?.hideSelectors?.length) {
  const css = `${target.hideSelectors.join(',\n')} { display: none !important; }`;
  const inject = (rules) => {
    const add = () => {
      const s = document.createElement('style');
      s.dataset.demoHide = '1';
      s.textContent = rules;
      document.documentElement.appendChild(s);
    };
    if (document.documentElement) add();
    else document.addEventListener('DOMContentLoaded', add);
  };
  await page.evaluateOnNewDocument(inject, css);
  await page.evaluate(inject, css);
  console.log(`hiding: ${target.hideSelectors.join(', ')}`);
}

// size window so the viewport is exactly VIEWPORT
for (let i = 0; i < 5; i++) {
  const { innerW, innerH } = await page.evaluate(() => ({
    innerW: innerWidth,
    innerH: innerHeight,
  }));

  if (innerW === VIEWPORT.width && innerH === VIEWPORT.height) break;

  const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: {
      width: bounds.width + (VIEWPORT.width - innerW),
      height: bounds.height + (VIEWPORT.height - innerH),
    },
  });

  await sleep(300);
}

const finalSize = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
console.log('viewport:', finalSize);

if (finalSize.w !== VIEWPORT.width || finalSize.h !== VIEWPORT.height) {
  console.warn(
    `warning: viewport is ${finalSize.w}x${finalSize.h}, wanted ` +
      `${VIEWPORT.width}x${VIEWPORT.height} — cursor telemetry stays correct ` +
      '(it is normalised), but framing will differ from the scenario',
  );
}

await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

// ---- screencast ----
const frames = [];
let frameIdx = 0;

// `rolling` gates capture: pre-take sign-in/sign-out navigate, and without the
// gate those navigations would start the screencast and put the off-camera
// steps at the head of the video
let rolling = false;

cdp.on('Page.screencastFrame', async (ev) => {
  if (rolling) {
    const file = path.join(FRAMES, String(frameIdx).padStart(5, '0') + '.jpg');
    fs.writeFileSync(file, Buffer.from(ev.data, 'base64'));
    frames.push({ ts: ev.metadata.timestamp, file });
    frameIdx++;
  }
  try {
    await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId });
  } catch {}
});

const startCast = () =>
  rolling
    ? cdp
        .send('Page.startScreencast', {
          format: 'jpeg',
          quality: 92,
          maxWidth: VIEWPORT.width * 2,
          maxHeight: VIEWPORT.height * 2,
        })
        .catch(() => {})
    : Promise.resolve();

page.on('framenavigated', (f) => {
  if (f === page.mainFrame()) startCast();
});

// ---- input primitives (every dispatched sample is logged) ----
const samples = [];
const cursor = { x: VIEWPORT.width / 2, y: VIEWPORT.height - 80 };

const log = (type, cursorType = 'arrow') =>
  samples.push({ t: Date.now(), x: cursor.x, y: cursor.y, type, cursorType });

// Narration cues, stamped with the wall clock at the moment the flow reaches
// them. Anchoring to real time is the whole point: how long a beat takes
// varies per run (an assistant thinking, a slow query), so a narration
// timeline authored in advance would drift. assemble.mjs shifts these through
// the same cut maths as the cursor telemetry, so audio stays in sync with cuts.
const narration = [];

async function moveTo(x, y, cursorType = 'arrow') {
  const dist = Math.hypot(x - cursor.x, y - cursor.y);
  const dur = Math.max(350, Math.min(1100, dist * 0.9));
  const steps = Math.max(2, Math.round(dur / 33));
  const from = { ...cursor };

  for (let i = 1; i <= steps; i++) {
    const k = easeInOutCubic(i / steps);
    cursor.x = from.x + (x - from.x) * k;
    cursor.y = from.y + (y - from.y) * k;
    await page.mouse.move(cursor.x, cursor.y);
    log('move', cursorType);
    await sleep(33);
  }
}

// spec resolution: 'btn:Text|Alt' = exact-text clickable, else puppeteer selector.
// Poll-based so cross-origin navigations mid-wait cannot poison a waiter.
const clickableFn = (text) => {
  const wanted = text.split('|');
  const els = [
    ...document.querySelectorAll('button, a, [role="menuitem"], [role="button"]'),
  ];

  return (
    els.find((e) => {
      const t = (e.textContent || '').trim();
      const al = (e.getAttribute('aria-label') || '').trim();
      // avatar-style buttons have no text once their image loads; the
      // accessible name lives on the inner img alt (e.g. user menu)
      const imgAlt = (e.querySelector('img[alt]')?.getAttribute('alt') || '').trim();

      return (
        wanted.some((w) => t === w || al === w || imgAlt === w) &&
        e.getClientRects().length > 0
      );
    }) || false
  );
};

async function findOnce(spec) {
  try {
    if (spec.startsWith('btn:')) {
      const h = await page.evaluateHandle(clickableFn, spec.slice(4));
      const el = h.asElement();
      if (el) return el;
      await h.dispose();
      return null;
    }
    const el = await page.$(spec);
    if (!el) return null;
    return (await el.isVisible().catch(() => false)) ? el : null;
  } catch {
    return null;
  }
}

async function waitSpec(spec, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const el = await findOnce(spec);
    if (el) return el;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${spec}`);
}

async function appears(spec, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await findOnce(spec)) return true;
    await sleep(200);
  }
  return false;
}

// Wait for something to go away. The complement of waitSpec, and the reliable
// way to wait out work of unknown length: a spinner, a "Stop" button, a
// skeleton. Waiting on the *result* text instead means guessing wording.
async function waitGone(spec, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (!(await findOnce(spec))) return;
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${spec} to disappear`);
}

async function center(spec, timeout = 10000) {
  const el = await waitSpec(spec, timeout);
  let box = await el.boundingBox();
  if (!box) throw new Error(`no box for ${spec}`);

  // The mouse is driven by coordinates, so an element below the fold would be
  // clicked at a point off the screen. Bring it into view first — smoothly, so
  // the take shows the page moving rather than jumping — and re-measure.
  const offscreen = box.y < 0 || box.y + box.height > VIEWPORT.height ||
    box.x < 0 || box.x + box.width > VIEWPORT.width;
  if (offscreen) {
    await el.evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    log('move');
    await sleep(900);
    box = await el.boundingBox();
    if (!box) throw new Error(`no box for ${spec} after scrolling it into view`);
  }

  return { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 200) };
}

const d = {
  hold: (ms) => sleep(ms),
  // Non-blocking on purpose: the voice plays over the visuals rather than the
  // flow pausing for it.
  say(text) {
    narration.push({ t: Date.now(), text: String(text) });
  },
  waitSel: (spec, timeout) => waitSpec(spec, timeout),
  waitGone: (spec, timeout) => waitGone(spec, timeout),
  appears: (spec, timeout) => appears(spec, timeout),
  async hoverSel(spec) {
    const c = await center(spec);
    await moveTo(c.x, c.y, 'pointer');
  },
  async clickSel(spec) {
    const c = await center(spec);
    await moveTo(c.x, c.y, 'pointer');
    await sleep(600);
    await page.mouse.down();
    log('click', 'pointer');
    await sleep(80);
    await page.mouse.up();
    log('mouseup', 'pointer');
    await sleep(120);
  },
  // Types at human pace, logging a sample per keystroke so the composited
  // cursor stays parked on the field instead of drifting toward the next beat.
  // The text is never printed — this is what credentials go through.
  //
  // The click is verified before a single key is sent. Without that check,
  // anything that takes the click instead — a toast overlapping the field, an
  // overlay, or a layout shift between measuring the box and clicking it —
  // sends the whole string to whatever else holds focus. That is how a take
  // ends up typing a question into a settings search box and wandering off
  // into pages the flow never meant to touch.
  async type(spec, text, { clear = true } = {}) {
    if (text == null) throw new Error(`nothing to type into ${spec}`);

    let el = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      el = await waitSpec(spec, 15000);

      // re-measure immediately before clicking: the layout may have moved
      // since the previous beat
      const box = await el.boundingBox();
      if (!box) throw new Error(`no box for ${spec}`);

      await moveTo(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200), 'text');
      await sleep(300);

      await page.mouse.down();
      log('click', 'text');
      await sleep(70);
      await page.mouse.up();
      log('mouseup', 'text');
      await sleep(250);

      const focused = await el
        .evaluate((node) => node === document.activeElement || node.contains(document.activeElement))
        .catch(() => false);

      if (focused) break;

      if (attempt === 2) {
        throw new Error(
          `clicking ${spec} did not focus it — something else took the click ` +
            '(a toast or overlay covering the field, or the layout moved). ' +
            'Refusing to type, rather than sending the text to whatever has focus.',
        );
      }

      console.warn(`type: ${spec} not focused after click, retrying once`);
      await sleep(600);
    }

    if (clear) {
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.keyboard.down(mod);
      await page.keyboard.press('KeyA');
      await page.keyboard.up(mod);
      await sleep(80);
    }

    for (const ch of String(text)) {
      await page.keyboard.type(ch);
      log('move', 'text');
      await sleep(55);
    }

    await sleep(200);
  },
  async key(name) {
    await page.keyboard.press(name);
    log('move');
    await sleep(200);
  },
  // `{name}` in the path is filled from the target's secrets, so an internal id
  // (a member's settings URL, say) lives in .env rather than in a committed script.
  async open(where) {
    const filled = String(where).replace(/\{([A-Za-z_]\w*)\}/g, (_, name) => {
      const value = target?.secrets?.[name];
      if (value == null) {
        throw new Error(`open ${where}: target has no secret "${name}" (add it under "secrets", e.g. "env:VAR_NAME")`);
      }
      return encodeURIComponent(value);
    });
    const url = new URL(filled, APP).href;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    log('move');
    await sleep(400);
  },
  async wheel(dy) {
    const chunks = Math.max(1, Math.round(Math.abs(dy) / 40));
    for (let i = 0; i < chunks; i++) {
      await page.mouse.wheel({ deltaY: Math.sign(dy) * 40 });
      log('move');
      await sleep(40);
    }
  },
  async race(map, timeout) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      for (const [key, spec] of Object.entries(map)) {
        if (await findOnce(spec)) return key;
      }
      await sleep(250);
    }
    throw new Error('race: nothing appeared');
  },
  // credentials and other target values, for scenarios that need them directly
  creds: () => requireCredentials(target),
  secret(name) {
    const value = target?.secrets?.[name];
    if (value == null) {
      throw new Error(
        `target has no secret "${name}". Add it under "secrets" in the target file ` +
          '(the value may be "env:VAR_NAME").',
      );
    }
    return value;
  },
  login: () => performLogin({ onCamera: true }),
  logout: () => performLogout({ onCamera: true }),
};

// ---- auth ----

// Off camera we click elements directly and type instantly: no cursor
// telemetry, no pacing, nothing captured. On camera it goes through the same
// primitives a scenario uses, so it looks like the rest of the video.
function authActions(onCamera) {
  if (onCamera) {
    return {
      click: (spec) => d.clickSel(spec),
      type: (spec, text) => d.type(spec, text),
      pause: (ms) => sleep(ms),
    };
  }

  return {
    async click(spec) {
      const el = await waitSpec(spec, 15000);
      await el.click();
    },
    async type(spec, text) {
      const el = await waitSpec(spec, 15000);
      await el.click({ count: 3 });
      await page.keyboard.type(String(text), { delay: 10 });
    },
    pause: () => Promise.resolve(),
  };
}

async function performLogin({ onCamera }) {
  const creds = requireCredentials(target);
  const s = auth.selectors;

  if (!s.username) {
    throw new Error(
      'target auth.selectors.username is not set — the driver needs to know which ' +
        'field takes the username.',
    );
  }

  const act = authActions(onCamera);

  // some apps put the form behind a "Sign in" link on the landing page
  if (s.signInLink && (await findOnce(s.signInLink))) {
    await act.click(s.signInLink);
    await act.pause(600);
  }

  await waitSpec(s.username, 20000);
  await act.type(s.username, creds.username);
  await act.pause(400);

  if (s.password) {
    await act.type(s.password, creds.password);
    await act.pause(500);
  }

  if (s.submit) await act.click(s.submit);
  else await page.keyboard.press('Enter');

  const landed = s.signedIn ?? s.userMenu ?? SEL.ready;
  if (landed) await waitSpec(landed, 45000);

  console.log(`signed in as ${creds.username}${onCamera ? '' : ' (off camera)'}`);
}

async function performLogout({ onCamera }) {
  if (!SEL.userMenu || !SEL.logoutItem) {
    throw new Error(
      'cannot sign out: SEL.userMenu and SEL.logoutItem are not set (scenario SEL ' +
        'or target auth.selectors).',
    );
  }

  const act = authActions(onCamera);

  await act.click(SEL.userMenu);
  await waitSpec(SEL.logoutItem, 8000);
  await act.pause(900);
  await act.click(SEL.logoutItem);

  if (SEL.loginHeading) await waitSpec(SEL.loginHeading, 20000);
  await act.pause(500);
}

// ---- pre-take: put the app in the state the take should start from ----
const canLogout = Boolean(SEL.loginHeading && SEL.userMenu && SEL.logoutItem);
const canLogin = Boolean(auth && auth.selectors?.username);
// only take charge of auth when we can actually move the app between states;
// otherwise fall through to the plain "wait for the first anchor" path
const managesAuth = Boolean(SEL.loginHeading && (canLogout || canLogin));
const wantState = auth?.start === 'signed-in' ? 'app' : 'login';

if (managesAuth) {
  const signedInSpec = SEL.userMenu ?? SEL.ready;

  const state = await (async () => {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      if (await findOnce(SEL.loginHeading)) return 'login';
      if (await findOnce(signedInSpec)) return 'app';
      await sleep(250);
    }
    return null;
  })();

  console.log(`pre-take state: ${state} at ${page.url()}`);

  if (!state) {
    await shutdownChrome();
    throw new Error(`pre-take: neither login nor app UI appeared at ${page.url()}`);
  }

  if (state === 'app' && wantState === 'login') {
    if (!canLogout) {
      await shutdownChrome();
      throw new Error(
        'pre-take: the app is signed in but there is no way to sign out ' +
          '(need SEL.userMenu + SEL.logoutItem). Set auth.start to "signed-in", or ' +
          'delete profile/ for a cold start.',
      );
    }
    console.log('pre-take: logged in, logging out off camera');
    await performLogout({ onCamera: false });
    await sleep(1500);
  }

  if (state === 'login' && wantState === 'app') {
    console.log('pre-take: logging in off camera');
    await performLogin({ onCamera: false });

    // sign-in redirects to the app's landing page; go back to the requested
    // start if the target named one
    if (explicitStart) {
      await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await sleep(1500);
  }
} else if (SEL.ready) {
  // no-auth scenario: just make sure the first beat's anchor is on screen
  await waitSpec(SEL.ready, 30000);
  console.log(`pre-take: ready at ${page.url()}`);
} else {
  console.log(`pre-take: no auth or ready selector, starting at ${page.url()}`);
  await sleep(1500);
}

// ---- take ----
try {
  rolling = true;
  await startCast();
  await sleep(800); // first frames land, establishes t0 before any action

  const t0wall = Date.now();
  console.log('take started');

  await run(d);

  await sleep(500);
  await cdp.send('Page.stopScreencast').catch(() => {});
  rolling = false;

  console.log(
    `take done: ${frames.length} frames, ${samples.length} samples, ${Date.now() - t0wall}ms`,
  );

  fs.writeFileSync(
    path.join(OUT, 'frames.json'),
    JSON.stringify(frames.map((f) => ({ ts: f.ts, file: f.file })), null, 1),
  );

  fs.writeFileSync(
    path.join(OUT, 'actions.json'),
    JSON.stringify({ viewport: VIEWPORT, samples, narration }, null, 1),
  );

  if (narration.length) console.log(`narration: ${narration.length} cues`);
} finally {
  await shutdownChrome();
}

process.exit(0);
