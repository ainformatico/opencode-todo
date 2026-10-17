import type { QueueItem } from "./store.ts"
import {
  BACKLOG_EMPTY,
  CIRCLE,
  ELLIPSIS,
  LIST_SEPARATOR,
  STATUS_COMPLETED,
  STATUS_PENDING,
  TICK,
} from "./consts.ts"

export const SIDEBAR_MAX_CHARS = 100
export const TOAST_MAX_CHARS = 40
export const LIST_ENTRY_MAX_CHARS = 60
const LIST_MAX_ENTRIES = 10

function truncate(text: string, max: number) {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + ELLIPSIS
}

export function sidebarText(text: string) {
  return truncate(text, SIDEBAR_MAX_CHARS)
}

export function toastText(text: string, max = TOAST_MAX_CHARS) {
  return truncate(text, max)
}

export function statusGlyph(status: QueueItem["status"]) {
  return status === STATUS_COMPLETED ? `${TICK} ` : `${CIRCLE} `
}

export function statusMarker(status: QueueItem["status"]) {
  return status === STATUS_COMPLETED ? TICK : CIRCLE
}

export function statusColor(status: QueueItem["status"]): "success" | "muted" {
  return status === STATUS_COMPLETED ? "success" : "muted"
}

export type Numbered = { item: QueueItem; position: number }

export function numbered(items: QueueItem[]): Numbered[] {
  return items.map((item, index) => ({ item, position: index + 1 }))
}

export function pendingFirst(entries: Numbered[]): Numbered[] {
  return [...entries].sort((a, b) => {
    if (a.item.status === b.item.status) return 0
    return a.item.status === STATUS_PENDING ? -1 : 1
  })
}

export function pickerLabel(entry: Numbered) {
  return `${entry.position}. ${entry.item.status === STATUS_COMPLETED ? `${TICK} ` : ""}${entry.item.text}`
}

export function listMessage(items: QueueItem[]) {
  if (items.length === 0) return BACKLOG_EMPTY
  const entries = items
    .slice(0, LIST_MAX_ENTRIES)
    .map((item, index) => `${index + 1}. ${statusMarker(item.status)} ${toastText(item.text, LIST_ENTRY_MAX_CHARS)}`)
  const rest = items.length - LIST_MAX_ENTRIES
  return rest > 0 ? `${entries.join(LIST_SEPARATOR)}${LIST_SEPARATOR}${ELLIPSIS}and ${rest} more` : entries.join(LIST_SEPARATOR)
}
