# AGENTS.md

Guidance for coding agents working on this repository.

## What this is

An npm-distributed OpenCode plugin (`opencode-todo`) providing a personal,
manual task backlog (`/todo-add`, `/todo-run`, `/todo-remove`, `/todo-edit`,
`/todo-list`, `/todo-clear`) with a live "My Backlog" sidebar panel. Commands
are TUI-registered keymap commands (`slashName` + `namespace: "palette"`), so
they appear in `/` autocomplete automatically — no `.opencode/command/*.md`
stubs and no user setup. Every command is dialog-driven (add = text entry;
run/remove = searchable pickers; edit = picker + edit dialog; clear = confirm
dialog; list prints the first 10 tasks only); typed arguments like
`/todo-run 3` are not supported.
Tasks are session-scoped: every item belongs to the session it
was added in; other sessions never see it, numbering is per-session, and a
deleted session's items are purged via the `session.deleted` event.

## Hard rules

- **Never implement auto-execution.** No auto-draining, no auto-advance on
  idle, no background dispatch. Every task execution must be the direct result
  of an explicit user action. Auto-execution was considered and rejected.
- **`/todo-run` loads into the composer, never sends.** Submission always requires
  the user's own Enter press. `/todo-run` marks the item completed (`✓`) at load
  time; items leave the list only via `/todo-remove` or `/todo-clear`.
- **Queue commands must never cost a model turn.** They are TUI keymap
  commands dispatched from `/` autocomplete or the command palette — no
  server command stubs exist, and nothing is ever sent to the model.
- **Toasts only for add, remove, edits, and clear.** `/todo-run`
  stays silent on success — the sidebar is the feedback; a failed append
  (e.g. the composer rejects the text) surfaces an error toast via `mutate`.
  `/todo-list`'s toast is the command's output, not a notification.
  Editing a completed item resets it to pending — an edit means the task is
  being reworked, so it must run again.
- **Two SDK clients with different shapes.** The server plugin gets the v1
  client (`{ body: { text } }` payloads); the TUI plugin's `api.client` is the
  v2 client (flat params: `{ text }`). Mixing these up fails silently — that
  was the original "picker selection never reached the composer" bug.
- **No comments.** Code stays comment-free; document tradeoffs and behavior
  in this file, the README, or tests instead.
- **`@opentui/*` + `solid-js` must stay non-optional peerDependencies**, and
  `@opencode-ai/plugin` stays a devDependency (types-only). TUI plugins'
  `.tsx` compiles to `@opentui/solid/jsx-dev-runtime` and imports `solid-js`
  at load time; both must resolve from the plugin's install directory
  (opencode's plugin cache or the dev repo's `node_modules`). With optional
  peers nothing gets installed and the plugin dies with
  `Cannot find module '@opentui/solid/jsx-dev-runtime'` (verified against
  1.18.15; this is why 0.0.1 never loaded). Duplicate-runtime risk is
  handled by the host: `@opentui/solid/runtime-plugin-support` rewrites
  those specifiers to the host's own copies when they resolve on disk.
- **Plugin ids are `opencode-todo.server` / `opencode-todo.tui`.** They are the
  user-visible runtime identity and the keys in `plugin_enabled` config;
  renaming them post-publish silently breaks users' enable/disable toggles.
- **Store writes are serialized in-process** (see `serialize` in `store.ts`)
  and every mutation flows through `mutate()` in `tui.tsx`, which refreshes
  the sidebar and surfaces write failures as an error toast. Fire-and-forget
  `void store.*()` calls are forbidden — they lose rejections and lie to the
  user with optimistic toasts.
- **Commit after every change.** Each completed task gets its own commit
  (conventional-commit style, like the existing history). Never commit
  runtime data (`queue.json`).

## Commands

- Test: `npm test` (wraps `node --test "test/*.test.ts"`, Node's built-in test
  runner). Run this after any change to `src/store.ts` or `src/display.ts`.
- Lint: `npm run lint` (oxlint, correctness rules as errors via
  `.oxlintrc.json`).
- Typecheck: `npm run typecheck` (`tsc --noEmit`, strict, `tsconfig.json`).
  Tests and `src/*.ts` run directly via Node's type stripping; `src/tui.tsx`
  needs the bun runtime, so it is verified by launching OpenCode in this repo.
- npm package: `npm pack` then `npm publish` (`prepublishOnly` runs
  typecheck + lint + test). The local `opencode.json` and
  `.opencode/tui.json` register the in-repo `src/` files for development.

## Layout

```
src/
  consts.ts   <- shared literals: status strings, glyphs, arrows, panel title
  store.ts    <- shared storage module (pure, unit-tested, no plugin API)
  display.ts  <- pure display/ordering helpers (truncation, glyphs, sort orders)
  server.ts   <- server plugin (exports["./server"]): purges on session.deleted
  tui.tsx     <- TUI plugin (exports["./tui"]): sidebar, dialogs, slash commands
opencode.json         <- dev registration of the server plugin
.opencode/tui.json    <- dev registration of the TUI plugin
<worktree>/.opencode/queue.json  <- persisted backlog (runtime data, gitignored)
test/                 <- node:test suite (store, display, server plugin)
tsconfig.json         <- strict typecheck of src + test (no emit)
.oxlintrc.json        <- oxlint config (correctness rules as errors)
```

## Registration gotcha

In OpenCode 1.18+, TUI plugins load only from `tui.json` config files
(`.opencode/tui.json` project-local, `~/.config/opencode/tui.json` global);
the `plugin` array in `opencode.json` loads server plugins only. Registering
`src/tui.tsx` in `opencode.json` silently does nothing — the sidebar panel,
dialogs, and palette commands won't load.

## Distribution

Users install with one command: `opencode plugin -g opencode-todo` (or the
in-TUI plugin manager), which fetches from npm, detects targets from the
package manifest, and patches both config files. Invariants that must not
break:

- The npm package name `opencode-todo` is the public install identity;
  renaming it post-publish orphans every installed user.
- `exports["./server"]` and `exports["./tui"]` are the install-target routing
  table: opencode detects which surfaces to wire purely from their presence.
  Both must keep existing, each resolving to a separate, target-exclusive
  module (`export default { id, server }` / `{ id, tui }`; a module exporting
  both is rejected by the v1 loader).
- `engines.opencode` is semver-checked on load for npm plugins; keep it at the
  oldest TUI-plugin API the code actually uses.
- The published tarball must keep shipping `LICENSE`, `README.md`, and `src`
  (`files` field plus npm auto-includes).
- Raw `.ts`/`.tsx` in the tarball is correct: the plugin runtimes load them
  via Bun/type-stripping. There is no build step; do not add one without a
  story for hosts that cannot strip types.

## Conventions and caveats

- **Two plugin surfaces.** The server plugin owns only the `session.deleted`
  purge; the TUI plugin owns the sidebar panel, the dialogs, and every
  command. Commands take no typed arguments by design — TUI slash commands
  cannot capture inline arguments, so everything is dialog-driven.
- **The sidebar panel collapses like the built-in sections.** Click the
  "My Backlog" header to toggle when the session has more than 2 items
  (arrow + count shown while collapsed); the state persists via `api.kv`
  (`todo.backlog_expanded`).
- **Shared state is the file.** Both processes read/write
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
  new API shape, verify it against the installed `@opencode-ai/plugin` types
  in this repo's `node_modules` rather than assuming.
- User-facing item handles are **1-based list positions**, never internal ids.
- Keep the store pure (no plugin imports) so it stays unit-testable.
