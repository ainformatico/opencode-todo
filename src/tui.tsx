/** @jsxImportSource @opentui/solid */
import { watch } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { For, Show, createMemo, createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import type { Context, KeymapLayer } from "@opencode/plugin/tui/context"
import * as store from "./store.ts"
import {
  ARROW_COLLAPSED,
  ARROW_EXPANDED,
  BACKLOG_EMPTY,
  NO_TASKS,
  PANEL_TITLE,
  QUEUE_FILE_NAME,
} from "./consts.ts"
import {
  type Numbered,
  listMessage,
  numbered,
  pendingFirst,
  pickerLabel,
  sidebarText,
  statusColor,
  statusGlyph,
  toastText,
} from "./display.ts"

const STORAGE_KEY = "backlog"
const NO_SESSION = "Tasks are per-session — open a session first."

type BacklogSettings = { expanded: boolean }
type SettingsUpdate = (mutation: (draft: BacklogSettings) => void) => Promise<void>

function currentSessionID(context: Context): string | undefined {
  const route = context.ui.router.current()
  return route.type === "session" ? route.sessionID : undefined
}

function statusFg(theme: Context["theme"], status: store.QueueItem["status"]) {
  return statusColor(status) === "success" ? theme.text.feedback.success.base : theme.text.muted
}

function BacklogPanel(props: {
  context: Context
  items: () => store.QueueItem[]
  sessionID: string
  settings: BacklogSettings
  updateSettings: SettingsUpdate
}) {
  const theme = () => props.context.theme
  const mine = createMemo(() => props.items().filter((item) => item.sessionID === props.sessionID))
  const collapsible = () => mine().length > 2
  const toggle = () => {
    if (!collapsible()) return
    props
      .updateSettings((draft) => {
        draft.expanded = !draft.expanded
      })
      .catch(() => props.context.ui.toast.show({ variant: "error", message: "Backlog: could not save the sidebar state" }))
  }
  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={toggle}>
        <Show when={collapsible()}>
          <text fg={theme().text.base}>{props.settings.expanded ? ARROW_EXPANDED : ARROW_COLLAPSED}</text>
        </Show>
        <text fg={theme().text.base}>
          <b>{PANEL_TITLE}</b>
          <Show when={collapsible() && !props.settings.expanded}>
            <span style={{ fg: theme().text.muted }}> ({mine().length})</span>
          </Show>
        </text>
      </box>
      <Show when={!collapsible() || props.settings.expanded}>
        <Show when={mine().length > 0} fallback={<text fg={theme().text.muted}>{NO_TASKS}</text>}>
          <For each={mine()}>
            {(item, index) => (
              <box flexDirection="row" gap={0}>
                <text flexShrink={0} fg={statusFg(theme(), item.status)}>
                  {statusGlyph(item.status)}
                </text>
                <text flexShrink={0} fg={theme().text.muted}>
                  {index() + 1}.{" "}
                </text>
                <text flexGrow={1} wrapMode="word" fg={statusFg(theme(), item.status)}>
                  {sidebarText(item.text)}
                </text>
              </box>
            )}
          </For>
        </Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-todo.tui",
  async setup(context) {
    const worktree = (context.location ?? context.data.location.default()).directory
    const [items, setItems] = createSignal<store.QueueItem[]>([])
    const [settings, updateSettings] = context.storage.store<BacklogSettings>(STORAGE_KEY, {
      initial: { expanded: true },
    })

    const backlogCommands = (): KeymapLayer => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "todo.add",
          title: "Backlog: add task",
          group: "Backlog",
          palette: true,
          slash: { name: "todo-add" },
          run: () => guard(() => forSession((sessionID) => openAdd(sessionID))),
        },
        {
          id: "todo.run",
          title: "Backlog: run task",
          group: "Backlog",
          palette: true,
          slash: { name: "todo-run" },
          run: () =>
            guard(() =>
              forSession(async (_sessionID, mine) => {
                const item = await pick("Run a backlog task", "Type to search, Enter loads it into the prompt", mine)
                if (item) await runTask(item)
              }),
            ),
        },
        {
          id: "todo.edit",
          title: "Backlog: edit task",
          group: "Backlog",
          palette: true,
          slash: { name: "todo-edit" },
          run: () => guard(() => forSession((_sessionID, mine) => openEdit(mine))),
        },
        {
          id: "todo.remove",
          title: "Backlog: remove task",
          group: "Backlog",
          palette: true,
          slash: { name: "todo-remove" },
          run: () => guard(() => forSession((_sessionID, mine) => openRemove(mine))),
        },
        {
          id: "todo.list",
          title: "Backlog: list tasks",
          group: "Backlog",
          palette: true,
          slash: { name: "todo-list" },
          run: () =>
            guard(() =>
              forSession((_sessionID, mine) => {
                context.ui.toast.show({ variant: "info", message: listMessage(mine()), duration: 10000 })
              }),
            ),
        },
        {
          id: "todo.clear",
          title: "Backlog: clear tasks",
          group: "Backlog",
          palette: true,
          slash: { name: "todo-clear" },
          run: () => guard(() => forSession((sessionID, mine) => openClear(sessionID, mine))),
        },
      ],
    })

    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(backlogCommands)
        return null
      },
    })

    let refreshSeq = 0
    async function refresh() {
      const seq = ++refreshSeq
      const next = await store.loadAll(worktree)
      if (seq === refreshSeq) setItems(next)
    }
    await refresh()

    let timer: ReturnType<typeof setTimeout> | undefined
    const queueDir = path.join(worktree, ".opencode")
    await mkdir(queueDir, { recursive: true }).catch(() => {})
    let watcher: ReturnType<typeof watch> | undefined
    try {
      watcher = watch(queueDir, (_event, filename) => {
        if (filename === null || (filename !== QUEUE_FILE_NAME && !filename.startsWith(`${QUEUE_FILE_NAME}.`))) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => void refresh(), 25)
      })
      watcher.on("error", () => {})
    } catch {}

    context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => (
        <BacklogPanel
          context={context}
          items={items}
          sessionID={sessionID}
          settings={settings}
          updateSettings={updateSettings}
        />
      ),
    })

    const sessionItems = (sessionID: string) => () => items().filter((item) => item.sessionID === sessionID)

    function toastError(error: unknown) {
      const message = error instanceof Error ? error.message : "write failed"
      context.ui.toast.show({ variant: "error", message: `Backlog: ${message}` })
    }

    function guard(action: () => Promise<unknown>) {
      void action().catch(toastError)
    }

    async function mutate(work: () => Promise<unknown>, ok?: { variant: "success"; message: string }) {
      try {
        await work()
        await refresh()
        if (ok) context.ui.toast.show(ok)
      } catch (error) {
        toastError(error)
      }
    }

    async function forSession(work: (sessionID: string, mine: () => store.QueueItem[]) => Promise<void> | void) {
      const sessionID = currentSessionID(context)
      if (!sessionID) {
        await context.ui.dialog.alert({ title: PANEL_TITLE, message: NO_SESSION })
        return
      }
      await work(sessionID, sessionItems(sessionID))
    }

    async function pick(
      title: string,
      placeholder: string,
      mine: () => store.QueueItem[],
      order: (entries: Numbered[]) => Numbered[] = pendingFirst,
    ) {
      const list = mine()
      if (list.length === 0) {
        await context.ui.dialog.alert({ title, message: `${BACKLOG_EMPTY}.` })
        return undefined
      }
      const options = order(numbered(list)).map((entry) => ({ title: pickerLabel(entry), value: entry.item }))
      return context.ui.dialog.select<store.QueueItem>({ title, placeholder, options })
    }

    async function openAdd(sessionID: string) {
      const value = await context.ui.dialog.prompt({ title: "Add task to backlog", placeholder: "Task description" })
      if (value === undefined) return
      const text = value.trim()
      if (!text) return
      await mutate(() => store.add(worktree, sessionID, text), {
        variant: "success",
        message: `Added "${toastText(text)}"`,
      })
    }

    async function insertIntoComposer(text: string) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const editor = context.renderer.currentFocusedEditor
        if (editor) {
          editor.insertText(text)
          editor.gotoBufferEnd()
          context.renderer.requestRender()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error("could not load the task into the prompt")
    }

    async function runTask(item: store.QueueItem) {
      try {
        await insertIntoComposer(item.text)
        await store.markCompleted(worktree, item.id)
        await refresh()
      } catch (error) {
        toastError(error)
      }
    }

    async function openEdit(mine: () => store.QueueItem[]) {
      const item = await pick("Edit a backlog task", "Type to search, Enter to edit", mine)
      if (!item) return
      const value = await context.ui.dialog.prompt({ title: "Edit task", value: item.text })
      if (value === undefined) return
      const text = value.trim()
      if (!text) return
      await mutate(() => store.editById(worktree, item.id, text), {
        variant: "success",
        message: `Updated: "${toastText(text)}"`,
      })
    }

    async function openRemove(mine: () => store.QueueItem[]) {
      const item = await pick("Remove a backlog task", "Type to search, Enter removes it", mine, (entries) => entries)
      if (!item) return
      await mutate(() => store.removeById(worktree, item.id), {
        variant: "success",
        message: `Removed "${toastText(item.text)}"`,
      })
    }

    async function openClear(sessionID: string, mine: () => store.QueueItem[]) {
      const list = mine()
      if (list.length === 0) {
        await context.ui.dialog.alert({ title: "Clear backlog", message: `${BACKLOG_EMPTY}.` })
        return
      }
      const noun = `task${list.length === 1 ? "" : "s"}`
      const confirmed = await context.ui.dialog.confirm({
        title: "Clear backlog",
        message: `Delete ${list.length} ${noun} from this session?`,
      })
      if (!confirmed) return
      await mutate(() => store.clear(worktree, sessionID), {
        variant: "success",
        message: `Cleared ${list.length} ${noun}`,
      })
    }

    return () => {
      watcher?.close()
      if (timer) clearTimeout(timer)
    }
  },
})
