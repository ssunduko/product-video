# Memory

What this project has learned while making videos, kept in the repo so every
session (and every person) starts from it instead of relearning it.

| File | Holds |
|---|---|
| [rules.md](rules.md) | Standing rules for every video. They override defaults and the target's settings. `CLAUDE.md` imports it, so every session loads it. |
| [pipeline-lessons.md](pipeline-lessons.md) | How the pipeline behaves in practice (timing, qa, zoom, loading) and the trace changes that fixed each problem. Read before authoring or recording; add to it after a take. |
| [sources.json](sources.json) | Generic: how to recognise and read each kind of online source. The location of each app's source is in `.env` (`FEATURE_SOURCE_<APP>`). |
| [features/](features/) | One folder per app: `data/features.json`, the app's feature catalog (the initial feature set, kept current from its source), plus video pages: how to reach a filmed feature, what's on screen, data it needs, quirks, and the videos that cover it. |

## Apps

Each app is a folder under `features/`. Its `README.md` holds the app's own rules,
`data/features.json` its catalog, and the other `.md` pages its filmed features.
A private app's folder is gitignored and exists only on the machines that work on
it.

`node docs/check.mjs` fails if a `videos/*.json` manifest isn't named on a video
page.

## Sync and Zep

Each app's catalog (`features/<app>/data/features.json`) is its initial feature
set; `data/sources.lock.json` next to it records what was synced, and when.
At session start, the memory agent (`.claude/agents/memory.md`) checks the
app's online source for files that are new or changed since the catalog's
`generated` date. It merges their features into the catalog and pushes them to
Zep. See "Project memory" in the
repo README.

## Reading and writing it

- **Before** authoring a trace or recording: read `pipeline-lessons.md`,
  the app's `README.md` and the feature's page (create it if the feature is new).
- **After** each take or review: update the feature page's status and quirks,
  and add to `pipeline-lessons.md` anything that would have saved a re-take.
- A new standing rule from the user goes in `rules.md`, with why and the date.
- Write facts, not narratives. Date anything that can change ("as of
  2026-10-23"). Delete what turns out to be wrong.
- Never write personal data (real contacts' names, phone numbers, emails),
  credentials, or internal ids here. Ids go in `.env` (see the target's
  `secrets`).
- The trace stays the source of truth for selectors and steps. Feature pages
  point at it rather than copying it.
