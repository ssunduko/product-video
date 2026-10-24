# Pipeline in practice

What the stages actually do to a take, and the trace changes that fixed each
problem. The README says what the stages are; this page says how to get a pass.

## Timeline

- **Where a line lands in the final video.** The finished video adds the intro
  card, so the body starts about 4.3s in (a 5.05s card minus a 0.75s crossfade).
  A line's time in the final video is its `atS` in `qa.json` plus about 4.3s.
- **Unnarrated waits are fast-forwarded.** With `AUTO_SPEED=10`, a silent wait
  of 2s or more (`AUTO_SPEED_MIN_MS`) plays 10x. A `say` placed before a wait
  stops that wait from being fast-forwarded, so the loading shows at full
  length.
- **Wait timeouts** are max(10s, 3 × `observedMs`). Size `observedMs` from the
  slowest load seen, not the walk.
- **Hold sizing.** A `say` doesn't block, so the hold after it has to cover the
  spoken length. The voice runs about 12 characters a second. When qa reports an
  overlap of N ms, add N + 100 ms to the hold before the next `say`.
- **Hovers take time.** A hover glides for 350–1100 ms (0.9 ms per pixel). To
  land on a word, add up the holds and glides from the line's start. Long runs
  of hovers fall behind the voice, so hold less between them than the word
  gaps suggest.

## qa.mjs

- **"Frozen" FAIL** means the picture barely changes and less than about 60% of
  the stretch is narrated. Small cursor moves on a still page count as frozen.
  Fix it by removing silence (shorter holds, a guard run under a line), not by
  adding narration.
- **"Frozen" WARN with narration over 70–100%** is a narrated hold on finished
  content. It's fine if the page isn't loading.
- **A "deadair" WARN** is a silent gap over about 5s, usually a slow load
  between two lines.
- **The joined qa** (`--cues none`) can segment frozen runs differently from
  the part's qa. A difference between them is not proof of an artifact: check
  the stills.
- **A qa.mjs PASS doesn't cover loading spinners or personal data.** Only the
  visual review catches them.

## Zoom and cursor

- **The zoom centres on what the cursor hovers or clicks.** To pan right, act on
  an element on the right (for example open a grid row through a right-hand
  cell). A full-width input centres the zoom mid-page, off the text being typed,
  so hover the input's left end or its icon.
- **Before a line about something, hover it.** The hover forces a fresh frame,
  because the CDP screencast can skip frames until input arrives. Without one,
  a loaded page can sit on a stale frame (Sources froze for 3.6s).

## Loading

- **Speak only once everything in view has loaded,** not just the element the
  line is about. A page with several panels (header, tiles, a table below) needs
  a wait on the slowest panel, or the spinner shows under the narration.
- **Wait for a spinner to go.** Use `waitGone` on `[role="progressbar"]` when
  values arrive after the frame (tiles that render empty first).
- **Allow for live-app variance.** On a live app, load times swing 5–10x
  between takes, and the frame count can halve. A take that aborts on a wait
  usually means the app stalled: check the app before changing the script.

## Guards

- **`ifAppears` costs its full timeout when nothing appears.** Put it under a
  line (after a `say`) so the wait isn't silent. A guard at the very start of a
  take makes a frozen, silent opening.

## Files

- **The zoom project file** is `out/<part>/<take>.recordly`, named from the
  script. Re-render a recorded take without Chrome with
  `build.mjs <manifest> --only <part> --no-record`.
- **Stage outputs** are named after the stages that made them
  (`final-narrated-tight-carded.mp4`). The manifest's `output` is the deliverable.
