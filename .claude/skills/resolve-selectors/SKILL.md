---
name: resolve-selectors
description: Resolve the natural-language `ask "..."` selectors in a pipeline .demo script against the live app, using the Claude in Chrome extension, and write the <script>.selectors.json sidecar. Use when a script has unresolved intents, when compiling or recording fails with "selector(s) still state an intent", or when a redesign has broken selectors that used to work.
---

# Resolving natural-language selectors

A `.demo` script says what it means:

```
selectors:
  composer = ask "the message box at the bottom of the chat"
```

Your job is to find what that actually is in the live DOM and write it to
`scripts/<name>.selectors.json`, so `script.mjs` can compile it into an ordinary
selector and `driver.mjs` can record a deterministic take.

**You are the resolver.** Nothing in the pipeline calls a model — `script.mjs`
reads the sidecar and refuses to compile without it. Resolution happens here,
once, before recording, because the take's timing is the video timeline and a
model round-trip during a run would land in the finished video as dead air.

## Before you start

- The app must be reachable and, if it needs a login, **already signed in** in
  the user's Chrome. That is the point of using the extension: it reaches the
  real session, so there is no SSO ritual and no email code to fill.
- Read the script first. You need the `app:`/`target:` header for the URL, and
  the beats, because selectors have to be resolved in flow order (see below).

## Procedure

1. **Get the work list.**

   ```
   cd pipeline
   node script.mjs ../scripts/<name>.demo --intents
   ```

   JSON on stdout: every `ask` selector, its intent, and its current resolution
   (`null` if unresolved). Resolve the nulls. Re-resolve the rest only if the
   user says the flow is broken.

2. **Load the browser tools in ONE ToolSearch call**, then call
   `tabs_context_mcp` before anything else. Create a new tab with
   `tabs_create_mcp` unless the user pointed at an existing one.

3. **Walk the flow in beat order.** This is the part that is easy to get wrong:
   many selectors do not exist on the landing page. A results table appears only
   after a question is sent; a "Stop" control exists only while something is
   generating. So step through the script's beats, resolving each `ask` at the
   moment its element is on screen.

   **Live data. Before any step that creates, modifies, sends or deletes
   anything, stop and ask the user.** `feature.demo` sends four messages to a
   real, live account. Hover instead of clicking where you only need to
   locate something, and never click a destructive control to "see what it is".

4. **Find the element and pick the most durable handle.** In preference order:

   | Prefer | Why |
   |---|---|
   | `[data-testid=...]`, `data-test`, `data-qa` | put there to be selected; survives redesigns |
   | a stable `id` | good unless it looks generated (`:r3a:`, `id-1a2b`) |
   | button/link by exact accessible name → `btn:Name` | the driver's `btn:` matches text, `aria-label` and inner `img[alt]` |
   | `[aria-label=...]`, `[role=...]` | stable, and usually semantic |
   | semantic structure (`main table`, `nav a[href="/teams"]`) | survives styling churn |

   **Never** use: `nth-child` chains, generated class names (`css-1a2b3c`,
   long Tailwind stacks), or anything keyed on **generated content**. That last
   one is the trap this whole feature exists to avoid — a model's answer is
   worded differently on every run, so a selector matching its text is a coin
   flip. Anchor on the container or on a completion signal instead.

5. **Verify before you write it.** For each candidate, confirm with
   `javascript_tool` that it matches **exactly one** element and that the
   element is visible:

   ```js
   const q = 'div[data-testid="chat-input"]';
   const n = document.querySelectorAll(q);
   console.log(JSON.stringify({
     q, count: n.length,
     visible: n[0] ? !!(n[0].offsetWidth || n[0].offsetHeight) : false,
     tag: n[0]?.tagName, editable: n[0]?.isContentEditable,
   }));
   ```

   Read it back with `read_console_messages`. More than one match, or zero, means
   keep looking — do not write a selector you have not seen match.

6. **Write the sidecar**, `scripts/<name>.selectors.json`:

   ```json
   {
     "resolvedAgainst": "https://claude.ai/new",
     "resolvedAt": "2026-08-10T09:00:00Z",
     "resolvedBy": "claude-in-chrome",
     "selectors": {
       "the message box at the bottom of the chat": {
         "spec": "div[data-testid=\"chat-input\"]",
         "evidence": "contenteditable tiptap div, aria-label 'Write a message', 1 match, visible"
       }
     }
   }
   ```

   Keyed by the **intent text**, verbatim from the script — renaming a selector
   or reordering the block must not orphan a resolution. `spec` is whatever the
   driver accepts: a raw puppeteer selector, `btn:Text|Alt`, or
   `::-p-text(substring)`. `evidence` is what you actually observed; write it so
   the next person can tell whether it still holds.

7. **Confirm and hand back.**

   ```
   node script.mjs ../scripts/<name>.demo --intents   # expect 0 unresolved
   node script.mjs ../scripts/<name>.demo --print     # compiles
   ```

   Report what you resolved, what you had to guess between, and anything you
   skipped because it needed a destructive step.

## When you cannot resolve one

Say so and stop; do not invent a selector. An unresolved intent is a clean
compile error before Chrome is even launched. A wrong one fails mid-take, after
the recording has started — the expensive place to fail. If two elements match
the description equally well, ask the user which they meant rather than picking.

## Gotchas

| Symptom | Cause / fix |
|---|---|
| The element is not on the page | It appears later in the flow. Walk the beats in order; resolve each intent when its element is actually on screen |
| Two elements match | The description is ambiguous. Narrow it with the user, then also reword the `ask` in the script so the next resolve is unambiguous |
| Selector works now, breaks next run | It is keyed on generated content or a generated class. Re-anchor on a testid, a role, or a container |
| A `wait ... gone` anchor | These are transient by nature (a Stop button while generating). Resolve while it is on screen, and prefer `aria-label` — it changes less than the text |
| Resolution drifted after a redesign | Delete just that key from the sidecar and re-run. The `.demo` does not change; that is the point |
| Dialog blocks the extension | Do not click things that open `confirm`/`alert`. A modal dialog freezes the extension until dismissed by hand |
