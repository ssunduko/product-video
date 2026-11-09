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

### Every new video is a new session
Before starting work on a new video (a new flow, trace or manifest), run
`node pipeline/memory.mjs session video <name> --session <id>`. Every session
ends with its conversation and a summary pushed to Zep (SessionEnd hook).
*Why:* the user wants each video's work attributable and summarized on its own
(2026-10-24).

### Publish only after final approval
A video is published (uploaded to its app's destination, link posted on its
ticket) only when its state is done and the user has said to publish it.
`publish.mjs upload` refuses without `--approved`. Never pass it without the
user's go-ahead for that video. Posting the Jira comment is part of publishing.
*Why:* the user set this on 2026-10-24.

### A video is done only after both gates
`qa.mjs` PASS and a video-qa visual review with no FAIL. A qa.mjs PASS alone is
not done: an earlier take passed qa.mjs and still showed loading
spinners and personal data.
The user may still take a build that failed a gate. Only on their explicit
word, record it with `node pipeline/memory.mjs video accept <name> --reason
"<their words>" --findings <file>`. That puts the video in "accepted", which
publish.mjs allows, and never records a PASS.
*Why:* the user accepted a take with its open findings and asked to publish
it (2026-10-27).

## Content

### Invent identifying details, never blur them
Real names and identifiers never reach the screen, and nothing is blurred or
masked in their place. Every one is replaced with an invented value that is
random yet fits its context, through the target's `replaceText` (text nodes
and input values, every format and every abbreviation the app draws):
- **People** (contacts, members, owners, reps): a random first and last name,
  the same one every time that person appears, initials and avatars to match
  (`Pat Lane` -> `Maya Brooks`, `PL` -> `MB`).
- **Phone numbers** of contacts: a random number in the reserved 555-01xx
  range, so it reaches no one. A test inbox's own number may show.
- **Inboxes:** at most one inbox is called `Sales Inbox` and at most one
  `Marketing Inbox` (the ones the flow uses). Every other inbox gets a random
  business name that fits a company's inbox list (`Support Line`,
  `Billing Desk`, `Demo Requests`), never a number suffix.
- **Everything else the account named:** tags, broadcasts, campaigns, AI
  agents, triggers, workflows, smart views, saved replies, custom fields,
  companies on contacts. Random, but as contextual as possible: a tag reads
  like a real sales tag (`Hot Lead`, `Demo Booked`), a broadcast like a real
  campaign (`Spring Sale Reminder`), an agent like a real assistant
  (`Lead Qualifier`). No test or debug names (`test-123`, `Delete Me`)
  and no real person's name inside any of them.
Check every load in review, not only the settled screen: an app can draw the
real value for a few frames before the swap (an `<input>` the app re-sets), or
draw it somewhere the swap does not reach (avatar initials).
A real name, number or account-named item on screen blocks publishing.
*Why:* an earlier take showed a real contact (2026-10-23); blurred fields look
broken in a feature video, so the user replaced the blur rule with invented
values (2026-11-08), and the same day asked for every name to be random yet
contextual, with only one Sales Inbox and one Marketing Inbox.
*Exceptions:* videos published under the old blur waiver are listed in
the app's `memory/features/<app>/README.md`; they are not
re-cut.

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
