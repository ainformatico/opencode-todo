/** @jsxImportSource @opentui/solid */
import { watch } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { For, Show, createMemo, createSignal } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
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

const EXPANDED_KEY = "todo.backlog_expanded"
const REV_KEY = "todo.backlog_rev"

function bumpRev(api: TuiPluginApi) {
  api.kv.set(REV_KEY, (api.kv.get(REV_KEY, 0) as number) + 1)
}

function currentSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name !== "session") return undefined
  const sessionID = route.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function BacklogPanel(props: { api: TuiPluginApi; items: () => store.QueueItem[]; sessionID: string; rev?: number }) {
  const theme = () => props.api.theme.current
  const [expanded, setExpanded] = createSignal(props.api.kv.get(EXPANDED_KEY, true))
  const mine = createMemo(() => props.items().filter((item) => item.sessionID === props.sessionID))
  const collapsible = () => mine().length > 2
  const toggle = () => {
    if (!collapsible()) return
    const next = !expanded()
    setExpanded(next)
    props.api.kv.set(EXPANDED_KEY, next)
    bumpRev(props.api)
  }
  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={toggle}>
        <Show when={collapsible()}>
          <text fg={theme().text}>{expanded() ? ARROW_EXPANDED : ARROW_COLLAPSED}</text>
        </Show>
        <text fg={theme().text}>
          <b>{PANEL_TITLE}</b>
          <Show when={collapsible() && !expanded()}>
            <span style={{ fg: theme().textMuted }}> ({mine().length})</span>
          </Show>
        </text>
      </box>
      <Show when={!collapsible() || expanded()}>
        <Show when={mine().length > 0} fallback={<text fg={theme().textMuted}>{NO_TASKS}</text>}>
          <For each={mine()}>
            {(item, index) => (
              <box flexDirection="row" gap={0}>
                <text flexShrink={0} fg={theme()[statusColor(item.status)]}>
                  {statusGlyph(item.status)}
                </text>
                <text flexShrink={0} fg={theme().textMuted}>
                  {index() + 1}.{" "}
                </text>
                <text flexGrow={1} wrapMode="word" fg={theme()[statusColor(item.status)]}>
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

function mutate(
  api: TuiPluginApi,
  work: Promise<unknown>,
  refresh: () => Promise<void>,
  ok?: { variant: "success"; message: string },
) {
  work
    .then(refresh)
    .then(() => {
      if (ok) api.ui.toast(ok)
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "write failed"
      api.ui.toast({ variant: "error", message: `Backlog: ${message}` })
    })
}

function noSession(api: TuiPluginApi) {
  const DialogAlert = api.ui.DialogAlert
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <DialogAlert title={PANEL_TITLE} message="Tasks are per-session — open a session first." onConfirm={() => api.ui.dialog.clear()} />
  ))
}

function emptyPicker(api: TuiPluginApi, title: string) {
  const DialogAlert = api.ui.DialogAlert
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => <DialogAlert title={title} message={`${BACKLOG_EMPTY}.`} onConfirm={() => api.ui.dialog.clear()} />)
}

function runTask(api: TuiPluginApi, worktree: string, item: store.QueueItem, refresh: () => Promise<void>) {
  const work = (async () => {
    const result = await api.client.tui.appendPrompt({ text: item.text })
    if (result.error || result.data === false) throw new Error("could not load the task into the prompt")
    await store.markCompleted(worktree, item.id)
  })()
  mutate(api, work, refresh)
}

function openAdd(api: TuiPluginApi, worktree: string, sessionID: string, refresh: () => Promise<void>) {
  const DialogPrompt = api.ui.DialogPrompt
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <DialogPrompt
      title="Add task to backlog"
      placeholder="Task description"
      onConfirm={(value: string) => {
        api.ui.dialog.clear()
        const text = value.trim()
        if (!text) return
        mutate(api, store.add(worktree, sessionID, text), refresh, { variant: "success", message: `Added "${toastText(text)}"` })
      }}
      onCancel={() => api.ui.dialog.clear()}
    />
  ))
}

function openPicker(
  api: TuiPluginApi,
  title: string,
  placeholder: string,
  mine: () => store.QueueItem[],
  onPick: (item: store.QueueItem) => void,
  order: (entries: Numbered[]) => Numbered[] = pendingFirst,
  keepOpen = false,
) {
  const list = mine()
  if (list.length === 0) {
    emptyPicker(api, title)
    return
  }
  const DialogSelect = api.ui.DialogSelect
  const options: TuiDialogSelectOption<store.QueueItem>[] = order(numbered(list)).map((entry) => ({
    title: pickerLabel(entry),
    value: entry.item,
  }))
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <DialogSelect
      title={title}
      placeholder={placeholder}
      options={options}
      onSelect={(option) => {
        if (!keepOpen) api.ui.dialog.clear()
        onPick(option.value)
      }}
    />
  ))
}

function openEdit(api: TuiPluginApi, worktree: string, mine: () => store.QueueItem[], refresh: () => Promise<void>) {
  openPicker(
    api,
    "Edit a backlog task",
    "Type to search, Enter to edit",
    mine,
    (item) => {
      const DialogPrompt = api.ui.DialogPrompt
      api.ui.dialog.replace(() => (
        <DialogPrompt
          title="Edit task"
          value={item.text}
          onConfirm={(value: string) => {
            api.ui.dialog.clear()
            const text = value.trim()
            if (!text) return
            mutate(api, store.editById(worktree, item.id, text), refresh, {
              variant: "success",
              message: `Updated: "${toastText(text)}"`,
            })
          }}
          onCancel={() => api.ui.dialog.clear()}
        />
      ))
    },
    pendingFirst,
    true,
  )
}

function openClear(api: TuiPluginApi, worktree: string, sessionID: string, mine: () => store.QueueItem[], refresh: () => Promise<void>) {
  const count = mine().length
  if (count === 0) {
    emptyPicker(api, "Clear backlog")
    return
  }
  const DialogConfirm = api.ui.DialogConfirm
  const noun = `task${count === 1 ? "" : "s"}`
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <DialogConfirm
      title="Clear backlog"
      message={`Delete ${count} ${noun} from this session?`}
      onConfirm={() => {
        api.ui.dialog.clear()
        mutate(api, store.clear(worktree, sessionID), refresh, { variant: "success", message: `Cleared ${count} ${noun}` })
      }}
      onCancel={() => api.ui.dialog.clear()}
    />
  ))
}

const tui: TuiPlugin = async (api) => {
  const worktree = api.state.path.worktree ?? api.state.path.directory
  const [items, setItems] = createSignal<store.QueueItem[]>([])

  let refreshSeq = 0
  async function refresh() {
    const seq = ++refreshSeq
    const next = await store.loadAll(worktree)
    if (seq === refreshSeq) {
      setItems(next)
      bumpRev(api)
    }
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

  api.slots.register({
    order: 350,
    slots: {
      sidebar_content(_ctx, props) {
        const rev = api.kv.get(REV_KEY, 0) as number
        return <BacklogPanel api={api} items={items} sessionID={props.session_id} rev={rev} />
      },
    },
  })

  function forSession(fn: (sessionID: string, mine: () => store.QueueItem[]) => void) {
    const sessionID = currentSessionID(api)
    if (!sessionID) return noSession(api)
    fn(sessionID, () => items().filter((item) => item.sessionID === sessionID))
  }

  const offLayer = api.keymap.registerLayer({
    commands: [
      {
        name: "todo.add",
        title: "Backlog: add task",
        category: "Backlog",
        namespace: "palette",
        slashName: "todo-add",
        run() {
          forSession((sessionID) => openAdd(api, worktree, sessionID, refresh))
        },
      },
      {
        name: "todo.run",
        title: "Backlog: run task",
        category: "Backlog",
        namespace: "palette",
        slashName: "todo-run",
        run() {
          forSession((_sessionID, mine) =>
            openPicker(api, "Run a backlog task", "Type to search, Enter loads it into the prompt", mine, (item) => {
              runTask(api, worktree, item, refresh)
            }),
          )
        },
      },
      {
        name: "todo.edit",
        title: "Backlog: edit task",
        category: "Backlog",
        namespace: "palette",
        slashName: "todo-edit",
        run() {
          forSession((_sessionID, mine) => openEdit(api, worktree, mine, refresh))
        },
      },
      {
        name: "todo.remove",
        title: "Backlog: remove task",
        category: "Backlog",
        namespace: "palette",
        slashName: "todo-remove",
        run() {
          forSession((_sessionID, mine) =>
            openPicker(
              api,
              "Remove a backlog task",
              "Type to search, Enter removes it",
              mine,
              (item) => {
                mutate(api, store.removeById(worktree, item.id), refresh, {
                  variant: "success",
                  message: `Removed "${toastText(item.text)}"`,
                })
              },
              (entries) => entries,
            ),
          )
        },
      },
      {
        name: "todo.list",
        title: "Backlog: list tasks",
        category: "Backlog",
        namespace: "palette",
        slashName: "todo-list",
        run() {
          forSession((_sessionID, mine) => {
            api.ui.toast({ variant: "info", message: listMessage(mine()), duration: 10000 })
          })
        },
      },
      {
        name: "todo.clear",
        title: "Backlog: clear tasks",
        category: "Backlog",
        namespace: "palette",
        slashName: "todo-clear",
        run() {
          forSession((sessionID, mine) => openClear(api, worktree, sessionID, mine, refresh))
        },
      },
    ],
  })

  api.lifecycle.onDispose(() => {
    watcher?.close()
    if (timer) clearTimeout(timer)
    offLayer()
  })
}

export default { id: "opencode-todo.tui", tui }
