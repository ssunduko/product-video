# Vendored code

Third-party code the pipeline runs, kept here unmodified with its licence.

| Folder | What | Licence | Used by |
|---|---|---|---|
| `music-engine/` | music and sound synthesis: styles, synth, DSP, mixing | MIT, `music-engine/LICENSE` | `music.mjs` |
| `lucide/` | 1,854 Lucide icons as SVG paths, with aliases for old names (Lucide 1.48.0) | ISC, `lucide/LICENSE` | `diagram.mjs` |

Keep each licence file with its code. After updating either one, run
`npm run test`: the music tests check that the engine is still deterministic
and not silent.
