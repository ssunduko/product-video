---
name: author-demo
description: Turn a plain-English description of a product flow into an executable .demo script, by walking the real app through the Claude in Chrome extension and recording what actually happens — which selector each step needs and how long each wait really takes. Use when asked to "make a demo of X", "script a walkthrough of Y", or to rebuild a .demo whose timings or selectors have gone stale.
---

# Authoring a .demo from plain English

The user describes a flow in ordinary language. You walk the real app, observe
it, and emit the DSL the pipeline executes.

```
input/<name>.flow          plain English, one step per line — the user writes this
        │
        ▼   you drive the real app through the extension, timing as you go
scenarios/<name>.trace.json    selectors + MEASURED wait times
        │
        ▼   node author.mjs ../scenarios/<name>.trace.json
scripts/<name>.demo  +  scripts/<name>.selectors.json      generated
        │
        ▼   node driver.mjs ../scripts/<name>.demo
   the take
```

New flows start from `input/_template.flow` (header fields + step shapes);
point a user who has no `.flow` yet at it. Never author from the template itself.

`scenarios/` is authored, `scripts/` is generated. Never hand-edit a generated
`.demo`: change the trace and re-run. `node pipeline/author.mjs --check` (in the
pre-commit hook and CI) fails while a committed script differs from what its
trace generates.

**Do not hand-write the `.demo`.** Write the trace and let `author.mjs` emit it.
The generator is what stops the timings being guesses — see below.

## Why the timings are the whole point

A hand-written script has to guess how long the app takes. Guessing low is not a
small error: narration stops, the screen keeps moving, and the video is silent
for the difference. `tighten.mjs` cannot rescue it, because dead air it can
remove has to be frozen **and** silent, and a streaming answer is not frozen.

Both scripts in this repo were written with `hold 7s` against generation that
measured **36.6s** one run and **43s** the next, and both shipped double-digit
silences that had to be found and fixed afterwards. So: measure every wait, put
the number in the trace, and let the generator size the narration to it.

## Procedure

1. **Restate the flow as beats and confirm.** One beat per thing the viewer
   should register. Say back what you understood before touching the browser —
   a misread flow wastes a live walk.

2. **Check the app is reachable and signed in.** The extension reaches the
   user's own session, which is the point: no SSO ritual, no email code.

3. **Load the browser tools in ONE ToolSearch call**, then `tabs_context_mcp`,
   then `tabs_create_mcp`. Never reuse a tab you were not asked to.

4. **Walk the flow for real, in order.** Many elements do not exist until you
   get there — a results table appears only after a question is sent, a stop
   control only while something is generating.

   **Live data. Stop and ask before any step that sends, creates, edits or
   deletes.** Say what it will do and to what. Hover rather than click when you
   only need to locate something.

5. **Resolve a durable selector for each element.** Follow the
   **resolve-selectors** skill's preference order and its one-match check —
   prefer `data-testid`, then a stable id, then role/accessible name, then
   `aria-label`, then semantic structure. Never key on generated class names or
   on copy the app writes itself.

6. **Time every wait.** This is the step that cannot be skipped or estimated.
   Poll with `javascript_tool` and record real elapsed milliseconds:

   ```js
   const q = 'button[aria-label="Stop response"]';
   const t0 = Date.now();
   while (document.querySelectorAll(q).length && Date.now() - t0 < 180000) {
     await new Promise(r => setTimeout(r, 500));
   }
   ({ waitedMs: Date.now() - t0, remaining: document.querySelectorAll(q).length });
   ```

   A `waitGone` needs the element to have been **present first** — check it is
   there before you start the clock, or you will record 0ms.

   **`javascript_tool` dies at 45s** (CDP `Runtime.evaluate` timeout). Anything
   slower has to be polled in chunks of ~25-30s, accumulating the total across
   calls. A single loop over a 60s generation returns an error, not a number.

   **Anchor on a state attribute, not on a transient control.** A "Stop" or
   "Cancel" button is the obvious completion signal and it is the wrong one: on
   claude.ai `button[aria-label="Stop response"]` disappears entirely whenever a
   notification banner is showing, and **`wait ... gone` on an element that does
   not exist passes instantly** — the take races ahead and asks the next question
   over the previous answer, silently. `[data-is-streaming="true"]` flips
   `true`→`false` and cannot vanish. Prefer that shape every time.

7. **Note any UI that blocks the flow.** Banners, cookie bars and interstitials
   that appear *part-way through* are the ones that break takes, because they are
   not there when you start. On claude.ai the "Want to be notified when Claude
   responds?" banner removes both Send and Stop from the DOM while it is up.
   Put these in `trace.warnings` — the generator writes them into the script
   header, where the next person will actually see them.

7. **Write the trace** to `scenarios/<name>.trace.json` (the `.flow` it came
   from stays in `input/`) — **not** in `out/`, which is gitignored and disposable. A trace is
   an authored artifact: it is the record of what the app actually did, and it is
   what someone re-reads when a selector or a timing goes stale.

   Schema below. For each long
   wait, supply **more narration lines than you think will fit**: the generator
   places what fits the measured duration and reports the rest as unused. That
   is the intended way to use it — over-supply and let it choose.

8. **Generate, then verify.**

   ```
   cd pipeline
   node author.mjs ../scenarios/<name>.trace.json
   node script.mjs ../scripts/<name>.demo --intents   # expect 0 unresolved
   node script.mjs ../scripts/<name>.demo --print     # expect no warnings
   ```

9. **Report the generator's notes.** Unused narration lines and `SPEEDS_MS`
   candidates are decisions the user should see, not footnotes to bury.

## Trace schema

```jsonc
{
  "name": "analytics-tour",
  "description": "...",            // becomes description:
  "target": "claude-ai",           // or "app": "https://..."
  "observedAt": "2026-08-09",
  "intro": "Headline | Subhead",   // optional title cards
  "outro": "Headline | Subhead",
  "selectors": {                   // each element ONCE: what it is, its selector, how you know
    "composer":   { "intent": "the message box at the bottom",
                    "spec": "div[data-testid=\"chat-input\"]",
                    "evidence": "1 match, contenteditable" },
    "generating": { "intent": "the stop control",
                    "spec": "button[aria-label=\"Stop response\"]",
                    "evidence": "present only while the reply streams" }
  },
  "beats": [
    {
      "title": "Ask about response times",
      "steps": [
        { "op": "say",   "text": "..." },
        { "op": "wait",  "name": "composer", "observedMs": 412 },
        { "op": "type",  "name": "composer", "text": "What were our..." },
        { "op": "press", "key": "Enter" },
        { "op": "waitGone", "name": "generating",
                            "observedMs": 43000,
                            "narration": ["line 1", "line 2", "line 3", "one more in case"],
                            "result": "Both periods come back side by side." },
        { "op": "hold",  "ms": 5000 }
      ]
    }
  ]
}
```

`name` is the selector's DSL name and `intent` its plain-English description —
the generator writes `name = ask "intent"` into the selectors block and the
`spec` into the sidecar, so the two always agree. Define each element once in the
`selectors` table and refer to it from steps by `name` alone. A step may carry
its own `intent`/`spec`/`evidence` to override the table. A step naming a
selector the table lacks is an error. `scenarios/grammar-tour.trace.json` is the
annotated example.

Write the trace by hand in `scenarios/`. Never generate it from a helper script
kept outside the repo: the trace is the source, and it must be the thing
reviewed.

`result` on a `waitGone` is the line that fires the instant the wait ends. Always
supply one: it self-syncs to however long the work took, which a fixed offset
cannot.

## What the generator does with it

| Input | Output |
|---|---|
| `observedMs` on a `waitGone` | how many narration lines fit, and the holds between them |
| lines that do not fit | reported as unused, not silently dropped |
| an uncovered stretch over 6s | a `SPEEDS_MS` range printed in the header, ready to paste |
| every `intent` + `spec` | the selectors block and the sidecar, generated together |
| a script not ending on a hold | a `Settle` beat appended |

## Gotchas

| Symptom | Cause / fix |
|---|---|
| Typing goes nowhere on a freshly loaded page | The editor has not hydrated. Click, **wait ~1s**, then type, then verify the character count before submitting |
| Enter does not submit | It only fires reliably as the **first action of a fresh call**. A `wait` inside the same batch is not enough — put the keypress in its own call |
| A small button will not click | `computer` coordinates are **screenshot space**; `getBoundingClientRect` is CSS pixels. They differed by 1.07× here. Read coordinates off a screenshot, or use a `ref` from `find`/`read_page`. Wide targets hide this; small ones do not |
| A long poll returns an error | `javascript_tool` caps at 45s. Chunk it |
| Generated holds look short | They are sized from measured speech length, not round numbers. Trust them over a habit of `hold 2s` |
| A narration line went missing | It did not fit the measured wait. The generator reported it as unused — shorten it, or accept the fast-forward |
| `SPEEDS_MS` offsets are wrong on the real take | They are predicted from the walk. Always re-check against `assemble.mjs`'s gap report; generation time varies run to run |
| `observedMs: 0` on a waitGone | The element was already gone when you started timing. Confirm it is present first |
| Element not found mid-walk | You are ahead of the flow. Perform the earlier steps first |
| The walk sent something you did not intend | Stop. Report it plainly to the user, including what was sent and where |
