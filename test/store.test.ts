import { afterEach, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import * as store from "../src/store.ts"

const A = "ses_aaa"
const B = "ses_bbb"

const dirs: string[] = []
let worktree: string

beforeEach(async () => {
  worktree = await mkdtemp(path.join(tmpdir(), "queue-test-"))
  dirs.push(worktree)
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function rawWrite(content: string) {
  await store.save(worktree, [])
  const { writeFile } = await import("node:fs/promises")
  await writeFile(store.queueFile(worktree), content, "utf8")
}

async function rawRead() {
  return readFile(store.queueFile(worktree), "utf8")
}

describe("queue store", () => {
  test("load on missing file returns empty", async () => {
    assert.deepEqual(await store.load(worktree, A), [])
    assert.deepEqual(await store.loadAll(worktree), [])
  })

  test("add appends and persists; order defines numbering", async () => {
    await store.add(worktree, A, "first")
    await store.add(worktree, A, "second")
    const items = await store.load(worktree, A)
    assert.deepEqual(
      items.map((i) => i.text),
      ["first", "second"],
    )
    assert.equal(new Set(items.map((i) => i.id)).size, 2)
    for (const item of items) {
      assert.equal(item.status, "pending")
      assert.equal(item.sessionID, A)
      assert.ok(item.createdAt)
    }
  })

  test("add creates the .opencode directory on demand", async () => {
    await store.add(worktree, A, "first")
    const raw = await rawRead()
    assert.ok(raw.includes("first"))
  })

  test("concurrent adds all survive", async () => {
    await Promise.all([store.add(worktree, A, "a1"), store.add(worktree, B, "b1"), store.add(worktree, A, "a2")])
    const all = await store.loadAll(worktree)
    assert.equal(all.length, 3)
    assert.deepEqual(
      (await store.load(worktree, A)).map((i) => i.text),
      ["a1", "a2"],
    )
    assert.deepEqual(
      (await store.load(worktree, B)).map((i) => i.text),
      ["b1"],
    )
  })

  test("session isolation: other sessions see nothing, numbering is per-session", async () => {
    await store.add(worktree, A, "a1")
    await store.add(worktree, A, "a2")
    await store.add(worktree, B, "b1")
    assert.deepEqual(
      (await store.load(worktree, A)).map((i) => i.text),
      ["a1", "a2"],
    )
    assert.deepEqual(
      (await store.load(worktree, B)).map((i) => i.text),
      ["b1"],
    )
  })

  test("editById replaces text, keeps position/id, resets completed to pending", async () => {
    const a = await store.add(worktree, A, "original")
    await store.add(worktree, A, "second")
    await store.markCompleted(worktree, a.id)
    const edited = await store.editById(worktree, a.id, "rewritten")
    assert.equal(edited?.id, a.id)
    assert.equal(edited?.status, "pending")
    assert.deepEqual(
      (await store.load(worktree, A)).map((i) => i.text),
      ["rewritten", "second"],
    )
    assert.equal(await store.editById(worktree, "nope", "x"), undefined)
  })

  test("removeById removes by identity", async () => {
    const a = await store.add(worktree, A, "first")
    await store.add(worktree, A, "second")
    const removed = await store.removeById(worktree, a.id)
    assert.equal(removed?.id, a.id)
    assert.deepEqual(
      (await store.load(worktree, A)).map((i) => i.text),
      ["second"],
    )
    assert.equal(await store.removeById(worktree, "nope"), undefined)
  })

  test("markCompleted with unknown id changes nothing", async () => {
    const a = await store.add(worktree, A, "first")
    assert.equal(await store.markCompleted(worktree, "nope"), undefined)
    assert.equal((await store.load(worktree, A))[0]!.status, "pending")
    const done = await store.markCompleted(worktree, a.id)
    assert.equal(done?.status, "completed")
  })

  test("clear only empties the calling session's items", async () => {
    await store.add(worktree, A, "a1")
    await store.add(worktree, B, "b1")
    await store.clear(worktree, A)
    assert.deepEqual(await store.load(worktree, A), [])
    assert.deepEqual(
      (await store.load(worktree, B)).map((i) => i.text),
      ["b1"],
    )
  })

  test("clear with unknown session is a no-op", async () => {
    await store.add(worktree, A, "a1")
    await store.clear(worktree, "ses_missing")
    assert.equal((await store.load(worktree, A)).length, 1)
  })

  test("legacy items without sessionID are invisible but preserved", async () => {
    await rawWrite(
      JSON.stringify([
        { id: "old1", text: "legacy", createdAt: "2026-08-16T00:00:00Z" },
        { id: "new1", sessionID: A, text: "current", createdAt: "2026-08-16T00:00:01Z", status: "pending" },
      ]),
    )
    assert.deepEqual(
      (await store.load(worktree, A)).map((i) => i.text),
      ["current"],
    )
    const all = await store.loadAll(worktree)
    assert.equal(all.length, 2)
    assert.equal(all.find((i) => i.id === "old1")?.sessionID, "")
  })

  test("unknown status values are coerced to pending, not dropped", async () => {
    await rawWrite(
      JSON.stringify([{ id: "u1", sessionID: A, text: "odd", createdAt: "2026-08-16T00:00:00Z", status: "archived" }]),
    )
    const all = await store.loadAll(worktree)
    assert.equal(all.length, 1)
    assert.equal(all[0]!.status, "pending")
  })

  test("corrupt queue file is quarantined, not silently overwritten", async () => {
    await rawWrite("{not json")
    await store.add(worktree, A, "fresh")
    const dirEntries = await readdir(path.join(worktree, ".opencode"))
    const quarantined = dirEntries.find((name) => name.startsWith("queue.json.corrupt-"))
    assert.ok(quarantined, `expected a quarantined file, got ${dirEntries.join(", ")}`)
    const quarantinedContent = await readFile(path.join(worktree, ".opencode", quarantined!), "utf8")
    assert.equal(quarantinedContent, "{not json")
    const items = await store.load(worktree, A)
    assert.deepEqual(
      items.map((i) => i.text),
      ["fresh"],
    )
  })

  test("valid json of the wrong shape is quarantined, not silently overwritten", async () => {
    await rawWrite('{"unexpected": true}')
    assert.deepEqual(await store.loadAll(worktree), [])
    const dirEntries = await readdir(path.join(worktree, ".opencode"))
    assert.ok(dirEntries.some((name) => name.startsWith("queue.json.corrupt-")))
  })

  test("saved file is newline-terminated json of the whole queue", async () => {
    await store.add(worktree, A, "first")
    const raw = await rawRead()
    assert.ok(raw.endsWith("\n"))
    const parsed: unknown = JSON.parse(raw)
    assert.ok(Array.isArray(parsed))
    assert.equal(parsed.length, 1)
  })
})
