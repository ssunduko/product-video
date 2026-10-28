# Demo video pipeline

Turns a plain-English product flow into a polished MP4. A CDP-driven Chrome
walks the flow while frames and input are captured, ffmpeg assembles the frames
into a variable-rate video, zoom regions are derived from the click telemetry,
and a compositor renders the finished video — eased zoom and pan, a synthesized
cursor, and a styled window frame.

## Layout

```
./                  repo root — every path in this README is relative to it
  pipeline/
    driver.mjs      launches Chrome, runs a flow, captures frames + input telemetry
    target.mjs      loads a target: app URL + credentials
    script.mjs      compiles a plain-text script into a scenario module
    assemble.mjs    frames -> raw.mp4 (+ raw.mp4.cursor.json), applies cuts / fast-forwards
    project.mjs     click telemetry -> <take>.recordly (one zoom region per click cluster)
    compose.mjs     <take>.recordly + video -> final.mp4 (zoom, cursor, window frame)
    narrate.mjs     say-cues -> speech, muxed onto the video (optional)
    tighten.mjs     removes dead air: frozen + silent stretches, and the tail
    cards.mjs       branded intro/outro cards, joined onto the video (optional)
    author.mjs      observed trace -> .demo + selector sidecar; sizes narration
                    to measured waits (see "Generating the whole script from
                    plain English")
    brand.mjs       StyleGuide.txt -> colours and fonts, shared by every stage
    tts.mjs         shared text-to-speech provider + clip cache
    qa.mjs          quality gate: overlap, sync, dead air, frozen/loading, lineage
    build.mjs       one command per video: record + render + gate each part, join
    paths.mjs       where stages read/write (DEMO_OUT, default out/)
    publish.mjs     publishes a finished video after final approval: Drive upload,
                    video state, Jira comment (see "Publish a finished video")
    memory.mjs      project memory: feature catalogs, source diffs, sync lock, Zep
                    (see "Project memory")
  targets/
    signed-in.json          template for an app that needs sign-in
    local-app.json          the Express app in sample-app/
    <name>.local.json       credentials — gitignored
  input/                    START HERE: the text description of each video
    _template.flow          copy to <name>.flow and write your steps
    <name>.flow             plain English, one step per line — the human input
  scenarios/                what the walk OBSERVED, and hand-written scenarios
    <name>.trace.json       the observed walk of input/<name>.flow: selectors +
                            measured wait times
    grammar-tour.trace.json example trace: every step op author.mjs reads,
                            annotated (authors to grammar-tour-trace.demo)
    <name>.mjs              hand-written scenarios, when a flow needs real
                            control flow — see "b. A scenario" below
  videos/                   one manifest per finished video: its parts, settings,
                            and how they join (see "Build a whole video")
    grammar-tour.json       example manifest, annotated: records the example
                            trace against the sample app
  scripts/                  what gets EXECUTED: the DSL, generated or hand-written
    <name>.demo             generated from scenarios/<name>.trace.json
    <name>.selectors.json   its sidecar — must sit beside the .demo (see below)
    grammar-tour-trace.demo generated from scenarios/grammar-tour.trace.json
    grammar-tour.demo       plain-text flow, every command documented
    signed-in-tour.demo     a flow that signs in on camera
  brand/
    StyleGuide.txt          brand colours and fonts, read by brand.mjs
                            (compose.mjs paints the frame with them too)
    *logo-white.png         the logo on the title cards (the first match)
    *.ttf / *.otf           optional: brand font files, registered at render time
  docs/             C4 architecture model and its renderings
  sample-app/       a small Express app to record against (npm install && npm start)
  sample/           model videos new ones should match: cards, outro, pacing
  memory/           what the project has learned: rules.md (imported by CLAUDE.md), and
                    features/<app>/<feature>.md linking each feature to its videos
  .env.example      template for .env — copy and fill in
  .env              optional, gitignored: KEY=VALUE for env: references in targets
  out/              generated: frames/, frames.json, actions.json, *.mp4, <take>.recordly
  profile/          generated: the Chrome user-data-dir the takes run under
```

Everything inside `out/` (the folder itself stays, via `out/.gitkeep`), plus
`profile/`, `.env` and `targets/*.local.json`, is gitignored. Note what
that means for `scenarios/*.trace.json`: it is the one artifact here that cannot
be rebuilt from anything else, which is why it lives in `scenarios/` and not in
`out/`.

**Architecture diagrams** are in [`docs/`](docs/C4.md) — C4 at three
levels, with a component diagram for every stage including `author.mjs`.
`docs/C4.md` reads anywhere; the same model is also published as C4-PlantUML
(`docs/c4-*.puml`) and a StarUML project (`docs/ProductVideo-C4.mdj`). All three
are generated from `docs/c4-model.mjs` — change the model there and re-run
`node docs/c4-model.mjs`; do not edit an output.

Three pieces, separable on purpose:

| Piece | Answers | Lives in |
|-------|---------|----------|
| **target** | *which* deployment, and how to sign in | `targets/<name>.json` |
| **flow** | *what* to do on screen | `input/<name>.flow` (plain English) or `scripts/<name>.demo` |
| **pipeline** | how it becomes a video | `pipeline/*.mjs` |

**`input/` and `scenarios/` are what you author; `scripts/` is what runs.** A
plain-English `.flow` in `input/` and the `.trace.json` observed from walking it
in `scenarios/` are inputs — hand-written,
diffable, the things worth arguing about in review. The `.demo` is generated from
the trace and can be thrown away and rebuilt; `node pipeline/author.mjs --check`
fails while a committed one differs from what its trace generates. Keeping them apart stops the
question "is this file the source or the output?" from ever coming up.

The one exception is `<name>.selectors.json`, which stays in `scripts` beside
its `.demo`: `script.mjs` finds it by swapping the extension on the script path,
so moving it breaks compilation. It is generated alongside the `.demo` from the
same trace, so it belongs on the generated side anyway.

Keeping the target separate means the same flow records against localhost,
staging or a customer sandbox by swapping `--target`, and means credentials
never appear in a flow file.

## Prerequisites

| What | Status here | Notes |
|------|-------------|-------|
| Node 22.12+ | ✅ v24.1.0 | required by puppeteer-core 25 |
| Chrome | ✅ `C:\Program Files\Google\Chrome\Application\chrome.exe` | auto-detected; override with `CHROME_PATH` |
| ffmpeg + ffprobe | ✅ 9.0 (Gyan build, via winget) | installed to `%LOCALAPPDATA%\Microsoft\WinGet\Packages\`. Override with `FFMPEG` / `FFPROBE` |
| `pipeline/node_modules` | run `npm install` in `pipeline/` | pulls `puppeteer-core` and `@napi-rs/canvas` |

ffmpeg was installed by winget, which edits PATH — a shell opened **before** the
install will not see it until restarted.

The app you are recording must already be running. The pipeline never starts
your dev server; if it is down, start it yourself first.

## Usage

### Build a whole video with one command

A video is described by a manifest in `videos/<name>.json`: its parts (one take
each, in order), the settings every stage runs with, and how the parts are
joined. `build.mjs` records and renders every part into its own folder,
gates each on `qa.mjs`, joins them and gates the result:

```powershell
cd pipeline
node build.mjs ..\videos\grammar-tour.json                       # the annotated example
node build.mjs ..\videos\<name>.json --only member               # rebuild one part
node build.mjs ..\videos\<name>.json --only member --no-record   # re-render it, no Chrome
node build.mjs ..\videos\<name>.json --join-only                 # just re-join and re-check
```

```jsonc
{
  "name": "<name>",
  "output": "out/<name>.mp4",
  "env": { "ZOOM_DEPTH": "2", "AUTO_SPEED": "10" },   // every stage of every part
  "crossfadeS": 0.75,
  "leadS": 0.6, "tailS": 1.6,     // silence kept either side of a join
  "parts": [
    { "name": "admin",  "script": "scripts/...-admin.demo",  "before": "printed before the take" },
    { "name": "member", "script": "scripts/...-member.demo", "before": "..." }
  ]
}
```

- **Per-part folders.** Each part builds in `out/<name>/<part>/` (the stages
  honour `DEMO_OUT`), so one take never overwrites another's `raw.mp4`,
  `final.mp4`... The TTS cache stays shared in `out/tts`.
- **Joins are measured, not hand-picked.** A part keeps `tailS` of silence after
  its last word and the next keeps `leadS` before its first; they crossfade for
  `crossfadeS`.
- **It stops on the first failed gate** and says which part to fix and how to
  rerun. `--no-gate` keeps going (failures are still reported).
- The visual review still belongs to the **video-qa** agent: the build prints the
  stills folders to hand it.
- A record of what was built — trims, per-part verdicts — is written to
  `out/<name>/build.json`.
- **Every build is recorded as the video's state.** That covers a build that
  finished, one that failed the quality gate, and one that failed outright.
  `build.mjs` writes `memory/features/<app>/<name>.state.json`, next to the page
  that names the manifest:
  - the status;
  - the last build: outcome, scope, output, length;
  - qa counts per part and for the joined video;
  - a history.

  It regenerates the page's "Video status" section from that file. It sends
  the file to the app's Zep graph, and posts the whole status to the video's
  thread: the builds, qa counts, review findings and history. So the state is
  in the video's session and in its user's graph, not only the app graph. Record the visual review with
  `node memory.mjs video review <name> PASS|FAIL --findings <file>`. The status
  then reads one of: not built, build failed, qa failed, awaiting review,
  review failed, done, accepted or published. `node memory.mjs video state <name>` prints it.
  When the user takes a build that did not pass both gates, record it with
  `node memory.mjs video accept <name> --reason "<their words>" --findings <file>`:
  the status reads accepted, with the reason and the open findings, and
  `publish.mjs` allows it. It is never recorded as a PASS, and a later build
  needs both gates or a new acceptance.

### Run the stages yourself

Every stage is a script in `pipeline`, run from that directory. Each one also
has an npm alias, which is the quickest way to see what stages exist:

```powershell
cd pipeline
npm run                    # lists them all
```

| Step | Stage | npm alias | Reads | Writes |
|------|-------|-----------|-------|--------|
| 2 | `script.mjs` | `npm run compile` | `scripts/*.demo` | `scenarios/*.mjs` |
| 3 | `driver.mjs` | `npm run record` | a flow + a target | `out/frames/`, `actions.json`, `frames.json` |
| 4 | `assemble.mjs` | `npm run assemble` | `frames.json`, `actions.json` | `out/raw.mp4` (or `cut.mp4`) + telemetry |
| 6 | `project.mjs` | `npm run project` | `<take>.cursor.json` | `out/<take>.recordly` |
| 7 | `compose.mjs` | `npm run compose` | the take + the project | `out/final.mp4` |
| 8 | `narrate.mjs` | `npm run narrate` | `final.mp4` + cues | `out/final-narrated.mp4` |
| 9 | `tighten.mjs` | `npm run tighten` | `final-narrated.mp4` | `out/final-narrated-tight.mp4` |
| 10 | `cards.mjs` | `npm run cards` | the newest stage + `brand` | `out/*-carded.mp4` |
| 11 | `qa.mjs` | `npm run qa` | the deliverable, the narrated take, the cues | `out/qa/qa.json` + stills; exit 1 on a failure |
| — | `author.mjs` | `npm run author` | `scenarios/*.trace.json` | `scripts/*.demo` + `*.selectors.json` |
| — | `build.mjs` | `npm run build` | `videos/<name>.json` | every stage of every part, then the joined video |

Every stage reads and writes the folder in `DEMO_OUT` (default `out/`); that is
how `build.mjs` gives each part its own. The driver talks to Chrome on
`CDP_PORT` (default 9333) while a take runs — localhost only, but any local
process can reach a signed-in session through it for that time.

> **Passing a flag through npm on Windows: quote the separator.** In PowerShell,
> `npm run tighten -- --dry-run` **silently runs the real thing** — PowerShell
> consumes the bare `--` as its own end-of-parameters token, so npm never
> forwards it and the stage never sees `--dry-run`. There is no error; you just
> get a render you did not ask for. Write `npm run tighten '--' --dry-run`, or
> skip the alias and call the stage directly:
>
> ```powershell
> node tighten.mjs --dry-run          # always works, every shell
> ```
>
> The steps below use the `node` form for that reason. The npm aliases are for
> the no-argument case and for discovery.

### 1. Point at an app (optional: with credentials)

A **target** says where to record and how to sign in. It is optional — a
scenario can carry its own `APP` — but it is how you record the same flow
against another deployment, and the only place credentials belong.

Copy `targets/signed-in.json` to `targets/<name>.json` and edit it:

```json
{
  "app": "https://app.example.com",
  "startUrl": "/",
  "viewport": { "width": 1440, "height": 810 },
  "pageUrlMatch": ["auth.example.com"],

  "auth": {
    "mode": "form",
    "start": "signed-out",
    "username": "env:DEMO_USERNAME",
    "password": "env:DEMO_PASSWORD",
    "selectors": {
      "signInLink": "btn:Sign in",
      "username": "input[name=\"email\"]",
      "password": "input[type=\"password\"]",
      "submit": "btn:Log in",
      "signedIn": "::-p-text(Dashboard)",
      "userMenu": "btn:Jane Doe|JD",
      "logoutItem": "btn:Log out",
      "loginHeading": "::-p-text(Welcome back)"
    }
  },

  "secrets": { "workspaceId": "env:DEMO_WORKSPACE_ID" }
}
```

Everything except `app` is optional. Selector strings use the same grammar as a
scenario (`btn:Exact Text` or a puppeteer selector). Keys starting with `//` are
treated as comments.

Three more options shape the browser a take records in:

| Option | Does |
|--------|------|
| `"profile": "profile-member"` | record from this Chrome profile instead of `profile/` — one signed-in user per profile, so a video can show two users without anyone signing in on camera |
| `"blockUrls": ["*intercom.io*"]` | keep these from loading during the take (CDP `Network.setBlockedURLs`): chat bubbles and surveys that pop up over the controls a flow clicks |
| `"hideSelectors": ["[aria-label^=\"AlertBanner\"]"]` | hide these with CSS on every page of the take: app banners that have nothing to do with the flow |

`auth.start` decides what the take opens on:

| `start` | Before rolling camera | Use when |
|---------|----------------------|----------|
| `signed-out` (default) | signs out off camera if needed | the demo shows signing in — add a `login` step |
| `signed-in` | signs in off camera if needed | the demo starts inside the app |

Nothing before the take is recorded, so the off-camera sign-in or sign-out never
appears in the video.

**Credentials never go in the committed file.** Any string may be written as
`env:VAR_NAME` and is read from the environment. Put the values in whichever of
these suits you — all three are gitignored or ephemeral:

```powershell
# a) targets/<name>.local.json — deep-merged over targets/<name>.json
#    { "auth": { "password": "hunter2" } }

# b) .env — KEY=VALUE, read automatically
#    DEMO_PASSWORD=hunter2

# c) the shell, for a one-off
$env:DEMO_USERNAME='demo@acme.com'; $env:DEMO_PASSWORD='hunter2'
```

`DEMO_APP`, `DEMO_USERNAME` and `DEMO_PASSWORD` also work with **no target file
at all** — enough to point an existing flow somewhere else for one run:

```powershell
$env:DEMO_APP='https://staging.example.com'; node driver.mjs ..\scenarios\tour.mjs
```

Precedence, later wins: scenario exports → `targets/<name>.json` →
`targets/<name>.local.json` → `/.env` → `DEMO_*` variables.

The driver prints the resolved target when it starts. Usernames are printed (they
appear on camera during an on-camera sign-in anyway); passwords never are.

### 2. Describe the flow

Two ways, same result — a script compiles into a scenario, so you can start with
a script and drop to a scenario when you need real control flow.

#### a. A script (`scripts/<name>.demo`)

Plain text, one command per line. `scripts/grammar-tour.demo` documents every
command; `scripts/feature.demo` is a real flow.

```
target: acme-staging

selectors:
  dashboard = text "Dashboard"
  settings  = button "Settings"

beat Sign in
  login
  wait @dashboard within 30s
  hold 2s

beat Settings
  click @settings
  hover text "Members"
  hold 1.5s

beat Done
  logout
  hold 2s
```

Header directives, all optional, all before the first beat: `name`,
`description`, `target`, `app`, `start` (start path), `viewport` (`1440x810`),
`match` (comma-separated extra hosts), and `selectors:` opening a block of
`name = <selector>` definitions.

Selectors — `button "Text"` (exact text / aria-label / inner `img[alt]`; use
`button "A" or "B"` for alternatives), `text "Text"`, `css <raw selector>`,
`ask "description"` (below), or `@name` for one defined above. A bare `"Text"`
defaults to a button for `click` and to text everywhere else.

#### Generating the whole script from plain English

You do not have to write a `.demo` at all. Describe the flow in ordinary
language and let the **author-demo** skill walk the real app through the Claude
in Chrome extension, recording what it finds:

```
input/<name>.flow          plain English, one step per line — you write this
        │
        ▼   Claude drives your browser, timing every wait
scenarios/<name>.trace.json    selectors + MEASURED wait times
        │
        ▼   node author.mjs ../scenarios/<name>.trace.json
scripts/<name>.demo  +  scripts/<name>.selectors.json     generated
```

The trace is the interesting artifact: it records, per step, the element, the
selector it answers to, and **how long the wait actually took**. `author.mjs`
turns that into the DSL — sizing the narration to each measured wait, deriving
the holds from real speech lengths, reporting any line that would not fit, and
emitting a ready-to-paste `SPEEDS_MS` range for whatever narration cannot cover.

That last part is the reason this is code and not a prompt. A hand-written
script guesses how long the app takes, and guessing low is not a small error —
narration stops, the screen keeps moving, and the video is silent for the
difference. Both scripts here were written with `hold 7s` against generation
that measured 36.6s in one run and 43s in the next, and both shipped
double-digit silences that had to be found and fixed afterwards.

Supply *more* narration lines than you think will fit; the generator places what
the measurement allows and tells you what it dropped.

**Define each selector once.** A trace's top-level `selectors` table gives each
element a name with its `intent`, `spec` and `evidence`. Steps then say only
`"name": "heading"`, and a step's own intent/spec/evidence override the table.
`scenarios/grammar-tour.trace.json` shows the shape. A step that names a
selector missing from the table is an error, not a guess.

**Generated scripts are checked against their traces.** A trace's script lives at
`scripts/<trace name>.demo`, and `node pipeline/author.mjs --check` re-authors
every `scenarios/*.trace.json` in memory and fails if a committed script or
sidecar is missing or different. It also fails if a `.demo` says it was
generated but no trace has its name. Line endings are ignored. The check runs in
the pre-commit hook and on every PR (`.github/workflows/docs.yml`), so change the
trace and regenerate, never the `.demo`.

**Start from the template.** `input/_template.flow` lists the header fields
(`name`, `description`, `target`, `intro`, `outro`) and the step shapes the
author understands. Copy it, fill it in, then ask Claude to author it:

```powershell
cp input\_template.flow input\my-feature.flow
# edit it, then ask Claude: "author a demo from input/my-feature.flow"
```

#### Natural-language selectors

Every selector kind above is a hardcoded handle onto the DOM, and that is the
most brittle thing in a script. `btn:` needs the text exact. An avatar button
flips between initials and an alt-named image. A redesign invalidates the lot.
And when the app writes its own copy — a model's answer, say — the wording is
different on every run, which is why the anchors in `feature.demo` had to be
rewritten to wait on *completion* rather than on text.

`ask` states the intent instead:

```
selectors:
  composer = ask "the message box at the bottom of the chat"
  results  = ask "the results table in the main answer area"
```

The concrete selector is found by driving the real app through the **Claude in
Chrome extension** — your browser, your session, no SSO ritual — and written to
a sidecar next to the script:

```powershell
node script.mjs ..\scripts\<name>.demo --intents   # what needs resolving
# then ask Claude: "resolve the selectors for <name>.demo"
```

```jsonc
// scripts/<name>.selectors.json
{
  "resolvedAgainst": "https://claude.ai/new",
  "selectors": {
    "the message box at the bottom of the chat": {
      "spec": "div[data-testid=\"chat-input\"]",
      "evidence": "contenteditable tiptap div, aria-label 'Write a message', 1 match, visible"
    }
  }
}
```

Keyed by the intent text, so renaming a selector or reordering the block does
not orphan a resolution. After a redesign, delete the stale key and re-resolve —
the `.demo` itself does not change.

**Resolution happens before the take, never during it**, and that is not a
preference. `driver.mjs` stamps narration cues at wall-clock time while the
screencast runs, so the take's timing *is* the video timeline: a model round
trip mid-run would land in the finished video as dead air, and no two takes
would cut the same way. Resolved up front, the take is deterministic and
full-rate, and the sidecar is a reviewable artifact rather than a decision made
live and forgotten.

An unresolved intent is a **compile error**, before Chrome is launched:

```
2 selector(s) still state an intent and have no resolution:
  composer = ask "the message box at the bottom of the chat"
```

That is deliberate. Guessing a selector from a description does not fail here —
it fails mid-take, after the browser is up and the recording has started, which
is the expensive place to fail.

Commands:

| Command | Does |
|---------|------|
| `beat <label>` | a comment marking the next beat |
| `wait <sel> [within 15s]` | wait for something to appear |
| `wait <sel> gone [within 60s]` | wait for something to **disappear** — a spinner, a Stop button, a skeleton |
| `say "..."` | a narration line, timestamped here and voiced by `narrate.mjs`. Does not pause the flow |
| `click <sel>` | glide the cursor over and click (an off-screen element is scrolled into view first) |
| `hover <sel>` | glide the cursor over; compose frames the element in red |
| `park <sel>` | glide the cursor over without the red frame: for moves that only keep the cursor in place |
| `hold 2s` / `hold 800ms` | pause on camera |
| `type "text" into <sel>` | click the field and type at human pace |
| `type secret <name> into <sel>` | same, with a value from the target's `secrets` |
| `press Enter` / `key Enter` | a key press (`key` is an alias) |
| `scroll down [px]` / `scroll up [px]` | scroll (default 240) |
| `open /path` | navigate without clicking. `{name}` in the path is filled from the target's `secrets`, so an internal id stays in `.env`: `open /settings/members/{memberId}/permissions` |
| `login` / `logout` | sign in or out **on camera**, using the target's credentials |
| `if <sel> appears [within 20s]` … `end` | optional beat — consent screens, first-run tips |
| `note <text>` | a comment carried into the generated scenario as `// <text>` |

Header directive for where the take opens: `start: /path` overrides the
target's `startUrl` (one target serves many flows), and fills `{name}` from the
target's `secrets` just like `open`: `start: /chatbot/{agentId}/config`. The
`ready` selector is then waited for off camera on that page. A trace's
`startUrl` becomes this line when `author.mjs` writes the script.

Header directives for the title cards (read by `cards.mjs`, not the driver):

| Directive | Meaning |
|-----------|---------|
| `intro: Headline \| Subhead` | opening card; both lines appear and are read aloud |
| `outro: Headline \| Subhead` | closing card |

Comments start with `#` at the start of a line or surrounded by spaces, so
`css #search` keeps its id.

Compile it to look at, or hand-edit, the generated scenario:

```powershell
cd pipeline
node script.mjs ..\scripts\<name>.demo          # -> scenarios/<name>.mjs
node script.mjs ..\scripts\<name>.demo --print  # to stdout
```

It refuses to overwrite a scenario it did not generate (pass `--force`).

#### b. A scenario (`scenarios/<name>.mjs`)

Reach for this only when the flow needs real control flow — loops, branching
beyond `if <sel> appears`, anything computed. A `.demo` covers the rest and
compiles to a file exactly like this one.

A scenario exports `SEL` and `run(d)`, plus optional `APP`, `VIEWPORT`,
`PAGE_URL_MATCH`, `START_URL` and `TARGET` (a default target name). `APP` is
required only when no target supplies one. The whole skeleton:

```js
// scenarios/<name>.mjs
// Record with: cd pipeline/ && node driver.mjs ../scenarios/<name>.mjs

export const VIEWPORT = { width: 1440, height: 810 };
export const APP = 'http://localhost:3000';   // only if no target supplies one

// export const TARGET = 'local-app';         // default target for this flow
// export const START_URL = '/pricing';       // where the take opens
// export const PAGE_URL_MATCH = ['accounts.google.com'];  // only if the flow leaves the origin

export const SEL = {
  // The anchor the driver waits on before rolling camera. Prefer real content
  // text over a heading that renders before the data does.
  ready: '::-p-text(Express)',

  // Supply userMenu + logoutItem + loginHeading — here or via the target's
  // auth.selectors — and the driver puts the app in the state `auth.start`
  // asks for, off camera, before the take.
  // userMenu: 'btn:Jane Doe|JD',
  // logoutItem: 'btn:Log out',
  // loginHeading: '::-p-text(Welcome back.)',
};

export async function run(d) {
  await d.waitSel(SEL.ready, 15000);
  await d.hold(2500);

  // ...beats. d.say('...') records a narration cue at this moment.

  await d.hold(2000);   // end on a hold so the last zoom can settle
}
```

Recon the flow in a real browser first and note, for every click target, its
**exact** trimmed text or aria-label, and for every page a unique anchor text to
wait on. Verify each beat exists before writing it — a `btn:` spec that is one
character off just times out.

Selector specs:

- `btn:Exact Text|Alt` — matches `button` / `a` / `[role=menuitem]` /
  `[role=button]` by exact trimmed `textContent`, `aria-label`, or inner
  `img[alt]`. `|` separates alternatives.
- anything else — a puppeteer selector. `::-p-text(unique substring)` is the
  usual choice for hover and wait anchors.

Driver primitives:

| Primitive | Does |
|-----------|------|
| `d.hold(ms)` | pause on camera |
| `d.waitSel(spec, timeout)` | wait for a spec, throws on timeout |
| `d.waitGone(spec, timeout)` | wait for a spec to disappear, throws on timeout |
| `d.say(text)` | record a narration cue at this moment (non-blocking) |
| `d.appears(spec, timeout)` | same, but returns `true`/`false` |
| `d.hoverSel(spec, { frame })` | glide the cursor to a spec; `frame: false` skips the red frame |
| `d.clickSel(spec)` | glide, pause, click |
| `d.type(spec, text)` | click a field and type at human pace |
| `d.key(name)` | press a key |
| `d.wheel(px)` | scroll (positive = down) |
| `d.open(path)` | navigate, relative to the app |
| `d.race({key: spec}, timeout)` | first spec to appear wins; returns its key |
| `d.login()` / `d.logout()` | sign in/out on camera with the target's credentials |
| `d.creds()` | `{username, password}` from the target, throws if unset |
| `d.secret(name)` | a value from the target's `secrets` |

Pace beats at 1–2.5s holds with hovers on rows. **Every click becomes a zoom
region downstream**, so a click you do not want zoomed is better expressed as a
hover.

Flows run against live data: never click anything that creates, modifies or
deletes unless the flow explicitly asks for it.

If `SEL` contains `userMenu` + `logoutItem` + `loginHeading` — directly, or via
a target's `auth.selectors` — the driver puts the app in the state
`auth.start` asks for before the take. Without them it waits on `SEL.ready`.

### 3. Record

```powershell
cd pipeline
node driver.mjs ..\scripts\<name>.demo --target <name>     # script
node driver.mjs ..\scenarios\<name>.mjs --target <name>    # scenario
```

`--target` is optional: the driver also honours `DEMO_TARGET`, a `target:`
header in the script, or a `TARGET` export in the scenario. A script is compiled
to `out/generated/<name>.mjs` on the way in, and the path is printed.

A Chrome window opens and runs the flow (roughly flow length + 15s). Writes
`out/frames/`, `out/frames.json`, `out/actions.json`. `actions.json` holds the
cursor samples, the narration cues, every wait, and the box of each element a
hover, click or type acted on (`targets`), which compose frames in red.

### 4. Assemble and inspect

```powershell
node assemble.mjs
```

Writes `out/raw.mp4`, `out/raw.mp4.cursor.json` and
`out/raw.mp4.highlights.json` (the element boxes, on the video's clock), and prints the largest
inter-frame gaps — the video freezes there. Frames the screencast stamped
earlier than the frame before them are dropped (it prints how many): kept,
each one pushed the rest of the picture later than the narration, up to 3s by
the end of a take. Spot-check beats:

```powershell
ffmpeg -ss 12.5 -i ..\out\raw.mp4 -frames:v 1 ..\out\f.png
```

### 5. Shorten the long waits (automatic, or by hand)

**Automatic: `AUTO_SPEED=<factor>`.** The driver logs every wait the flow makes
— an `open`, a `wait ... `, a `wait ... gone` — with its real start and end in
`actions.json`. With `AUTO_SPEED` set, `assemble.mjs` plays every wait of at
least `AUTO_SPEED_MIN_MS` (default 2000) that has no narration over it at
`<factor>`:

```powershell
$env:AUTO_SPEED='10'; $env:OUT_NAME='cut.mp4'; node assemble.mjs
# auto-speed x10: 4.9-8.4s, 36.2-43.0s
```

A range never covers a line: it starts only after the previous line has
finished speaking (its real length from the TTS cache, or the author's slow
estimate before narration exists) and ends before the next starts, so speeding
the picture cannot pull two lines onto each other. Hand-written `SPEEDS_MS` and
`CUTS_MS` win where they overlap. A page load that took 22s on the day costs
about two seconds of video. Takes recorded before the driver logged waits have
none; re-record them.

**By hand** — for a stretch you want dealt with *before* zoom regions are
derived from it.
Routine dead air does not belong here: step 9 finds and removes it automatically
once the narration is on the timeline, and knows the difference between an empty
pause and a shot the voiceover is playing over. This step is for the two things
step 9 cannot judge.

**Prefer `SPEEDS_MS`.** It keeps every frame and plays the span faster:

```powershell
$env:SPEEDS_MS='[[30000,138000,15]]'; $env:OUT_NAME='cut.mp4'; node assemble.mjs
```

**`CUTS_MS` drops the frames outright.** Right for something with no content —
a redirect spinner, a misfire in the take:

```powershell
$env:CUTS_MS='[[4200,7300]]'; $env:OUT_NAME='cut.mp4'; node assemble.mjs
```

The difference matters more than it looks, and the case that proves it is a
model writing an answer. That wait is long — two minutes here — but it is not
empty: the answer arriving *is* the payoff of the demo. Cut across it and the
viewer lands on a finished table having never seen it appear, which is a worse
video than the one with the wait still in. Fast-forwarded at 15x the same span
costs eight seconds and reads as a deliberate fast-forward.

Both go through one `warp()` that moves frames, cursor telemetry and narration
cues together. Always shorten in the assembler, never with editor trims —
otherwise the three drift apart.

**Finding the ranges.** The gap report only sees a *frozen* screen, so it will
not find a generation wait: streaming text is motion. Read the cue spacing in
`out/*.narration.json` instead — a 100s hole between two cues is a wait, and its
bounds are roughly `previous cue end` to `next cue start`.

### 6. Generate zoom regions

```powershell
node project.mjs
```

Writes `out/<take>.recordly`, named after the script the take ran
(`scripts/acme-tour.demo` -> `acme-tour.recordly`; `driver.mjs` stores
the name in `actions.json`, and a take recorded before that falls back to
`demo.recordly`) — one zoom region per click cluster (clicks under
2.5s apart merge), derived from the cut telemetry. Review the printed regions
and hand-edit the JSON if framing needs it, e.g. a region crossing a cut
boundary or focus too tight on a corner. Explicit regions beat any auto-zoom.

Each region carries a `focusTrack`: every click position in the cluster, not
just the last. A merged region can span clicks far apart on screen, and the
compositor pans between them instead of framing only the final one.

### 7. Compose

```powershell
node compose.mjs
```

Defaults to `out/<take>.recordly` and writes `out/final.mp4`. Override with
`node compose.mjs <project.recordly> -o <output.mp4>`.

This is the step that replaces Recordly. It renders every frame itself:

- **Zoom and pan** — each region eases in over ~500ms, holds, eases out. Focus
  is clamped so zooming never reveals the background behind the video. Within a
  held zoom the view pans between click positions, timed off the telemetry so it
  travels *with* the cursor rather than jumping after it.
- **Cursor** — synthesized from `*.cursor.json`, so the capture needs no real
  cursor. Arrow and pointing-hand variants, with a click ripple and a slight
  press. Drawn at constant size in output space, clipped to the window.
- **Highlight** — a red rounded rectangle around the visible part of the
  element each hover, click and type acts on (the driver hit-tests the box, so
  a table running under a side panel is framed only where it shows, and the
  cursor aims at that part), from `*.highlights.json` (assemble writes it from the
  boxes the driver measured). A click is framed from the moment the cursor
  arrives until the button is released (it often closes its card or dialog), a typed field for the whole typing (re-measured after each key, so the frame grows with an input that wraps), and
  a hovered element, which is how a trace points at what the next line is
  about, until the flow does something else, capped at `HIGHLIGHT_HOLD_MS`
  (default 4000). It fades in and out, follows the zoom and pan, and sits
  under the cursor. `HIGHLIGHT=0` turns it off, `HIGHLIGHT_COLOR` sets the
  colour (default `#E5322D`). Takes recorded before 2026-10-28 have no boxes,
  so they render without it: re-record to get it.
- **Window frame** — the video inset with padding, rounded corners, a drop
  shadow, over a gradient background.

Frames stream ffmpeg → canvas → ffmpeg; nothing intermediate hits disk. Expect
roughly **4-5x the video's length** at 1080p60 — measured here at 77s for a 20s
clip, 387s for 95s, and 1490s for 300s (~14 composited frames/sec). Budget for
it: anything over about two minutes of video will outlast a 10-minute shell
timeout, so run this step in the background.

Tune the look via an optional `editor.frame` block in the project file — all
fields optional:

```json
"frame": {
  "padding": 64,
  "radius": 16,
  "shadow": true,
  "background": ["#232a3b", "#0d1017"],
  "rampMs": 500,
  "panMs": 700,
  "cursor": { "show": true, "scale": 1 }
}
```

Env overrides: `NO_FRAME=1` (bare video, no padding/rounding/shadow),
`PADDING=<px>`, `X264_PRESET`, `X264_CRF`, `HIGHLIGHT=0`, `HIGHLIGHT_COLOR`.

Zoom `depth` maps 1–5 to 1.25×, 1.5×, 1.75×, 2×, 2.5×; `project.mjs` emits
depth 3.

### 8. Narrate (optional)

`say "..."` lines in a script become timestamped narration cues. Render and mux
them onto the composed video:

```powershell
node narrate.mjs                 # out/final.mp4 -> out/final-narrated.mp4
node narrate.mjs --dry-run       # print cue times only, no audio, no API calls
```

Anthropic has no text-to-speech API, so this calls a third party. The provider
is chosen by `DEMO_TTS`, else by whichever key is set — `ELEVENLABS_API_KEY`
(best voice quality) or `OPENAI_API_KEY` (cheaper, close). Keys resolve through
the same path as every other credential: your shell or `/.env`, never a
committed file. Pick a voice with `DEMO_TTS_VOICE`.

Why cues are timestamped at record time rather than authored on a timeline:
beat length varies per run — an assistant thinking, a slow query — so a
narration timeline written in advance drifts. `assemble.mjs` puts cues through
the same cut/shift maths as the cursor telemetry, so `CUTS_MS` moves the voice
with the picture instead of desyncing it.

**Where to put a `say`.** `wait <sel> gone` blocks for however long the app
takes, so ordering alone cannot place a line *during* that wait. The pattern
that holds up:

```
beat 15 - Totals land
  say "Credit usage for the month, split by category."              # process line
  hold 6s
  say "A third question, a third endpoint - credit usage analytics."  # covers the wait
  hold 6s
  say "Messages, textbot, calls - all itemised."                    # still covering it
  wait @generating gone within 240s
  say "Ninety-eight credits for August, against 650 in July."       # result line
```

A *process* line goes right after the action, describing what is happening. A
*result* line goes **after** `wait ... gone`, so it fires exactly when the
answer lands — self-syncing to however long the work actually took, instead of
a fixed offset that breaks on the next run. Between them, budget roughly one
more line per 6s of expected wait, spaced with `hold`.

**Leave nothing over a `wait`, a `hold` or a `type`.** This is the placement
mistake that survives every later stage. A beat whose last `say` sits *before*
its `wait ... gone` leaves the tail of that wait, the `hold` after it, and the
typing of the next question with no voice on them at all. Two such beats in this
demo produced 11.6s and 11.1s of digital silence — the longest stretches in the
video by a factor of two, and the reason the pattern above now has a line in the
middle rather than a bare `hold 1500ms`.

Do not expect step 9 to rescue it. `tighten.mjs` removes runs that are frozen
**and** silent, and a screen streaming an answer, or a question being typed, is
not frozen. Silent-but-moving is invisible to it by design, so the only place
that dead air can be fixed is here, in the cue placement.

The other half of the same guard: a `hold` before `wait ... gone` is what stops
the wait firing before the element appears, so a longer hold with a line on it
does that job as well as a bare short one. Put two lines too close together and
`narrate.mjs` warns that they overlap; separate them with a `hold` longer than
the first clip.

**Levels.** Three things sit between the provider's output and the mix, because
speech that is merely normalised still does not sound even:

1. **The breath is trimmed off the front of each clip.** TTS does not start on
   the word — it starts on 100-160ms at -50 to -85 dB. Cued at its file start,
   the line begins with something barely audible and only then speaks, which is
   heard as the narration fading up, and it survives any amount of loudness
   normalisation because normalising a breath just gives you a louder breath.
   The head is measured in 20ms RMS windows (not `silenceremove`, which decides
   on peaks and keeps it) and the line is cued on its first word. Derived from
   the cached mp3, never in place of it, so changing `TTS_ONSET_DB` re-derives
   from disk and re-bills nothing.
2. **Every clip is levelled before the mix.** Providers do not return lines at a
   consistent level: measured here, ElevenLabs spans 4.1 LU across one script
   (-18.6 to -22.7 LUFS), worst on the short lines. Each clip is measured and
   put on `NARRATION_PREMIX_LUFS` (default -20) with a *static* gain. Static
   rather than a second `loudnorm`, because a per-clip dynamic pass rides the
   syllables inside a line and is audible on one that opens loud and tails off.
   `narrate.mjs` prints the spread it found and every clip it moved by 1.5 dB or
   more.
3. **The track is then set to -16 LUFS** by `NARRATION_FILTER` — `speechnorm`
   (which lifts soft line openings level with the body of the take) followed by
   `loudnorm` with true peak under -1.5 dB.

The order is the point, and 2 is not redundant with 3. A dynamic pass over the
finished mix sets the level of the *track*; it cannot set the level of a *line*.
A quiet line inside a well-levelled track stays quiet relative to its
neighbours, which is heard as the narration dropping away for a sentence and
coming back — the same symptom as the dead air above, from an unrelated cause.
Levelling has to happen per clip, before the mix.

Both filters leave digital silence alone — there is no noise floor between lines
to lift — so `tighten.mjs` can still find the silent stretches afterwards.

**Editing cues by hand.** `out/*.narration.json` is a plain `[{atMs, text}]`
list — the same escape hatch as hand-editing zoom regions. Adding or moving a
line there avoids a whole re-record, which matters when a take is expensive
(here, four messages to a live account). Re-run `narrate.mjs` and only changed
lines re-render. Keep the script in sync afterwards, or the next re-record
loses the edits.

Clips are cached in `out/tts/` keyed by provider+voice+text, so re-cutting or
re-composing costs nothing and re-bills nothing. The video stream is copied, not
re-encoded, so this step takes seconds. `narrate.mjs` warns when one line runs
into the next, or when narration outlasts the video.

| Env | Default | What it does |
|-----|---------|--------------|
| `DEMO_TTS` | key-dependent | `elevenlabs` or `openai` |
| `DEMO_TTS_VOICE` | provider default | voice **ID**, not name |
| `TTS_ONSET_DB` | `-34` | level that counts as speaking, for the breath trim |
| `NARRATION_PREMIX_LUFS` | `-20` | common level every clip is put on before the mix |
| `NARRATION_FILTER` | `speechnorm=e=3:r=0.0008:l=1,loudnorm=I=-16:TP=-1.5:LRA=11` | the master chain over the finished mix |

### 9. Take the dead air out

```powershell
node tighten.mjs                 # out/final-narrated.mp4 -> out/final-narrated-tight.mp4
node tighten.mjs --dry-run       # print the segment plan, write nothing
```

A recording of a real app is mostly waiting: a request in flight, a `hold`
running longer than the line it was covering, and the take rolling on for
seconds after the last thing happens. On the first pass of this demo that was
**53s of a 116s video**, including a 7.7s frozen tail after the closing line.

A stretch is treated as dead only when the picture is **frozen and the audio is
silent**. Either signal alone is wrong: a frozen screen under a narration line
is the shot that line is playing over, and cutting it truncates the voiceover.

The corollary catches people out, so it is worth stating plainly: **silence over
a moving screen is not dead air to this stage.** An answer streaming in, or a
question being typed, keeps the picture alive, so a long unnarrated stretch
there passes through untouched however long it is. That is a cue-placement
problem and it is fixed in step 8, not here.

That is also why this runs *after* `narrate.mjs` rather than before. The audio
has to be on the timeline for silence to mean anything, and because both
streams are then cut together, nothing can drift — unlike the manual `CUTS_MS`
in `assemble.mjs`, where the cursor telemetry and narration cues have to be
re-mapped by hand to match.

Interior dead runs are played fast rather than excised, keeping at least
`--keep` of screen time, so a pause still reads as a pause. The trailing run is
trimmed to `--tail`. Every seam is a crossfade, not a cut.

**Where a seam is allowed to sit, and why it is the whole correctness argument.**
Every seam sits a full crossfade *inside* the dead run, never on its edge.

A dead run begins where the silence begins and ends where speech resumes. So the
audio immediately outside either edge is, by construction, narration — and a
crossfade placed on the edge reaches `--xfade` past it and fades that narration
in or out. Result lines suffer worst: a result line starts the instant
generation finishes, which is exactly where a dead run ends, so the line's own
first word is what gets faded up from nothing. Zoom moves fail the same way,
because a zoom is triggered by a click and the screen goes still right after it —
the ease-in and ease-out sit against the run's edges and get dissolved away,
turning a considered move into a snap.

Inside the run there is nothing to damage: frozen picture, silent audio, so the
seam is invisible and inaudible and the pause simply gets shorter.

Zoom regions are read from `<take>.recordly` and subtracted from the dead runs
outright. Then a **placement check** re-verifies every seam against the detected
silence and the zoom list, and refuses to write if one is over either. That check
is not belt-and-braces: this failure produces a clean file of an entirely
plausible length, so nothing catches it except watching the video.

| Flag | Default | What it does |
|------|---------|--------------|
| `--min` | `3.0` | shortest dead run worth acting on, seconds |
| `--keep` | `1.4` | screen time left where a dead run was |
| `--speed` | `3` | top playback rate through a dead run |
| `--tail` | `2.5` | screen time left after the last thing that happens |
| `--xfade` | `0.6` | seam length |
| `--freeze` / `--silence` | `-50` / `-40` | detector noise floors, dB |

Every default here errs toward leaving the video alone, because the failure mode
of this stage is squeezing too hard, and it does not announce itself — the
output is simply a video that feels rushed.

`--min` is 3.0s rather than half a second because the pause between two spoken
lines is not dead air; it is the beat the viewer reads the answer in. At 0.9s
this demo lost 46% of its runtime and the answers became unreadable.

`--keep` and `--speed` decide how hard the squeeze is. A pause cut to 0.8s at 5x
does not read as a pause, it reads as a jump; 1.4s at 3x still breathes. `--keep`
also caps the dissolve — a seam cannot exceed half the segment it lands in, so a
short `--keep` quietly forces hard cuts no matter what `--xfade` says. It is
floored at 0.3s for that reason.

Check `--dry-run` before committing to a render.

### 10. Intro and outro cards (optional)

```powershell
node cards.mjs --script ..\scripts\<name>.demo
```

Renders branded title cards and joins them onto the video, writing
`out/<name>-carded.mp4`. With no path given it takes the newest stage that
exists — tightened, else narrated, else composed — so the usual output is
`out/final-narrated-tight-carded.mp4`. Copy comes from the script's `intro:` / `outro:`
headers (`Headline | Subhead`). Both cards are voiced with the same TTS provider
as the narration; `--no-voice` makes them silent. Card length follows the
voiceover, with a floor of 5-6s.

Every brand asset comes from `brand/`, and only from there — there
is no flag to point elsewhere. `brand/StyleGuide.txt` drives the look:

```
Brand Blue: #2563eb
Brand Green CTA Button: #16a34a
Headlines: Inter Display
Body Text: Inter
```

The blue is the card. Two ways to get this wrong, both of which leave the
style-guide hex as an ingredient nobody can see: mix it down into a near-black
navy, or run a gradient off it immediately so `#2563eb` survives on the top row
of pixels and nowhere else. So the top 55% of the card is the hex flat and
unmodified — sample it anywhere up there and you get `#2563eb` back — and only
below that does it deepen. The accent rule is the CTA green verbatim.

The same blue is the mat the browser window sits on for the whole demo
(`compose.mjs`), which is where most of the runtime actually is. Both stages
read `StyleGuide.txt` through `brand.mjs`, so the two cannot drift apart.

Headlines are set in the headline font, subheads in the body font. Fonts resolve
from `brand/*.ttf|otf` (or
`brand/fonts`) first, then from installed system fonts; if neither has them,
the card falls back to a system sans and prints a warning — so a card in the
wrong typeface never passes silently. Editing `StyleGuide.txt` restyles the
cards without touching the code.

Cards are drawn with `@napi-rs/canvas`, not ffmpeg `drawtext`: real layout
control, and the white logo composites with its alpha over the gradient. The
layout is measured then centred, so a long headline stays balanced.

The join **crossfades** (`xfade` + `acrossfade`, 0.75s, `CARD_XFADE` to change),
so the card dissolves into the demo. It used to fade the card out to black and
then cut in — which reads as two videos stapled together, with a black flash on
the seam. Only the outer edges fade to black now: the open of the intro and the
close of the outro.

It is filter-based, not the concat demuxer — the cards and the composed video
are encoded separately, and the demuxer silently corrupts joins when parameters
differ. That re-encodes the body once; it is the only step that does, and it
takes well under a minute.

Override without touching the script with `--intro` / `--outro`, or point it at
a different video: `node cards.mjs out/final.mp4 -o out/x.mp4`.

### 11. Verify before calling it done

**Run the quality gate.** `qa.mjs` measures what viewers notice and the stages
only warn about, and exits 1 on any of it:

```powershell
node qa.mjs        # checks out/final-narrated-tight-carded.mp4 (or the newest stage output)
```

| Check | Fails when |
|---|---|
| `overlap` | a narration line is still speaking when the next starts — two voices at once |
| `sync` | a line's speech starts more than 250ms off its cue in `final-narrated.mp4` |
| `deadair` | 6s+ with no narration (4s+ warns) outside the title cards |
| `frozen` | the picture barely changes for 5s+ (2.5s+ warns) — usually loading. Narration over 60% of it makes it a WARN (a hold on finished content), including a hold that runs to the end of the file |
| `black`, `streams` | black frames; audio and video of different length or offset |
| `loudness` | integrated loudness outside -19..-13 LUFS, true peak above -1 dBFS (warns) |

It writes `out/qa/qa.json` and a still per narration line and per flagged
range. The **video-qa** agent (`.claude/agents/video-qa.md`) runs it, looks at
those stills — does the screen show what the voice says, while it says it? —
and returns PASS/FAIL with the fix for each defect. Line lengths come from the
TTS cache, so it never calls the TTS API. For a video joined from several
takes, run it per part right after that part's `cards.mjs`, then on the joined
file with `--cues none --intro-s <s> --outro-s <s>`.

Then extract frames from `final.mp4` and actually look at them:

```powershell
ffmpeg -y -v error -ss 4.7 -i ..\out\final.mp4 -frames:v 1 -vf scale=860:-1 ..\out\check.png
```

Take one at each click + 0.6s and one wide per page. Confirm the zoom lands on
every click, the cursor is visible where it should be, beats are in order, and
content actually loaded — not skeletons or spinners. Iterate cuts and zooms
until clean.

## Publish a finished video

Publishing is the last step of a video, and it only happens after final
approval:
- the video's state is **done**: through the quality gate and the visual
  review (`node memory.mjs video state <name>`);
- the user has said to publish it. Only then does Claude add `--approved`.

Where to: `memory/destinations.json` is generic. Each app's destination comes
from `.env` as `PUBLISH_DEST_<APP>`, for example
`PUBLISH_DEST_ACME=https://drive.google.com/drive/folders/<id>`, a Google Drive
folder. The manifest names the video's `"title"` (the file name in Drive) and
its Jira `"ticket"`.

Uploads run as you, with the Drive API (no service account: those cannot upload
into a personal Drive). One-time setup:
1. In Google Cloud, enable the Google Drive API and create an OAuth client ID of
   type **Desktop app**. Put its id and secret in `.env` as
   `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
2. Run `node publish.mjs auth` and sign in in the browser. It writes
   `GOOGLE_OAUTH_REFRESH_TOKEN` into `.env` and never prints it.

```bash
cd pipeline
node publish.mjs check acme-tour                # what would be published, and what blocks it
node publish.mjs upload acme-tour --approved    # upload (a new revision if published before)
node publish.mjs jira acme-tour --ticket ACME-123 --comment <id>   # after Claude posts the link
npm run publish-video -- check acme-tour        # the same, via npm
```

After an upload:
- the video's state is **published**, with the link, the file id and the
  destination;
- its page and its Zep thread show it;
- the app's Zep graph states it as plain facts: the video, its ticket, the
  date and the link.

Claude then posts the link on the ticket through the Atlassian MCP tool and
records the comment with `publish.mjs jira`. Publishing again uploads a new
revision of the same Drive file, so the link stays the same. A new build or
review moves the status back until the video is published again.

## Project memory


`memory/` holds what the project knows:
- `rules.md`: standing rules. `CLAUDE.md` imports it (`@memory/rules.md`), so
  Claude Code loads it in every session.
- `pipeline-lessons.md`: how the pipeline behaves in practice, and the trace
  changes that fixed each problem.
- `features/<app>/`: one folder per application.
  - `data/features.json` is the app's **feature catalog**, the initial feature
    set: one document per feature, with category, description and source. Its
    `generated` date says what it covers.
  - The `.md` pages next to it are **video pages**, one per filmed feature,
    naming the videos that cover it.

Each app can have an online source. `memory/sources.json` is generic: it names
no app or location, only how to recognise and read each kind of source (a
Google Drive folder, for now). The location comes from `.env` as
`FEATURE_SOURCE_<APP>`, for example `FEATURE_SOURCE_ACME=<Drive folder URL>` for `memory/features/acme/`.

Those sources are reachable only as Claude tools (MCP), so a Claude Code agent
does the sync, `.claude/agents/memory.md`:

1. **At session start**, a SessionStart hook (`.claude/settings.json`) runs
   `node pipeline/memory.mjs hook`. When a source hasn't been synced within
   `MEMORY_MAX_AGE_H` hours (default 24), it asks Claude to launch the memory
   agent.
2. **The agent finds the deltas.** It lists the source, then
   `memory.mjs diff` compares the listing with the app's `data/sources.lock.json`.
   Files from on or before the catalog's `generated` date count as covered;
   `memory.mjs baseline` records them without reading them.
3. **It merges what changed.** It reads only the new or changed files and
   writes the features they describe into the catalog with `memory.mjs upsert`.
   A feature is matched by name; a new one gets the next `feature-NNN` id.
4. **It records each file** with `memory.mjs mark`.
5. **It pushes to Zep** with `memory.mjs zep push`.
6. **`build.mjs` warns too,** at the start of a build, when a source is stale.

Zep Cloud (`@getzep/zep-cloud`, key in `ZEP_API_KEY`) is the searchable store:
- one graph per app (`productvideo-<app>`) holds:
  - its catalog, one Zep document per feature;
  - its video pages;
  - the flows, traces and manifests those pages name;
    (generated scripts and the rendered videos are not pushed: scripts are
    regenerated from traces, and a video's state stands in for the file);
- `productvideo-project` holds the rules and pipeline notes;
- each working session is its own thread.

A changed document replaces its old episodes, and a full push (no file
arguments) removes documents whose file is gone. `memory/.zep-state.json` keeps
this machine's Zep ids and is gitignored.

**Sessions are attributed to a person.** Each person is one Zep user, keyed by
`MEMORY_USER` (default: `git config user.email`). At session start the hook
opens a Zep thread for the Claude session under that user and tells Claude
the session id, so each session can be traced to who ran it.

**Sessions are pushed as they happen.** A Stop hook
(`node pipeline/memory.mjs session flush`) pushes the new turns after every
Claude turn, quietly, so a session shows up in Zep while it runs. A lock keeps
a turn's push and the session's end from overlapping.

**Every session ends with a summary.** A SessionEnd hook
(`node pipeline/memory.mjs session end`) reads the session's transcript and
pushes to its thread:
- what the person typed and what Claude answered, with tool output and
  subagents' work left out, and emails and phone numbers masked;
- a summary built from the record, not by a model: who, when, the prompts,
  files changed, commits and pull requests, and where it ended.

A resumed session pushes only what is new. Run
`session end --dry-run --transcript <jsonl>` to see what would be sent.

**Every new video is a new session.** Before starting work on a new video
(a new flow, trace or manifest), Claude runs
`node pipeline/memory.mjs session video <name> --session <id>`. That closes
the current thread with its summary and opens a new one named for the video,
so each video's work is a session of its own in Zep, even mid-conversation.
Notes can still be added by hand with `zep session --session <id>`.

**Private apps stay out of the repo.** An app's target, flows, traces,
scripts, manifests, catalog and brand files can be kept out of the repo by
listing them in `.git/info/exclude`, which is local and never committed, so the
public `.gitignore` names no private app. They stay on disk for local builds. The sync record
(`data/sources.lock.json`) sits next to each catalog, so it's private with it.
`node docs/check.mjs` fails if a committed trace, script or manifest uses a
gitignored target. It also fails if `.env` and `.env.example` list different
keys.

```bash
cd pipeline
node memory.mjs status                       # apps, catalogs, sources, last sync, Zep configured?
node memory.mjs source acme                # the source's kind, id, and the tools to list/read it
node memory.mjs diff acme list.json        # remote listing vs the lock
node memory.mjs baseline acme list.json
node memory.mjs upsert acme found.json --source "Surveys Rollout One-Pager.pdf"
node memory.mjs mark acme <fileId> --title "<t>" --modified <iso> --kind feature --features feature-262
node memory.mjs synced acme
node memory.mjs zep push                     # changed catalog features, pages, traces, manifests
node memory.mjs session video acme-tour --session <id>   # a new video: a new session in Zep
node memory.mjs session end --dry-run --transcript <jsonl>   # what the SessionEnd hook would push
node memory.mjs zep session --session <id> --title "2026-10-23 acme tour" --file notes.md
node memory.mjs zep search "where is the reports page" --app acme
npm run memory -- status                     # the same, via npm
```

`node docs/check.mjs` fails if a `videos/*.json` isn't named on a video page.

## Documentation as code

The docs change in the same commit as the code they describe, and three things
enforce it — all running one script, `docs/check.mjs`:

```powershell
node docs/check.mjs         # regenerate the diagrams, check coverage
node docs/check.mjs --ci    # also fail if regenerating changed a committed file
```

**What it guarantees**

- **Generated docs cannot drift.** `docs/*.puml`, `docs/C4.md` and
  `docs/ProductVideo-C4.mdj` are rendered from `docs/c4-model.mjs` (the
  generator is deterministic), so they are regenerated, never edited.
- **Prose cannot silently fall behind.** What must be documented is derived from
  the code itself, and the check fails with the exact list of what is missing:

  | From the code | Must appear in |
  |---|---|
  | every `pipeline/*.mjs` file | `docs/c4-model.mjs` and `README.md` |
  | every `process.env.NAME` a stage reads (OS variables excepted) | `README.md` |
  | every script in `pipeline/package.json` | `README.md`, as `npm run <name>` |
  | every option `target.mjs` accepts | `README.md`, as `"key"` or `` `key` `` |
  | every command `script.mjs` parses | `README.md` or `scripts/grammar-tour.demo` |

  It catches what is *missing*, not what is *wrong*: when a change alters what
  a stage does, its description in the model and the README still has to be
  updated by whoever made the change.
- **Every level of the architecture is drawn.** Mentioning a stage somewhere
  in the model is not enough. The model's own validation (run by every
  regeneration, so by the check too) fails on a gap:

  | Rule | Fails when |
  |---|---|
  | every container has an L3 diagram | a container on L2 has no `Container_Boundary` diagram of its own |
  | every outside party is on L1 | a person or external system drawn on any diagram is missing from L1 context |
  | every pipeline file is in an L3 | a `pipeline/*.mjs` file is named by no L3 diagram title or component |
  | every dependency is drawn | a `dependencies` entry in `pipeline/package.json` is named by no element, so a new client library (an outside service) cannot arrive undrawn |

  These were added after `memory.mjs` and Zep Cloud reached `main` drawn on L2
  only: the earlier rules passed because the model mentioned both once.

**Where it runs**

| When | How | Effect |
|---|---|---|
| Claude Code edits a file in `pipeline/`, the model or the README | PostToolUse hook in `.claude/settings.json` | regenerates the diagrams and tells Claude what the docs now miss, so it fixes them in the same change |
| every commit | `.githooks/pre-commit` — enable once per clone: `git config core.hooksPath .githooks` | regenerates and stages the diagrams; blocks the commit on a coverage gap |
| every PR and push to `main` | `.github/workflows/docs.yml` | fails if the diagrams were not regenerated or coverage has a gap |

`CLAUDE.md` states the same rule for any Claude session.

## Differences from the gist

The gist targets macOS and one specific app. Changes made:

- **`compose.mjs` replaces Recordly** — the gist's step 7 shelled out to
  `Recordly.app`, which has no Windows build, so the pipeline could not finish
  here. The replacement reads the same project and telemetry files and renders
  zoom/pan, cursor and window frame directly.
- **`focusTrack` on zoom regions** — the gist collapsed a merged region to the
  *last* click's focus, which frames the final click and leaves every earlier
  click in the cluster off screen. Regions now carry every click position and
  the compositor pans across them. `focus` is still written for compatibility.
- **Chrome discovery** — was a hardcoded macOS path; now `CHROME_PATH` else the
  standard Windows / macOS / Linux locations, with Edge as a last resort.
- **`--use-mock-keychain`** — macOS-only cookie-decryption workaround, now
  applied only on darwin. Windows encrypts cookies with DPAPI, where the flag is
  meaningless.
- **`--force-device-scale-factor=1`** — added. Windows display scaling (125% /
  150% is the norm) otherwise makes `innerWidth` and the screencast size
  disagree, so frames come out the wrong size.
- **Tab matching** — the gist hardcoded `localhost:5175` / `auth0.com`; scenarios
  now declare `PAGE_URL_MATCH`, defaulting to the host of `APP`.
- **Pre-take logout is optional** — the gist required auth selectors on every
  scenario. Now it runs only when `userMenu` + `logoutItem` + `loginHeading` are
  present, so no-auth flows work.
- **Process teardown** — `chrome.kill()` only reaps the launcher process on
  Windows; the driver uses `taskkill /T /F` on the tree instead.
- **ffmpeg concat paths** — the concat demuxer treats `\` as an escape inside
  quotes, so frame paths are normalised to forward slashes. Without this every
  Windows run fails to find its frames.
- **ffmpeg override + error** — honours `FFMPEG`, and a missing binary reports
  the install command instead of a bare `ENOENT`.
- **Guards** — empty telemetry, over-aggressive cuts, and malformed scenario
  exports now fail with a message that says what to fix.
- **Targets** — the gist hardcoded the app URL in the scenario and had no way to
  sign in; a signed-out profile just made the take fail. Targets add the app URL,
  credentials (`env:` references, `.local.json`, `.env` or `DEMO_*`), and an
  `auth.start` that puts the app in the right state before rolling.
- **Scripts** — a plain-text flow format that compiles to a scenario, so a demo
  can be written and reviewed without touching JavaScript.
- **Capture gating** — the gist started the screencast on every navigation,
  including the pre-take logout, which put off-camera steps at the head of the
  video. Capture is now gated on the take actually having started.
- **`d.type` / `d.key` / `d.open` / `d.appears`** — added. Typing logs a
  telemetry sample per keystroke, so the composited cursor stays on the field
  instead of drifting toward the next beat.

Unchanged: the frame timing model, the cut/shift maths, the original input
primitives, the selector grammar, and the zoom-region clustering.

## Gotchas

| Symptom | Cause / fix |
|---------|-------------|
| `ffmpeg not found` | A shell opened before the winget install still has the old PATH. Reopen it, or set `FFMPEG` |
| `--dry-run` did nothing and the stage rendered for real | `npm run <stage> -- --dry-run` in PowerShell: the shell eats the bare `--` before npm sees it, so the flag never reaches the script and there is no error. Quote it — `npm run tighten '--' --dry-run` — or call `node tighten.mjs --dry-run` directly |
| `no project at ...` | `compose.mjs` ran before `project.mjs` |
| `video not found` | The project moved between machines. `compose.mjs` also tries a sibling of the project file; otherwise fix `videoPath` |
| Compose is slow | Expected: ~4-5x the video's length at 1080p60 (~14 frames/sec). `X264_PRESET=veryfast` trades a little size for speed. Run it in the background for anything over ~2 minutes |
| Cursor missing at a click | The click is outside the zoomed view — the region's focus is elsewhere. Check the `focusTrack` that `project.mjs` printed |
| Frames are the wrong size / blurry | Display scaling. The driver pins `--force-device-scale-factor=1`; if you removed it, put it back |
| `viewport is 1425x795, wanted 1440x810` warning | Window-fit loop lost to a min-size or snap constraint. Framing shifts but telemetry stays correct |
| `app page not found` | The flow leaves the `APP` origin. Add the other host to `PAGE_URL_MATCH` |
| `race: nothing appeared` after an auth click | A page you did not anticipate (account chooser, consent variant). Look at the last jpg in `out/frames/` to see what was on screen |
| `btn:` spec times out | Text is not exact. `btn:` matches exact trimmed textContent, aria-label, or inner `img[alt]` — avatar buttons flip between initials text and an alt-named image, so give both: `btn:Jane Doe\|JD` |
| Video freezes mid-flow | Dead air. Step 9 removes it automatically once narration exists; for a wait you have to shorten earlier, see step 5 |
| A narration line fades in or out mid-word | A seam landed on speech. `tighten.mjs` now refuses to write when that happens — if you see it in an older render, re-run the stage |
| One line sounds quieter than the rest | The provider returned that clip low — short lines are the usual offenders. `narrate.mjs` levels every clip before the mix and prints what it moved; check its `levels:` line. If it is still uneven, the clip needed more than the ±6 dB cap, so reword or re-render it |
| A long silence `tighten.mjs` will not remove | It is silent but not frozen — an answer streaming in, or a question being typed. That is invisible to the stage by design. Add a `say` over it (step 8); do not lower `--min` |
| The video got *longer* after adding narration | Expected. A stretch that was being played at `--speed` because it was frozen and silent is no longer silent, so it plays at 1x. Narrated content at normal speed beats sped-up silence, but check the runtime is still what you want |
| A zoom snaps instead of easing | A seam landed on the zoom ramp. Same fix; the placement check covers zooms too |
| The demo jumps from "Found tools" to a finished answer | A `CUTS_MS` range spans the answer being written. Use `SPEEDS_MS` for that span instead — see step 5 |
| Video ends on a frozen frame with nothing happening | The take kept rolling after the last line. `tighten.mjs` trims that tail to `--tail`; if it survived, the tail was not silent — check for a narration clip still playing under it |
| `tighten.mjs` made the answers unreadable | `--min` is too low, so the reading pauses between spoken lines got compressed along with the real waiting. Raise it and re-check `--dry-run` |
| Tightening feels abrupt / jumpy | Not `--min` — that decides *what* gets compressed, not how hard. Raise `--keep` and lower `--speed`, then raise `--xfade`. A seam is capped at half the segment it lands in, so `--xfade` alone does nothing while `--keep` is small |
| `target "x" not found` | No `targets/x.json`. The message lists the targets that do exist |
| `target auth.password is not set` | The `env:` variable behind it is unset. The message names the variable; set it in `targets/<name>.local.json`, `/.env` or the shell |
| `this flow signs in, but the target has no auth block` | The flow has a `login` step but the target has no `auth`, or you forgot `--target` |
| Login typed into the wrong field | `auth.selectors.username` / `password` point at the wrong input. They are puppeteer selectors — `input[name="email"]`, not `btn:` |
| Take opens on the login page when it should not | `auth.start` is `signed-out` (the default). Set it to `signed-in` |
| `pre-take: the app is signed in but there is no way to sign out` | Add `userMenu` + `logoutItem` to `auth.selectors`, or set `auth.start` to `signed-in`, or delete `/profile/` |
| Script command not recognised | The error names the line. Commands are the ones in the step-2 table; `css #id` needs the `css` prefix |
| Generated scenario overwritten | `script.mjs` writes `scenarios/<name>.mjs` and refuses to clobber a file it did not generate. Use `-o` to write elsewhere |
| Beat shows skeletons | The driver waited on a heading that renders before data. Wait on content text instead |
| Chrome processes left running | Killed mid-take. `taskkill /IM chrome.exe /F` only kills every Chrome, so prefer closing the demo window; the driver cleans up on normal exit |
| Second run reuses stale login | `/profile/` persists between takes by design. Delete it for a cold start |
| Profile is signed out after every take | Fixed: the driver now closes Chrome cleanly so cookies flush. A hard `taskkill` loses unflushed session state, which silently signs the profile out |
| `clicking <sel> did not focus it` | `d.type` verified the click missed — a toast or overlay took it, or the layout moved. It retries once, then refuses to type rather than sending text to whatever has focus. Remove mid-beat `scroll` steps; they shift layout between measuring and clicking |
| Zoom regions all land on a text input | Expected when typing is the flow's only click. Framing an empty composer four times is worse than none — set `zoomRegions: []` in the project, or hand-author regions over the content |
| Cutting removed the payoff | Cuts are blind to meaning. After any aggressive cut, extract the *last* frame and confirm the final state still renders — an over-long cut can end the video mid-answer |
| ElevenLabs `402 paid_plan_required` | Free-tier keys cannot use library voices via the API — including the premade defaults. The key is valid (401 would mean invalid); either upgrade or use a voice the plan allows |
| ElevenLabs `401 missing_permissions` on quota/voices | Harmless. The key lacks `user_read`/`voices_read`; neither is needed to render speech |
| Narration desyncs after a cut | Should not happen — `assemble.mjs` shifts cues with the same maths as the cursor. If you hand-edited `*.narration.json`, re-derive it or re-apply the offsets |