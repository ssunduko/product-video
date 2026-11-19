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
- **A part with no outro card ends on its last hold.** That freeze runs to the
  end of the file. Until 2026-10-24 qa failed it whatever its narration (a
  first part, twice); now it's scored by narration like any other. Still, end such a part on its last line: a closing line on a
  static page adds a long still tail.
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
- **Every hover, click and type is framed in red** (compose.mjs, from takes
  recorded on 2026-10-28 on). A hover that only parks the cursor, such as
  moving it back to a panel's input, is framed too, so park it on something
  the next line is about, or on the input the next `type` uses. A hover's
  frame lasts until the next action, at most `HIGHLIGHT_HOLD_MS` (4s): when a
  chat answer scrolls the panel, the frame can be left on the old position,
  so act again (or end the hold) before the content moves.
- **Check a red frame against overlays before recording.** The driver frames only
  the part of an element nothing covers, but a big element (a table, a scroll
  view) under a side panel can show in two places, beside the panel and below
  it. The first version boxed both and framed straight through the panel
  (2026-10-28); it now keeps the main visible block. Prefer hovering something
  that sits clear of the panel anyway.
- **Before a line about something, hover it.** The hover forces a fresh frame,
  because the CDP screencast can skip frames until input arrives. Without one,
  a loaded page can sit on a stale frame (Sources froze for 3.6s).
- **Fast-forwarding streaming text leaves ghost text.** The user rejected
  an assistant-panel take for it (SPEEDS_MS up to x25 plus AUTO_SPEED x10 over
  the assistant's answers). Over a chat panel, cover the wait with narration instead:
  `say`, a hold sized to the line, a second `say` and a hold that lets it
  finish, then the `waitGone`.
- **Speed typing up, don't leave it to tighten.** Covering each silent stretch of
  typing with a `SPEEDS_MS` range (x3–x4) leaves tighten no dead run to
  crossfade there: on one take that took tighten from 6 seams to none, cleared
  every ghost and passed both gates on a re-render, with no new recording
  (2026-10-28). Size the ranges on the take's own timeline, so they only fit a
  re-render of that take.
- **Don't hover a card in a chat panel after a long answer.** The answer
  scrolls the card out of view, so the hover lands outside the panel and the
  cursor drifts onto the page behind it. Size the hold
  to the line instead: a 6s hold after a 2.6s line failed qa as frozen.

- **Clicks a few seconds apart zoom in and out at each one.** Clicks merge
  into one zoom only under 2.5s apart. On a panel driven step by step (tick,
  Stop, Resume 4-7s apart) the user saw the view go in and out repeatedly.
  Set `ZOOM_MERGE_MS` above the beat's largest click gap (Stop -> Resume was
  ~9s, so 7000 still failed in take 5; 9000 merged it). A zoom never spans a
  page open (`raw.mp4.opens.json`), so a wide gap cannot run a zoom into the
  next section. A re-render is enough (2026-11-08).

- **A section card must come before its page, not before its line.** Once
  beats opened their page before speaking (to keep lines off loading screens),
  cards placed just before the first line let the next feature's screen show
  before its announcement (user, 2026-11-08). cards.mjs now places a card at
  the beat's page `open` (`leadAtMs`, which assemble.mjs derives from the
  take's recorded waits, so a `--no-record` re-render of an older take gets it
  too); a beat with no `open` before its line falls back to the line.
- **…and after the previous line, and the take resumes on the new page.** The
  open can start while the previous line is still speaking (the hold before
  it shorter than the line): the card then waits for the line to end, or the
  card cuts the line in two (the user called it "loss of sync" at 0:26 and
  2:49). After the card the take resumes when the open has finished
  (`leadEndMs`), or the old screen flashes back between card and new page.
  `author.mjs` notes an `open` that starts before the line ends: lengthen the
  hold it names (2026-11-08).
- **Never speed up the hold that shows a beat's result.** A 3x `SPEEDS_MS`
  range over the 1s hold after Resume left 0.33s of the resumed state, and the
  card took the rest. End ranges where the result appears (2026-11-08).

- **Replaced values can flash the real one on load.** The app re-sets an
  `<input>` (a contact's Phone field) on every render; a 150ms timer swap let
  the real number show for a few frames at three loads in take 5, which line
  stills never caught. `textReplacer` now wraps the input `value` setter. In
  review, step through loads at 0.1-0.2s (2026-11-08).
- **Avatar initials are not text.** One app draws them with CSS
  `content: attr(data-name)`, so replacing the name left the real initials
  (the real initials beside the invented name, take 6). The replacer swaps `data-name` too;
  when another app draws text from an attribute, add it to `ATTRS` in
  `textReplacer` (2026-11-08).

## Loading

- **Check a page in the recording profile, not only in your own browser.** A
  flow-editor canvas opened its step dialog on a JS click in the user's
  Chrome, but in the take it was a read-only preview behind an "Edit"
  overlay, so the wait for the dialog timed out. The same canvas took
  24s to draw (a wait's default limit is `observedMs`x3, at least 10s). Set
  `observedMs` from a timed load, and prefer hovering what the preview already
  shows over opening editors (2026-11-08).

- **Speak only once everything in view has loaded,** not just the element the
  line is about. A page with several panels (header, tiles, a table below) needs
  a wait on the slowest panel, or the spinner shows under the narration.
- **Wait for a spinner to go.** Use `waitGone` on `[role="progressbar"]` when
  values arrive after the frame (tiles that render empty first).
- **Picture behind the voice.** If lines seem to play ahead of the screen more
  and more as the take goes on, check `frames.json` for timestamps that step
  back. One take had 102 such frames, and the picture ended 3s behind
  the voice; qa.mjs's sync check can't see it, because it only compares audio
  with cues. `assemble.mjs` now drops those frames (2026-10-27), so re-render
  any take assembled before that.
- **Volume rising and falling between lines.** The default `NARRATION_FILTER`
  (`speechnorm` + single-pass `loudnorm`) adjusts the volume continuously while
  the track plays. Clips are already levelled before the mix, so a fixed master
  is enough: `volume=4dB,alimiter=limit=0.84:level=false:attack=5:release=50`
  in the manifest's `env`. On one take it kept -16.2 LUFS,
  narrowed the phrase spread from 6.0 to 4.6 LU, and cut the loudness range
  from 8.4 to 7.7 LU (2026-10-27).
- **A tool card is not the page.** When an assistant opens a page, a wait on
  its "Open …" tool card still lands before the page loads, and the line plays
  over the page's spinner. Wait on an element of the opened page instead
  (an "Open … form" tool card came 3.5s before the form itself).
- **Allow for live-app variance.** On a live app, load times swing 5–10x
  between takes, and the frame count can halve. A take that aborts on a wait
  usually means the app stalled: check the app before changing the script.

## Guards

- **`ifAppears` costs its full timeout when nothing appears.** Put it under a
  line (after a `say`) so the wait isn't silent. A guard at the very start of a
  take makes a frozen, silent opening.
- **`ifAppears` is the non-fatal wait for something outside the take** (a reply
  sent from another inbox, an AI agent's answer): `if @x appears within 150s`
  moves on as soon as it shows, or after the timeout, where a `wait` would
  abort the take. Follow it with a hard `wait` once the page has been reloaded
  (2026-11-17).
- **...but it only ends early if the thing draws in the take's browser.** When
  pushed messages never draw live, the guard runs its full timeout, and
  `AUTO_SPEED` and tighten leave minutes of a still screen (a 150s guard made
  2.5 minutes of dead air). Keep the timeout near the expected time (60s for
  an agent's answer) and cut the span with `CUTS_MS` in the manifest.

## Red frames

- **A hover on bare text frames only the text.** A list option, a table cell's
  name or a field label is a text node's box, so the red frame hugs the word
  and crosses the icon, the badge or the field border around it. The rule
  (rules.md) is to frame the text with its surrounding box: hover the row,
  option or field. The driver now frames the visible container of bare text
  (`frameBox`); for a take recorded before that, widen the `targets[]` box in
  `actions.json` to the row and re-render (2026-11-17).
- **Check every red frame in review**, not only the line stills: the stills
  catch what a line plays over, not every hover between lines.
- **Frames all off in the same direction mean a scale bug, not bad boxes.** A
  take captured its frames at 1456x799 while the driver logged a 1440x810
  viewport; normalising by the logged size drew all 24 frames and the cursor
  up and to the right, worse toward the bottom right. assemble.mjs now
  normalises by the captured frame size and warns ("frames are WxH, not the
  logged viewport"); if that warning shows, the take's boxes are still right
  (2026-11-17). Compare `ffprobe` of a frame with `actions.json` `viewport`
  when frames look off.
- **Frame the whole tile.** A stat (label, number, percentage) is one card:
  frame the card, not its text. Cards a few pixels apart leave no room for the
  6px frame pad, so inset the box by about 3px. A message bubble with a hover
  toolbar over its top edge is framed with the toolbar inside.

## Live AI agents in a take

Learned on a booking-agent video that took five takes (2026-11-17).
- **Walk the flow once before the take, and expect the walk to change it.** The
  walk found that booking itself failed in the app, that reconnecting a
  calendar integration emptied the agent's calendar setting, and that published
  agent changes only reach new sessions.
- **An AI agent reads the whole thread when a session starts.** Earlier failed
  sessions, auto-replies and bot messages in the thread shape its opener (one
  apologised for earlier failed bookings on camera). Use a thread with no
  earlier agent, bot or auto-reply messages; failed takes add history, so each
  retake on the same thread gets worse.
- **The receiving side must stay silent.** When the "contact" is another inbox
  of the same account, that inbox's own AI agent or after-hours auto-reply
  answers first: two agents talked to each other until the session closed, and
  an auto-reply made the agent treat the contact as away. Turn them off, and
  record in business hours.
- **Waits must key on text new to the thread.** A wait on text the history
  already holds passes at once and the narration runs ahead. Send replies with
  wording the thread has never had, and wait for the agent's answer to it.
- **Match message bubbles, not list previews.** A text selector also matches
  the conversation list's preview of the latest message, which comes first in
  the page. Scope waits and hovers to the thread's message list.
- **The recording browser may never draw pushed messages.** Live updates that
  showed in the user's own browser never drew in the take's browser; a status
  notice came seconds late. Reload the conversation after the external event
  and wait on the thread bubble.
- **Replies take SMS time:** 6-70s for an agent's opener after enrolling,
  10-30s per answer, and about 20s carrier delay each way between two inboxes
  of the same account.
- **Clean up after every take:** stop the agent for the contact, clear any field
  it filled (an email it collected), and check nothing was booked.
- **Give a booking a real mailbox, never `@example.com`.** Every booking with
  a test contact's `@example.com` address failed as a "server error" (two agents, two
  calendars, reconnects and fresh sessions), while the same agent booked at once
  for a contact with a real address: the calendar refuses a guest at a reserved
  domain, and the agent reports it as a system error. A day of reconnecting was
  spent on it (2026-11-17). Use a mailbox the user owns; the target's
  `replaceText` shows an invented one on screen.
- **The test panel does not book.** An agent editor's "Test agent" chat finds
  open slots but creates no event; enroll a real contact to test booking.
- **Re-enrolling keeps the thread's context.** A new session reread the old
  thread and retried the old slot, ignoring a new time the contact asked for.
- **Capturing stills with the browser extension** (2026-11-18): never call
  `resize_window` on a maximized window (the tab went to a 0x0 viewport and
  froze until the person restored it); `save_to_disk` with `scale` saves the
  scaled image, so save at full scale; Google pages enforce Trusted Types, so
  staged HTML needs a `trustedTypes.createPolicy`; keep a staged popup as a
  cloned node or HTML before navigating, the app closes it; hover the far
  bottom-right pixel so no pointer is drawn. Match the chat: the stills must
  show the day and time the conversation agreed, in the calendar's own zone.
- **Measure red frames for stills against the neighbours** before capturing:
  a 30-minute event 2px under another left no room for a frame outside it;
  move the staged element, or draw the frame on its own edge.
- **Show what the take cannot record with stills, not a re-take.** A result in
  another app (the event on Google Calendar) goes in as a screenshot through the
  manifest part's `inserts` (inserts.mjs), after the section card it belongs to.
  Stage the page before capturing (in-page text swaps to invented names, titles,
  Meet codes and dial-ins; avatar photos to initials), re-run the swap right
  before each capture because the app redraws and restores real titles, and
  check the saved file, not the live tab.

## Publishing

- **The YouTube API reaches a channel only through its brand account.** A
  Google account invited in YouTube Studio → Settings → Permissions (even as
  Manager, and even when the channel shows in YouTube's Switch account list)
  can upload in Studio, but Google's sign-in never offers that channel to an
  app: the token comes back with no channel, or the person's own channel once
  one exists. `channels.list mine=true` returning `totalResults: 0` means
  exactly that, not a code or API fault. Retrying the sign-in does not help;
  a brand-account manager or the owner must sign in once (`publish.mjs auth
  youtube` asks Google for the account chooser, `prompt=select_account`).
  Seven sign-ins were spent learning this (2026-11-11).
- **Until then, upload in Studio with the browser extension.** Its
  `file_upload` takes files under 10 MB, so the person picks the MP4 in Studio's
  dialog. Then fill the form from `publish.mjs check`: title, description,
  thumbnail (the file input in the Thumbnail section), tags, category, and
  subtitles under Video elements → Subtitles → Upload file → With timing (the
  hidden input `#captions-file-loader` takes the .srt directly; Continue would
  open the system picker). The AI-use question and the final Publish are the
  person's own answers: leave them to them.
- **A channel's upload defaults apply to Studio uploads.** Default tags were
  already in the tag field and the category defaulted to the channel's own;
  read the form before typing, keep or replace them on purpose.
- **Subtitles: anchor each line to the speech, not the edit alone.** Section
  card cut points (`at`/`resume`) are not saved, so the body offset after each
  card is taken from the first speech onset after the card's span. With the
  intro card's length less its dissolve as the first offset, the predicted
  starts landed within 0.03s of the real onsets (`publish.mjs subtitles`).
- **Studio confirms HD before publishing**: "Processing up to HD" during the
  upload, and `videos.list` reports `definition: hd` afterwards.
- **An eighth sign-in (2026-11-18) reached the personal channel again.** Do not
  run `auth youtube` for this account until the channel owner has added it to
  the Brand Account (myaccount.google.com/brandaccounts → the channel → Users →
  Manage permissions → Invite new users, as Manager or Owner; only an owner
  sees that page), or until the owner runs the sign-in on this machine. A
  quick test: the account sees the channel on its own brandaccounts page.
- **A hand upload needs the spec, not just `check`.** Give the person every
  field: file paths (video, thumbnail, .srt), title, description, tags,
  category, audience, altered content, language, subtitles, visibility.
- **A manifest `youtube.description` replaces the generated one whole,** so the
  chapters and the outro's contact line disappear. Leave it out, or write the
  chapters into it.

## Music and diagrams

Learned building music.mjs and diagram.mjs (2026-11-18).
- **The music bed's loudness looks low on paper.** A ducked bed measures about
  -35 LUFS integrated, but in narration pauses it sits about 13 dB under the
  voice (-28.5 against -15.7 LUFS on a 2:31 video). Judge it in the pauses,
  not on the whole-file number. The first section of every piece is sparse by
  design: a pause there measures much quieter.
- **Music changes almost nothing else.** Integrated loudness moved 0.1 LU and
  peaks not at all after mixing, because the bed is ducked under the speech.
  A rendered 2:31 bed took about 20 s; the whole stage took about 80 s, mostly
  measurement passes.
- **Adding music to an approved video is a join-only rebuild** (2026-11-19).
  The routine:
  1. Copy the deliverable aside (`<name>.no-music.mp4`).
  2. Add the manifest's `music` block.
  3. Run `build.mjs --join-only`: it re-joins, mixes, and gates the joined video.
  The rebuild resets the state to "awaiting review". The re-join re-encodes the
  same parts the same way, so a PSNR of `inf` against the copy proves the
  picture is the reviewed one, frame for frame. Record the review on that,
  with the music measurements: the pauses before and after, the speech
  unchanged, and the integrated loudness. A full visual review is not needed.
  Publishing then adds a Drive revision, and the link stays.
- **Nobody can hear the result but the user.** Numbers say the voice is clear;
  only the user can say the music fits. Ask before it goes in a manifest.
- **Diagram boxes need gaps sized to their labels.** Even spacing put arrow
  labels on top of the boxes. Lay a flow out from the real box widths, and give
  each gap the widest label crossing it plus room for the arrow. Five boxes in
  a row only fit after scaling down; the renderer does that before warning.
- **Groups follow their visible members.** A group drawn at its final size in
  an early step framed empty space.
- **Run vendored code only with the user's go-ahead.** Running code fetched
  from another repo was blocked until the user said yes; vendor it with its
  licence and a note of the commit (pipeline/vendor/README.md).

## Files

- **Edit files with an editor, not `sed -i`, on Windows.** `sed -i` rewrote
  CRLF files as LF, so git showed whole files changed (2026-11-11).
- **Script edits must match line endings.** A node replace written with `\n`
  missed text in a CRLF file, and JS strings written through a shell heredoc
  lost their escaped apostrophes and broke `docs/c4-model.mjs` (2026-11-18).
  Normalise to `\n` before matching and restore CRLF after, keep apostrophes
  out of C4 strings, or use the Edit tool.
- **An agent file must start with `---`.** `.claude/agents/video-qa.md` began
  with a corrupted line (`++++…---`), so its frontmatter never parsed and the
  agent never loaded; it went unnoticed for a week (fixed 2026-11-18).
- **Run new integration tests on their own locally.** The full suite takes
  about 10 minutes; under memory pressure, Windows failed to start ffmpeg and
  node (exit 3221225794, 0xC0000142) in tests the change never touched. Run
  `node --test test/integration/<new file>` here, and the full suite on CI.
- **The zoom project file** is `out/<part>/<take>.recordly`, named from the
  script. Re-render a recorded take without Chrome with
  `build.mjs <manifest> --only <part> --no-record`.
- **Stage outputs** are named after the stages that made them
  (`final-narrated-tight-carded.mp4`). The manifest's `output` is the deliverable.
- **Never leave a shell inside `out/<video>/<part>/` on Windows.** A shell whose
  working directory is the frames folder locks it, and the next take fails with
  `EPERM` before it starts; even after `cd` out, a handle can stay. Read frames
  by absolute path. If the folder stays locked, rename the manifest part so the
  take records into a new folder (2026-11-17).
- **Fix a recorded take in `actions.json`, not in assemble's outputs.**
  `--no-record` re-runs `assemble.mjs`, which rewrites
  `raw.mp4.narration.json` and `raw.mp4.highlights.json` from the take's
  `actions.json`, so edits to those are lost. Edit the source instead and a
  plain `build.mjs <manifest> --only <part> --no-record` keeps them: move a
  line (`narration[].t`, epoch ms), add one (a new `{ t, text }`), widen a red
  box (`targets[]` x, y, w, h in viewport pixels). Back the file up first, and
  mirror the change in the trace so the next recording has it. (Running
  narrate, tighten, cards and qa by hand, then `--join-only`, also works but
  does not survive the next re-render.)
- **Cuts are timed from the first frame**, not the first cursor sample in
  `actions.json`; they differed by 3.2s on one take. Put `CUTS_MS` /
  `SPEEDS_MS` in the manifest's `env` so every re-render repeats them.
- **One target per video when rules clash.** A whole-text rule one video needs
  (`T` -> `M` for one contact's initials) can be wrong in another (`T` -> `R`).
  Copy the target and change the copy rather than the shared one. A target's
  `styles` draws what replacement cannot reach, such as the signed-in user's
  photo as the invented person's initials.
- **Start from `input/<name>.flow`.** The flow comes first, then the trace
  written while walking the app, with each selector and measured wait
  recorded as it is found; `author.mjs` makes the `.demo` and its sidecar from
  the trace. Writing the trace from memory afterwards loses the evidence.
- **The flow stays the source of the user's wording.** When the user edits
  copy in the `.flow` (an intro subhead), carry it into the trace, regenerate
  with `author.mjs`, and run `author.mjs --check`; the take only reads the
  generated script.
- **`cards.mjs` reads the script when its stage starts**, after compose. A card
  copy change regenerated while a build is still composing lands in that
  build; once cards has run, it needs a cards re-render (2026-11-17).
