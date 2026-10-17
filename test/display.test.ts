import { describe, test } from "node:test"
import assert from "node:assert/strict"
import {
  LIST_ENTRY_MAX_CHARS,
  SIDEBAR_MAX_CHARS,
  listMessage,
  numbered,
  pendingFirst,
  pickerLabel,
  sidebarText,
  statusColor,
  statusGlyph,
  statusMarker,
  toastText,
} from "../src/display.ts"
import type { ItemStatus, QueueItem } from "../src/store.ts"

function item(id: string, text = `task ${id}`, status: ItemStatus = "pending"): QueueItem {
  return { id, sessionID: "ses_x", text, createdAt: "2026-08-16T00:00:00Z", status }
}

describe("truncation", () => {
  test("sidebarText keeps text at or under the budget", () => {
    const exact = "a".repeat(SIDEBAR_MAX_CHARS)
    assert.equal(sidebarText("short"), "short")
    assert.equal(sidebarText(exact), exact)
  })

  test("sidebarText truncates to the budget with an ellipsis", () => {
    const out = sidebarText("a".repeat(SIDEBAR_MAX_CHARS + 1))
    assert.equal(out.length, SIDEBAR_MAX_CHARS)
    assert.ok(out.endsWith("…"))
  })

  test("toastText defaults to its budget and honors a custom one", () => {
    assert.equal(toastText("b".repeat(40)), "b".repeat(40))
    assert.equal(toastText("c".repeat(41)).length, 40)
    assert.equal(toastText("abcdef", 5), "abcd…")
    assert.equal(toastText("abcde", 5), "abcde")
  })

  test("truncation never splits a surrogate pair", () => {
    const out = toastText("😀".repeat(60))
    assert.ok(out.endsWith("…"))
    const chars = Array.from(out)
    assert.ok(chars.every((ch) => ch === "…" || ch.codePointAt(0)! > 0xffff))
  })
})

describe("status glyphs and colors", () => {
  test("glyph and marker distinguish completed from pending", () => {
    assert.equal(statusGlyph("completed"), "✓ ")
    assert.equal(statusGlyph("pending"), "○ ")
    assert.equal(statusMarker("completed"), "✓")
    assert.equal(statusMarker("pending"), "○")
  })

  test("statusColor maps to theme keys", () => {
    assert.equal(statusColor("completed"), "success")
    assert.equal(statusColor("pending"), "muted")
  })
})

describe("numbered orderings", () => {
  test("numbered carries the sidebar position", () => {
    const entries = numbered([item("a"), item("b"), item("c")])
    assert.deepEqual(
      entries.map((e) => `${e.position}:${e.item.id}`),
      ["1:a", "2:b", "3:c"],
    )
  })

  test("pendingFirst is stable and keeps original positions", () => {
    const entries = numbered([item("a", "task a", "completed"), item("b"), item("c", "task c", "completed"), item("d")])
    assert.deepEqual(
      pendingFirst(entries).map((e) => `${e.position}:${e.item.status}`),
      ["2:pending", "4:pending", "1:completed", "3:completed"],
    )
  })
})

describe("pickerLabel", () => {
  test("prefixes the sidebar position and marks completed items", () => {
    assert.equal(pickerLabel({ item: item("a", "write docs"), position: 3 }), "3. write docs")
    assert.equal(pickerLabel({ item: item("a", "write docs", "completed"), position: 1 }), "1. ✓ write docs")
  })
})

describe("listMessage", () => {
  test("empty backlog", () => {
    assert.equal(listMessage([]), "Backlog is empty")
  })

  test("lists numbered entries joined with a separator", () => {
    const message = listMessage([item("a", "alpha"), item("b", "beta", "completed")])
    assert.equal(message, "1. ○ alpha · 2. ✓ beta")
  })

  test("caps at ten entries and reports the rest", () => {
    const items = Array.from({ length: 12 }, (_, i) => item(`id${i}`, `t${i}`))
    const message = listMessage(items)
    assert.ok(message.includes("…and 2 more"))
    assert.ok(!message.includes("t10"))
    assert.ok(message.includes("t9"))
  })

  test("truncates long entry text to the entry budget", () => {
    const long = "x".repeat(LIST_ENTRY_MAX_CHARS + 10)
    const message = listMessage([item("a", long)])
    assert.ok(message.length < long.length)
    assert.ok(message.includes("…"))
  })
})
