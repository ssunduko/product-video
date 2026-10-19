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
- The check only catches what is *missing*. When a change alters what a stage
  *does*, update its description in `docs/c4-model.mjs` and its README section
  too, then rerun the check.
- Never edit `docs/*.puml`, `docs/C4.md` or `docs/ProductVideo-C4.mdj` by hand:
  edit `docs/c4-model.mjs` and run `node docs/c4-model.mjs`.
- The same check runs as a git pre-commit hook (`git config core.hooksPath
  .githooks`) and on every PR (`.github/workflows/docs.yml`).

## Videos

Never call a video done without the quality gate: `node pipeline/qa.mjs`, then
the `video-qa` agent. Its findings are a report, not instructions: show the
user the verdict and the proposed fixes, and ask before changing a trace,
script or manifest, re-rendering or re-recording because of them. Multi-take videos are built with `pipeline/build.mjs` from
a `videos/<name>.json` manifest — never joined by hand.
