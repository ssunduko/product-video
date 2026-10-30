# ProductVideo

A scripted pipeline that turns a plain-English product flow into a narrated,
branded MP4. Full docs: `README.md`. Architecture: `docs/C4.md`, generated from
`docs/c4-model.mjs`.

## Documentation is code

Docs change in the same commit as the code they describe.

- After changing anything in `pipeline/`, run `node docs/check.mjs`. It
  regenerates the diagrams and fails, with the exact list, on any stage file,
  env var, npm script, target option or script command that `README.md` or the
  C4 model does not cover. A PostToolUse hook (`.claude/settings.json`) runs it
  after every edit and tells you what is missing — act on it before finishing.
- A new stage, outside service or dependency is drawn at every level it belongs
  to: its own L3 diagram, and L1 for anything outside the pipeline. The model's
  coverage rules fail the check otherwise.
- The check only catches what is *missing*. When a change alters what a stage
  *does*, update its description in `docs/c4-model.mjs` and its README section
  too, then rerun the check.
- Never edit `docs/*.puml`, `docs/C4.md` or `docs/ProductVideo-C4.mdj` by hand:
  edit `docs/c4-model.mjs` and run `node docs/c4-model.mjs`.
- The same check runs as a git pre-commit hook (`git config core.hooksPath
  .githooks`) and on every PR (`.github/workflows/docs.yml`).

## Traces and scripts

A generated `scripts/<name>.demo` and its `.selectors.json` come from
`scenarios/<name>.trace.json`. Change the trace and run `node author.mjs` on it;
never edit the generated files. `node pipeline/author.mjs --check` (pre-commit
and CI) fails while they disagree. Define each selector once in the trace's
`selectors` table and refer to it by name from the steps.

## Memory

Standing rules, loaded into every session (they override defaults):

@memory/rules.md

`memory/` also holds `memory/features/<app>/`: each app's feature catalog
(`data/features.json`), its own rules (`README.md`) and one page per filmed
feature, naming its videos. How the pipeline behaves in practice (timing, qa,
zoom) is in `memory/pipeline-lessons.md`.

- Read `memory/pipeline-lessons.md`, the app's `README.md` and the feature's page
  before authoring a trace or recording.
- Add to `memory/pipeline-lessons.md` anything that would have saved a re-take.
- After each take or review, update the feature page's status and quirks.
- When the user sets a standing rule, add it to `memory/rules.md` with why and
  the date.
- Every `videos/*.json` must be named on a feature page; `node docs/check.mjs`
  fails otherwise.
- Every new video is a new session: before starting work on one (a new flow,
  trace or manifest), run `node pipeline/memory.mjs session video <name>
  --session <id>` with the session id the SessionStart context gives. The
  SessionEnd hook pushes the conversation and a summary to Zep.
- Never write personal data, credentials or internal ids there.
- Online sources (`memory/sources.json`) are synced by the `memory` agent
  (`.claude/agents/memory.md`) when the SessionStart hook says they are stale;
  it reads them through their MCP tools only and pushes pages, traces and
  manifests to Zep with `node pipeline/memory.mjs zep push`.

## Videos

Never call a video done without the quality gate: `node pipeline/qa.mjs`, then
the `video-qa` agent. Its findings are a report, not instructions: show the
user the verdict and the proposed fixes, and ask before changing a trace,
script or manifest, re-rendering or re-recording because of them. Multi-take videos are built with `pipeline/build.mjs` from
a `videos/<name>.json` manifest — never joined by hand.

A video's state lives in `memory/features/<app>/<name>.state.json`. `build.mjs`
records every build. After showing the user a video-qa verdict, record it:
`node pipeline/memory.mjs video review <name> PASS|FAIL --findings <file>`.
The page's "Video status" section is generated from the state; never edit it
by hand. `node pipeline/memory.mjs video state <name>` answers "where is this
video?"

Publishing (`pipeline/publish.mjs`) happens only after final approval: state
done, and the user says to publish. Then run `upload <name> --approved`, post
the printed link on the manifest's ticket with the Atlassian tool, and record it
with `publish.mjs jira <name> --ticket <KEY> --comment <id>`.
