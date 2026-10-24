# Rules

Standing rules from the product owner. They apply to every video unless the
rule names a target. Each has the reason it exists, so edge cases can be judged.

## Process

### Ask before applying QA fixes
After `qa.mjs` or the video-qa agent reports, show the verdict and the proposed
fixes, and wait for a yes before changing a trace, script or manifest,
re-rendering or re-recording.
*Why:* the Enhance agent instructions video went through ~9 re-takes where each
FAIL was applied straight away (2026-10-18). Also in `CLAUDE.md` and
`.claude/agents/video-qa.md`.

### A video is done only after both gates
`qa.mjs` PASS and a video-qa visual review with no FAIL. A qa.mjs PASS alone is
not done: the click-tracking take passed qa.mjs and still showed loading
spinners and personal data.

## Content

### Blur contact details
Blur any contact's full name, phone number, email address and tags wherever
they appear on screen (contact tabs, contact rows, names next to avatars,
conversation headers). Blur, don't hide or drop the step. An unblurred one
blocks publishing.
*Why:* the click-tracking take showed a real contact on the Contacts tab
(2026-10-23).
*Status:* the pipeline only hides elements (`hideSelectors`, display:none) and has
no blur option yet. One is needed before this rule can be met.

### Match the samples
`sample/` holds model videos (cards, outro, pacing, style). Compare new videos
against them during review. Its contents are app videos, so they are gitignored
and kept on disk: only the folder is in the repo. Only add a video there once it
passes both gates and has no personal data on screen.

### App-specific rules live with the app
Rules that hold for one app only (its start page, its outro) go in
`memory/features/<app>/README.md`, next to its catalog, so a private app's rules
stay private with it. Read that file before working on the app.

### Private apps stay out of the repo
An app whose target is gitignored is private. Its flows, traces, scripts,
manifests, catalog, video pages and brand files are gitignored too: add each new
one to `.git/info/exclude` (local, never committed) when you create it, so the
public `.gitignore` names no private app.
*Why:* the user asked for no private app assets in the repo (2026-10-23); the
repo is public.

### Words the voice gets wrong
Never "lives in" / "lives": the voice reads it as the plural of "life". Say
"Here is where you will find …" instead. Add others here as they come up.

## Recording

### Close app popups in the script, not the target
Popups that belong to the account state (for example a plan-limit alert)
are closed by an `ifAppears` guard in the trace, not hidden through the
target's `hideSelectors`. `hideSelectors` is for banners unrelated to any flow.

### Live data: look, don't touch
Recording runs against a live account. Stop and ask before any step that sends,
creates, edits or deletes. Never click a tracked short link, because it
registers a real click. Open rows through a cell that isn't a link.
