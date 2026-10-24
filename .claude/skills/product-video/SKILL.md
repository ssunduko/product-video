---
name: product-video
description: Use when asked to create a product demo video, tutorial video, walkthrough recording, or screen capture of a web app from a plain-English flow (e.g. "make a demo of login then the teams page"), including recording against a particular deployment or an app that requires signing in.
---

# Demo Video Pipeline

## Overview

Scripted pipeline at the repo root (`../../../`) that turns a plain-English product flow into a
polished MP4: a CDP-driven Chrome runs the flow while frames + input are
captured, ffmpeg assembles them, zoom regions are derived from click telemetry,
and `compose.mjs` renders the finished video — eased zoom/pan, a synthesized
cursor, and a styled window frame.

The cursor in the final video is drawn from telemetry, not recorded, so captures
need no real cursor.

Three separable pieces:

- **target** (`../../../targets/<name>.json`) — which deployment, and how to sign
  in. Optional. The only place credentials belong.
- **flow** — either a plain-text script (`../../../scripts/<name>.demo`) that
  compiles to a scenario, or a hand-written scenario
  (`../../../scenarios/<name>.mjs`).
- **pipeline** (`../../../pipeline/*.mjs`) — author (plain English
  to DSL), then capture, assemble, zoom, compose, then the optional finishing
  stages: narrate, tighten, cards.

Architecture diagrams live in `../../../docs/` — C4 at three levels, one
component diagram per stage. `docs/C4.md` is readable anywhere; the same model
is also published as PlantUML and a StarUML project. All generated from
`docs/c4-model.mjs`, so change the model there and re-run rather than editing an
output.

Full docs: `../../../README.md`.

## Prerequisites (check, never fix silently)

- The app under test must already be running. If its dev server is down, **ask
  the user; do NOT start it.**
- `ffmpeg` + `ffprobe` on PATH, or `FFMPEG` / `FFPROBE` set. Installed here via
  `winget install Gyan.FFmpeg`; a shell opened before that install has a stale
  PATH and must be restarted.
- `../../../pipeline/node_modules` installed (`npm install` there if not) —
  `puppeteer-core` and `@napi-rs/canvas`.
- Chrome — auto-detected, or `CHROME_PATH`.

Every stage runs from `pipeline/` and has an npm alias (`npm run`
lists all eight: compile, record, assemble, project, compose, narrate, tighten,
cards). **Use the `node <stage>.mjs` form whenever you are passing a flag.** In
PowerShell, `npm run tighten -- --dry-run` silently runs the real render —
the shell consumes the bare `--`, npm never forwards it, and there is no error.
`npm run tighten '--' --dry-run` works; `node tighten.mjs --dry-run` always does.

## Procedure

0. **Start the video's session.** A new video is a new session in Zep: run
   `node ../../../pipeline/memory.mjs session video <name> --session <id>` (the
   SessionStart context gives the id) before any other step.

1. **Settle the target.** If the user named an app URL, or the flow needs a
   login, look in `../../../targets/` for a matching target and otherwise create
   one from `targets/<name>.json`: `app`, plus for login an `auth` block with
   `mode: "form"`, selectors for the username/password/submit fields, and
   `start` (`signed-out` when the demo shows signing in, `signed-in` when it
   starts inside the app).

   **Never write a credential into a committed file.** Use `"env:DEMO_PASSWORD"`
   references and ask the user to put values in `../../../targets/<name>.local.json`
   or `../../../.env` (both gitignored), or to export `DEMO_USERNAME` /
   `DEMO_PASSWORD`. If credentials are needed and absent, ask — do not invent
   them or skip the login step. Never echo a password back to the user.

   No login and no particular deployment? Skip this; a scenario's own `APP`
   still works.

2. **Recon the flow live.** Open the app in a browser and walk the requested
   flow, taking a11y snapshots. For every click target note its exact trimmed
   text or aria-label; for every page note a unique anchor text to wait on.
   Verify each beat actually exists before writing anything. Recon the login
   form too if the demo signs in — the target needs its real field selectors.

   **Prefer `ask "..."` over hand-reconning a brittle handle.** Write the intent
   in the script and resolve it against the live app with the **resolve-selectors**
   skill, which drives the user's own Chrome through the extension (real session,
   no SSO ritual) and writes `scripts/<name>.selectors.json`. Reach for it when a
   hardcoded selector would be fragile: generated class names, an avatar button
   that flips between initials and an image, or anything anchored on copy the app
   writes itself — a model's answer is worded differently every run, so matching
   its text is a coin flip.

   Resolution is a **pre-take** step. Never resolve during a recording: the
   driver stamps cues at wall-clock time, so a model round trip mid-run lands in
   the finished video as dead air. Unresolved intents fail at compile, before
   Chrome launches.

3. **Author the flow.** **First choice: the author-demo skill** — it walks the
   real app through the extension and generates the `.demo` and its selector
   sidecar from what it observes, sizing every hold and narration line to a
   measured wait instead of a guess. Hand-write a script only when the app
   cannot be reached from the user's browser.

   Otherwise, a script at `../../../scripts/<name>.demo` —
   the user can read and correct it, and it compiles to a scenario.
   `scripts/grammar-tour.demo` documents every command. Drop to a hand-written
   scenario at `../../../scenarios/<name>.mjs` when the flow needs
   real control flow — loops, branching beyond `if <sel> appears`, anything
   computed. The skeleton and the full `d.*` contract are in README "b. A
   scenario"; a `.demo` compiles to a file exactly like it.

   Script: header directives `target:`, `app:`, `viewport:`, `match:`,
   `intro:` / `outro:` (title cards; brand assets always come from
   `brand/`, there is no `brand:` directive), a
   `selectors:` block of `name = button "Text"` / `text "Text"` / `css <sel>` /
   `ask "description"` (resolved by the resolve-selectors skill; see step 2),
   then beats of `wait` / `click` / `hover` / `hold` / `type` / `press` /
   `scroll` / `open` / `login` / `logout` / `wait <sel> gone` / `say "..."` /
   `if <sel> appears … end`.
   Inspect the generated scenario with
   `node script.mjs ../scripts/<name>.demo --print`.

   Scenario: export `SEL` and `run(d)`, plus `APP` (unless a target gives one),
   `VIEWPORT`, `PAGE_URL_MATCH`, `START_URL`, `TARGET`.

   Selector specs: `btn:Exact Text|Alt` matches
   button/a/[role=menuitem]/[role=button] by exact trimmed textContent,
   aria-label, or inner `img[alt]`; anything else is a puppeteer selector (use
   `::-p-text(unique substring)` for hover/wait anchors).

   Primitives: `d.hold(ms)`, `d.waitSel(spec, timeout)`, `d.waitGone(spec, ms)`,
   `d.appears(spec, ms)`,
   `d.hoverSel(spec)`, `d.clickSel(spec)`, `d.type(spec, text)`, `d.key(name)`,
   `d.wheel(px)`, `d.open(path)`, `d.race({key: spec}, timeout)`,
   `d.login()`, `d.logout()`, `d.creds()`, `d.secret(name)`.

   Pace beats at 1–2.5s holds with hovers on rows. Every click becomes a zoom
   region downstream, so a click you do not want zoomed is better a hover.

   **Flows run against live data: never click anything that creates,
   modifies, or deletes unless the flow explicitly asks. Hover instead.**

4. **Record** — a script or a scenario path both work:

   ```
   cd pipeline
   node driver.mjs ../scripts/<name>.demo --target <name>
   ```

   `--target` is optional when the flow already names one (`target:` header,
   `TARGET` export, or `DEMO_TARGET`). A Chrome window runs the flow; ~flow
   length + 15s. Writes `out/frames/`, `out/actions.json`, `out/frames.json`.
   The driver prints the resolved target — check the app URL, and for a login
   flow that it reported `signed in as ...`.

5. **Assemble + inspect:** `node assemble.mjs` makes `out/raw.mp4` +
   `raw.mp4.cursor.json` and prints the largest inter-frame gaps (the video
   freezes there). Spot-read frames at each beat
   (`ffmpeg -ss <t> -i ../out/raw.mp4 -frames:v 1 f.png`, then Read).

6. **Cut dead air:** use the gap report plus frame spot-reads to pick cuts, then
   re-assemble: `CUTS_MS='[[startMs,endMs]]' OUT_NAME=cut.mp4 node assemble.mjs`
   (PowerShell: `$env:CUTS_MS='...'; $env:OUT_NAME='cut.mp4'; node assemble.mjs`).
   Telemetry shifts automatically. Cut in the assembler, never with editor trims.

7. **Generate zooms:** `node project.mjs` writes `out/<name>.recordly` (one zoom
   region per click cluster, clicks <2.5s apart merged). Each region carries a
   `focusTrack` of every click position in the cluster, which the compositor
   pans across. Review the printed regions; hand-edit the JSON only if framing
   needs it (region crossing a cut boundary, focus too tight on a corner).
   Explicit regions beat auto-zoom.

8. **Compose:** `node compose.mjs` reads `out/<name>.recordly` and writes
   `out/final.mp4` (override: `node compose.mjs <project> -o <output>`). Renders
   eased zoom/pan, the synthesized cursor with click ripples, and the window
   frame. Budget ~4-5x the video's length at 1080p60 (measured: 77s for a 20s
   clip, 387s for 95s, 1490s for 300s). Anything over ~2 minutes of video will
   outlast a 10-minute shell timeout — run it in the background, and do not
   assume it has hung.
   Look is tunable via an optional `editor.frame` block in the project file
   (`padding`, `radius`, `shadow`, `background`, `rampMs`, `panMs`, `cursor`),
   or `NO_FRAME=1` / `PADDING` / `X264_PRESET` / `X264_CRF`.

9. **Narrate (optional):** place cues deliberately — a *process* line right
   after the action, and a *result* line **after** `wait <sel> gone` so it fires
   exactly when the answer lands rather than at a guessed offset. Fact-check
   every line against the frame it plays over; narrating something not yet on
   screen is the easy mistake.

   **Leave no `wait`, `hold` or `type` uncovered.** A beat whose last `say` sits
   before its `wait ... gone` leaves the rest of the wait, the `hold` after it
   and the typing of the next question in silence — 11s stretches, on this demo.
   Budget roughly one line per 6s of expected wait, spaced with `hold`. Step 10
   cannot clean this up: it only removes runs that are frozen **and** silent,
   and a streaming answer or a question being typed is not frozen.

   `out/*.narration.json` can be hand-edited (`[{atMs, text}]`) to add or move
   cues without paying for a re-record — place a line by measuring the clip and
   working backwards from the cue that follows it, then keep the `.demo` in sync
   or the next re-record loses the edit.

   If the script has `say "..."` lines,
   `node narrate.mjs` renders them to speech and muxes them onto the video
   (`--dry-run` prints cue times without calling any API). Provider comes from
   `DEMO_TTS` or whichever key is set: `ELEVENLABS_API_KEY` / `OPENAI_API_KEY`.
   **Never write a TTS key into a file** — same rule as any other credential.
   Cue times are recorded during the take and shifted by cuts, so narration
   stays in sync; clips cache in `out/tts/`.

   Levels are handled for you and worth knowing about: the breath is trimmed off
   the front of each clip, every clip is measured and levelled to
   `NARRATION_PREMIX_LUFS` (-20) with a static gain *before* the mix, and
   `NARRATION_FILTER` then sets the track to -16 LUFS. The middle step is the
   one that is easy to think redundant — a dynamic pass over the finished mix
   sets the level of the track, never of a line, so without it a clip the
   provider returned low stays quiet next to its neighbours. `narrate.mjs`
   prints the spread it found and every clip it moved.

10. **Take the dead air out:** `node tighten.mjs` turns
    `out/final-narrated.mp4` into `out/final-narrated-tight.mp4`; `--dry-run`
    prints the segment plan and writes nothing — always look at it first.
    Interior dead runs are played at `--speed` (keeping at least `--keep` of
    screen time, so a pause still reads as a pause), the trailing run is trimmed
    to `--tail`, and every seam is a crossfade sitting a full `--xfade` *inside*
    the run, never on its edge.

    Runs after narrate, not before: a stretch is dead only when the picture is
    frozen **and** the audio silent, and silence is only knowable once the voice
    is on the timeline. Both streams are then cut together, so nothing can
    drift. A seam on a run's edge would fade a narration line up from nothing;
    a placement check re-verifies every seam against the detected silence and
    the zoom regions and refuses to write if one is over either — that failure
    produces a clean file of a plausible length, so nothing else catches it.

    Flags: `--min 3.0` (shortest run worth acting on), `--keep 1.4`,
    `--speed 3`, `--tail 2.5`, `--xfade 0.6`. Every default errs toward leaving
    the video alone; squeezing too hard does not announce itself.

11. **Cards (optional):** `node cards.mjs --script <flow>.demo` renders branded
    intro/outro title cards and joins them on, from the script's `intro:` /
    `outro:` (`Headline | Subhead`) headers. Voiced with the same
    TTS provider; `--no-voice` for silent. Joins with ffmpeg's concat *filter*,
    not the demuxer, so separately-encoded segments splice cleanly.

12. **Quality gate — required:** delegate to the **video-qa** agent
   (`.claude/agents/video-qa.md`). It runs `node qa.mjs` (overlapping
   narration, line sync, dead air, frozen/loading screens, black frames,
   loudness) and then checks every narration line against a still of the
   screen. Do not deliver, and do not call the video done, on its FAIL — fix
   what it names (usually in the trace) and re-record or re-render, then run it
   again. For a video joined from several takes, run it on each part right
   after that part's `cards.mjs`, while its stage files are still in `out/`,
   and once more on the joined file.

13. **Deliver:** copy to `../../../out/<descriptive-name>.mp4` and report the
    video-qa verdict with it.

**Several takes in one video** (two users, two apps) — write a manifest in
`../../../videos/<name>.json` and run `node build.mjs ../videos/<name>.json`
instead of the stages by hand. It records each part into its own folder
(`DEMO_OUT`), renders it with the manifest's `env` (set `AUTO_SPEED` there to
fast-forward unnarrated waits), gates every part and the join on `qa.mjs`, and
trims the silence at each join by measurement. Do not join takes with ad-hoc
ffmpeg: the result cannot be rebuilt. Then run video-qa on the stills it prints.

## Gotchas

| Symptom | Cause / fix                                                                                                                                                                                |
|---------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ffmpeg not found` | A shell opened before the winget install has a stale PATH. Reopen it, or set `FFMPEG`                                                                                                      |
| `--dry-run` ignored; the stage rendered for real | `npm run <stage> -- --flag` in PowerShell: the shell eats the bare `--`, so npm never forwards the flag and nothing errors. Use `node <stage>.mjs --flag`, or quote it: `npm run tighten '--' --dry-run` |
| `no project at ...` | `compose.mjs` ran before `project.mjs`                                                                                                                                                     |
| `video not found` | Project moved between machines; fix `videoPath` in the project file                                                                                                                        |
| Compose seems to hang | Normal: ~4-5x the video's length at 1080p60; it prints frame progress. `X264_PRESET=veryfast` helps. Background it for >2min video                                                         |
| Cursor missing at a click | That click is outside the zoomed view — check the `focusTrack` `project.mjs` printed                                                                                                       |
| Frames wrong size / blurry | Windows display scaling. Driver pins `--force-device-scale-factor=1`; keep it                                                                                                              |
| `app page not found` | Flow left the `APP` origin. Add the host to `PAGE_URL_MATCH` (scenario) or `pageUrlMatch` (target)                                                                                         |
| `race: nothing appeared` after an auth click | An unanticipated page (account chooser, consent variant). Check the last jpg in `out/frames/`                                                                                              |
| Consent screen appears every take | Expected on dev tenants re-prompting for localhost callbacks. Handle it with `if <sel> appears … end` in a script, or `d.race` in a scenario                                               |
| `btn:` spec times out | Text not exact. Avatar buttons flip between initials text and an alt-named image — give both: `btn:Name\|NM`                                                                               |
| Selector broke after a redesign | Rewrite it as `ask "description"` and run the resolve-selectors skill. Delete the stale key from `scripts/<name>.selectors.json`; the `.demo` itself does not change |
| `selector(s) still state an intent` at compile | An `ask` has no resolution. Run the resolve-selectors skill; do NOT hand-write a guess into the sidecar |
| Video freezes mid-flow | Dead air. Step 10 removes it once narration exists; for a wait to shorten earlier, see step 6                                                                                              |
| A long silence `tighten.mjs` will not remove | Silent but *not frozen* — a streaming answer, or a question being typed. Invisible to that stage by design. Cover it with a `say` (step 9); do not lower `--min`                            |
| One narration line sounds quieter than the rest | The provider returned that clip low; short lines are the usual offenders. `narrate.mjs` levels each clip before the mix and prints what it moved — check its `levels:` line                 |
| Video got *longer* after adding narration | Expected: a stretch that was played at `--speed` for being frozen and silent is no longer silent, so it plays at 1x                                                                        |
| A narration line fades in or out mid-word | A seam landed on speech. `tighten.mjs` refuses to write when that happens — re-run the stage on an older render                                                                             |
| Beat shows skeletons | Driver waited on a heading that renders before data. Wait on content text instead, or trim                                                                                                 |
| Cookies lost between takes (macOS) | Profile cookies encrypted with puppeteer's mock keychain; the driver keeps `--use-mock-keychain` on darwin. Recopy the profile with Chrome quit, and `rm profile/Singleton*` |
| Second run reuses a stale login | `../../../profile/` persists by design. Delete it for a cold start                                                                                                           |
| Profile signed out after every take | Fixed: the driver closes Chrome cleanly so cookies flush; a hard kill loses unflushed session state                                                                                        |
| `clicking <sel> did not focus it` | `d.type` caught a missed click (toast, overlay, or layout shift) and refused to type into the wrong element. Drop mid-beat `scroll` steps                                                  |
| Zoom regions all on a text input | Expected when typing is the only click. Set `zoomRegions: []` rather than framing an empty composer                                                                                        |
| Cutting removed the payoff | Cuts are blind to meaning — after an aggressive cut, check the LAST frame still shows the final state                                                                                      |
| ElevenLabs `402 paid_plan_required` | Free-tier keys cannot use library voices via the API, including premade defaults. 401 would mean an invalid key; 402 means the key is fine                                                 |
| `target "x" not found` | No `../../../targets/x.json`; the error lists the ones that exist                                                                                                            |
| `target auth.password is not set` | The `env:` variable behind it is unset — the error names it. Ask the user to set it; never guess                                                                                           |
| `this flow signs in, but the target has no auth block` | A `login` step with no `auth` on the target, or `--target` was omitted                                                                                                                     |
| Login typed into the wrong field | `auth.selectors.username`/`password` are puppeteer selectors (`input[name="email"]`), not `btn:` specs                                                                                     |
| Take opens on the login page when it should not | `auth.start` is `signed-out` (the default). Set it to `signed-in`                                                                                                                          |
| Script fails to compile | The error names the file and line. Commands are the ones in step 3; a CSS id needs the `css` prefix (`css #search`)                                                                        |
| `refusing to overwrite <scenario>` | `script.mjs` will not clobber a hand-written scenario. Use `-o` to write elsewhere                                                                                                         |
| Off-camera login/logout appears in the video | Should not happen — capture is gated on the take. If it does, check `rolling` in `driver.mjs`                                                                                              |
