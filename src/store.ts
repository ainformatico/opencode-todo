import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { QUEUE_FILE_NAME, STATUS_COMPLETED, STATUS_PENDING } from "./consts.ts"

export type ItemStatus = typeof STATUS_PENDING | typeof STATUS_COMPLETED

export type QueueItem = {
  id: string
  sessionID: string
  text: string
  createdAt: string
  status: ItemStatus
}

export function queueFile(worktree: string) {
  return path.join(worktree, ".opencode", QUEUE_FILE_NAME)
}

let chain: Promise<unknown> = Promise.resolve()

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => {})
  return next
}

type RawItem = Omit<QueueItem, "sessionID" | "status"> & { sessionID?: unknown; status?: unknown }

function isItem(value: unknown): value is RawItem {
  if (typeof value !== "object" || value === null) return false
  const item = value as Record<string, unknown>
  return typeof item.id === "string" && typeof item.text === "string" && typeof item.createdAt === "string"
}

function normalize(item: RawItem): QueueItem {
  return {
    ...item,
    sessionID: typeof item.sessionID === "string" ? item.sessionID : "",
    status: item.status === STATUS_COMPLETED ? STATUS_COMPLETED : STATUS_PENDING,
  }
}

function validItems(parsed: unknown): QueueItem[] {
  if (!Array.isArray(parsed)) throw new Error("queue file is not a JSON array")
  return parsed.filter(isItem).map(normalize)
}

async function quarantine(worktree: string) {
  try {
    await rename(queueFile(worktree), `${queueFile(worktree)}.corrupt-${Date.now()}-${randomBytes(2).toString("hex")}`)
  } catch {}
}

export async function loadAll(worktree: string): Promise<QueueItem[]> {
  let raw: string
  try {
    raw = await readFile(queueFile(worktree), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") await quarantine(worktree)
    return []
  }
  try {
    return validItems(JSON.parse(raw))
  } catch {
    await quarantine(worktree)
    return []
  }
}

export async function load(worktree: string, sessionID: string): Promise<QueueItem[]> {
  return (await loadAll(worktree)).filter((item) => item.sessionID === sessionID)
}

export async function save(worktree: string, items: QueueItem[]) {
  await writeAtomic(queueFile(worktree), JSON.stringify(items, null, 2) + "\n")
}

async function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(tmp, data, "utf8")
  try {
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

export async function add(worktree: string, sessionID: string, text: string): Promise<QueueItem> {
  return serialize(async () => {
    const items = await loadAll(worktree)
    let id = randomBytes(3).toString("hex")
    while (items.some((item) => item.id === id)) id = randomBytes(3).toString("hex")
    const item: QueueItem = { id, sessionID, text, createdAt: new Date().toISOString(), status: STATUS_PENDING }
    items.push(item)
    await save(worktree, items)
    return item
  })
}

export async function editById(worktree: string, id: string, text: string): Promise<QueueItem | undefined> {
  return serialize(async () => {
    const items = await loadAll(worktree)
    const item = items.find((item) => item.id === id)
    if (!item) return undefined
    item.text = text
    item.status = STATUS_PENDING
    await save(worktree, items)
    return item
  })
}

export async function removeById(worktree: string, id: string): Promise<QueueItem | undefined> {
  return serialize(async () => {
    const items = await loadAll(worktree)
    const index = items.findIndex((item) => item.id === id)
    if (index === -1) return undefined
    const [item] = items.splice(index, 1)
    await save(worktree, items)
    return item
  })
}

export async function markCompleted(worktree: string, id: string): Promise<QueueItem | undefined> {
  return serialize(async () => {
    const items = await loadAll(worktree)
    const item = items.find((item) => item.id === id)
    if (!item) return undefined
    item.status = STATUS_COMPLETED
    await save(worktree, items)
    return item
  })
}

export async function clear(worktree: string, sessionID: string) {
  return serialize(async () => {
    const items = await loadAll(worktree)
    await save(worktree, items.filter((item) => item.sessionID !== sessionID))
  })
}
