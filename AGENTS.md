# AGENTS.md

Guidance for coding agents working on this repository.

## What this is

An npm-distributed OpenCode plugin (`opencode-todo`) targeting **OpenCode v2**,
providing a personal, manual task backlog (`/todo-add`, `/todo-run`,
`/todo-remove`, `/todo-edit`, `/todo-list`, `/todo-clear`) with a live
"My Backlog" sidebar panel. Commands are TUI keymap commands (`palette: true`
plus a `slash` name), so they appear in `/` autocomplete and the command
palette automatically — no `.opencode/command/*.md` stubs and no user setup.
Every command is dialog-driven (add = text entry; run/remove = searchable
pickers; edit = picker + edit dialog; clear = confirm dialog; list prints the
first 10 tasks only); typed arguments like `/todo-run 3` are not supported.
Tasks are session-scoped: every item belongs to the session it was added in;
other sessions never see it, numbering is per-session, and a deleted session's
items are purged via the `session.deleted` event.

The OpenCode 1.x implementation is frozen on the `v1` branch; `main` is the
v2 line.

## Hard rules

- **Never implement auto-execution.** No auto-draining, no auto-advance on
  idle, no background dispatch. Every task execution must be the direct result
  of an explicit user action.
- **`/todo-run` loads into the composer, never sends.** Submission always
  requires the user's own Enter press. V2 exposes no plugin API that writes
  into the composer, so the plugin inserts through the renderer's focused
  editor (`context.renderer.currentFocusedEditor`) — the same path the host's
  own `tui.prompt.append` listener uses. Keep that isolated in
  `insertIntoComposer` and revisit it when upstream ships a supported API.
  `/todo-run` marks the item completed (`✓`) at load time; items leave the list
  only via `/todo-remove` or `/todo-clear`.
- **Queue commands must never cost a model turn.** They are TUI keymap
  commands dispatched from `/` autocomplete or the command palette — no server
  command stubs exist, and nothing is ever sent to the model.
- **Toasts only for add, remove, edits, and clear.** `/todo-run` stays silent
  on success — the sidebar is the feedback; a failed insertion surfaces an
  error toast. `/todo-list`'s toast is the command's output, not a
  notification. Editing a completed item resets it to pending — an edit means
  the task is being reworked, so it must run again.
- **Two plugin surfaces with different entrypoints.** The server plugin
  (`Plugin.define` from `@opencode/plugin`) owns only the `session.deleted`
  purge, via `ctx.event.subscribe`. The TUI plugin (`Plugin.define` from
  `@opencode/plugin/tui`) owns the sidebar panel, the dialogs, and every
  command. The package root export (`.`) is the server entrypoint and `./tui`
  the TUI entrypoint; a local plugin directory uses `index.ts` (server) plus
  `tui.ts` (TUI).
- **Register keymap commands from a mounted component, not from `setup`.**
  Hosts before 2.0.32 call `keymap.layer` without an owner fallback, so a call
  from plugin setup throws `Keymap.Provider is missing`. The plugin registers
  its layer inside an `append: "app"` slot render (the documented
  component pattern), which works on every supported host. Do not "simplify"
  this back into `setup` unless the minimum host version rises past 2.0.32.
- **No comments.** Code stays comment-free; document tradeoffs and behavior
  in this file, the README, or tests instead.
- **`@opentui/*` + `solid-js` stay non-optional peerDependencies**, and
  `@opencode/plugin` is a runtime dependency (the server plugin imports it at
  load time). The packaged TUI entry (`dist/tui.js`) imports none of the peers
  directly — every runtime import is a host virtual id — but the dev entry
  (`src/tui.tsx`) still compiles against them, and 0.0.1 died with
  `Cannot find module '@opentui/solid/jsx-dev-runtime'` when they were
  optional. Keep them until the raw-`.tsx` path is gone everywhere.
- **`@opentui/*` peers are pinned to the `^0.6.6` line on purpose.** With
  `>=0.5.17`, a fresh npm install resolved `@opentui/solid` 0.8.1 while the
  host (2.1.3) renders with its bundled 0.6.x runtime. Keep them pinned until
  the compiled-entry contract below is verified against the newer line.
- **The TUI entry ships compiled, with host runtime ids.** `exports["./tui"]`
  points at `dist/tui.js`, built by `scripts/build-tui.mjs` on `prepack`. The
  build compiles `src/tui.tsx` with `babel-preset-solid` (`generate:
  "universal"`) and rewrites every runtime import to its virtual host id
  (`opentui:runtime-module:solid-js`, `opentui:runtime-module:%40opentui%2Fsolid`,
  `opentui:runtime-module:%40opencode%2Fplugin%2Ftui`) — the same output the
  host produces for local plugins. This is not optional. The host's Solid
  transform skips every path containing `node_modules` (filter verified in the
  2.1.3 binary), so a raw `.tsx` installed from npm is compiled by Bun's
  React-style JSX transform instead. That output calls
  `@opentui/solid/jsx-runtime`'s `jsx()`, which reads props once (`each=` and
  `when=` become static values), and the generated import resolves to the
  package's own `@opentui/solid` copy — a second runtime. Result: the panel
  paints "No tasks" once and never updates while commands, toasts, and
  `queue.json` all work. Upstream: anomalyco/opencode#39986 (open; fix pending
  via an `include` option in anomalyco/opentui#1741), #48883; the v1 branch hit
  the same bug (#32996, #33884) and papered over it with a kv revision bump.
  Pinning `@opentui/*` (0.1.1) did not fix it. Editing `src/tui.tsx` requires
  a rebuild/pack before the packaged entry changes; the build fails loudly if
  the output keeps any bare runtime specifier or a JSX-runtime import. Local
  dev (`.opencode/plugins/`, outside `node_modules`) still loads `src/tui.tsx`
  through the host transform, so dev and packaged paths differ — always verify
  a packaging change with `npm pack` plus an install under a `node_modules`
  path. Drop the build once the upstream transform compiles plugin-cache
  `.tsx` and `engines.opencode` requires that host.
- **Plugin ids are `opencode-todo.server` / `opencode-todo.tui`.** They are the
  user-visible runtime identity and the keys in plugin enable/disable config;
  renaming them post-publish silently breaks users' toggles.
- **Store writes are serialized in-process** (see `serialize` in `store.ts`)
  and every queue mutation flows through `mutate()` in `tui.tsx`, which
  refreshes the sidebar and surfaces write failures as an error toast.
  Fire-and-forget `void store.*()` calls are forbidden — they lose rejections
  and lie to the user with optimistic toasts.

## Commands

- Test: `npm test` (wraps `node --test "test/*.test.ts"`, Node's built-in test
  runner). Run this after any change to `src/store.ts` or `src/display.ts`.
- Lint: `npm run lint` (oxlint, correctness rules as errors via
  `.oxlintrc.json`).
- Typecheck: `npm run typecheck` (`tsc --noEmit`, strict, `tsconfig.json`).
  Tests and `src/*.ts` run directly via Node's type stripping; `src/tui.tsx`
  needs the Bun runtime, so it is verified by launching OpenCode in this repo.
- Build TUI entry: `npm run build:tui` (writes `dist/`; runs automatically on
  `prepack`).
- npm package: `npm pack` then `npm publish` (`prepublishOnly` runs
  typecheck + lint + test; `prepack` rebuilds `dist/`). The v2 line needs its own release version
  (0.0.3 and below are the v1 line).
- Live verification: `opencode plugin list` shows the loaded server plugin;
  launch `opencode` in this repo to exercise the sidebar, commands, and
  session-deletion purge.

## Layout

```
src/
  consts.ts   <- shared literals: status strings, glyphs, arrows, panel title
  store.ts    <- shared storage module (pure, unit-tested, no plugin API)
  display.ts  <- pure display/ordering helpers (truncation, glyphs, sort orders)
  server.ts   <- server plugin (package export "."): purges on session.deleted
  tui.tsx     <- TUI plugin source: sidebar, dialogs, commands
dist/         <- build output (gitignored): tui.js (package export "./tui")
scripts/
  build-tui.mjs <- compiles src/tui.tsx to dist/tui.js with host runtime ids
.opencode/plugins/opencode-todo/
  index.ts    <- dev entry, re-exports src/server.ts
  tui.ts      <- dev entry, re-exports src/tui.tsx
opencode.json         <- project config (schema only; discovery does the rest)
<worktree>/.opencode/queue.json  <- persisted backlog (runtime data, gitignored)
test/                 <- node:test suite (store, display, server plugin)
tsconfig.json         <- strict typecheck of src + test (no emit)
.oxlintrc.json        <- oxlint config (correctness rules as errors)
```

## Registration gotcha

V2 loads server plugins from the `plugins` array in `opencode.json(c)` or
automatically from `.opencode/plugins/` (direct `.ts`/`.js` files *and*
immediate subdirectories). A discovered plugin directory resolves its server
entry from `index.ts` (or `server.ts`) and its TUI entry from `tui.ts`; the
CLI loads the TUI entry automatically for active server plugins that expose
one — no separate `cli.json` entry is needed. `cli.json` is only for
CLI-only packages. The V1 `plugin` key and `tui.json` are dead; do not bring
them back.

## Distribution

Users install with `opencode plugin add opencode-todo` (or the in-TUI plugin
manager), which fetches from npm and patches the global config. Invariants
that must not break:

- The npm package name `opencode-todo` is the public install identity;
  renaming it post-publish orphans every installed user.
- `exports["."]` is the server entrypoint and `exports["./tui"]` the TUI
  entrypoint; both must keep existing and resolving to separate,
  surface-exclusive modules (`src/server.ts` and the compiled `dist/tui.js`).
- `engines.opencode` is semver-checked on load for npm plugins; keep it at the
  oldest host version the code actually works on (currently `>=2.0.20`).
- The published tarball must keep shipping `LICENSE`, `README.md`, `src`, and
  `dist` (`files` field plus npm auto-includes). `dist/` is gitignored and
  produced by `prepack`, so never publish with `--ignore-scripts`.
- The server entry ships as raw `.ts` (loaded via Bun/type-stripping). The
  TUI entry must ship compiled (see the hard rule above); `dist/` carries
  copies of `store.ts`, `display.ts`, and `consts.ts` so `dist/tui.js` keeps
  its relative imports.

## Conventions and caveats

- **The sidebar panel collapses like the built-in sections.** Click the
  "My Backlog" header to toggle when the session has more than 2 items
  (arrow + count shown while collapsed); the state persists via
  `context.storage.store` (key `backlog`).
- **Sidebar updates are reactive Solid state.** `items` is a signal read by
  the slot render and the expanded flag is a host-backed reactive store, so
  the panel repaints without extra bumps. (The v1 branch needed a kv-based
  re-render workaround for a host bug; v2 does not.)
- **Shared state is the file.** Both plugin surfaces read/write
  `.opencode/queue.json` through `src/store.ts`. Keep all writes atomic
  (see `writeAtomic`). Corrupt or unreadable queue files are quarantined as
  `queue.json.corrupt-<ts>-<rand>` rather than overwritten. The TUI sidebar
  stays fresh via a filesystem watcher filtered to `queue.json*` — preserve
  that mechanism when touching either plugin.
- **Picker numbering mirrors the sidebar.** Pickers reorder entries
  (pending-first for run/edit, sidebar order for remove) but every label
  shows the item's sidebar position via `numbered()`/`pickerLabel()` in
  `display.ts` — never the reordered index.
- **Cross-process plugin APIs evolve faster than docs.** Before relying on a
  new API shape, verify it against the installed `@opencode/plugin` types and
  a running host in this repo (keymap/owner semantics changed between
  OpenCode 2.0.20 and 2.0.32, for example).
- User-facing item handles are **1-based list positions**, never internal ids.
- Keep the store pure (no plugin imports) so it stays unit-testable.
