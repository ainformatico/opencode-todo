import { afterEach, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Event, Session } from "@opencode-ai/sdk"
import * as store from "../src/store.ts"
import plugin from "../src/server.ts"

const A = "ses_aaa"
const B = "ses_bbb"

const dirs: string[] = []
let worktree: string

beforeEach(async () => {
  worktree = await mkdtemp(path.join(tmpdir(), "queue-server-test-"))
  dirs.push(worktree)
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function deletedEvent(sessionID: string): Extract<Event, { type: "session.deleted" }> {
  return {
    type: "session.deleted",
    properties: { info: { id: sessionID } as Session },
  }
}

function updatedEvent(sessionID: string): Extract<Event, { type: "session.updated" }> {
  return {
    type: "session.updated",
    properties: { info: { id: sessionID } as Session },
  }
}

async function hooks() {
  const result = await plugin.server({ worktree } as never)
  assert.ok(result && typeof result.event === "function")
  return result
}

describe("server plugin", () => {
  test("ignores events other than session.deleted", async () => {
    await store.add(worktree, A, "a1")
    const server = await hooks()
    await server.event!({ event: updatedEvent(A) })
    assert.equal((await store.load(worktree, A)).length, 1)
  })

  test("session.deleted purges only that session's items", async () => {
    await store.add(worktree, A, "a1")
    await store.add(worktree, A, "a2")
    await store.add(worktree, B, "b1")
    const server = await hooks()
    await server.event!({ event: deletedEvent(A) })
    assert.deepEqual(await store.load(worktree, A), [])
    assert.deepEqual(
      (await store.load(worktree, B)).map((i) => i.text),
      ["b1"],
    )
  })

  test("purge on a missing queue file does not throw", async () => {
    const server = await hooks()
    await server.event!({ event: deletedEvent(A) })
    assert.deepEqual(await store.loadAll(worktree), [])
  })
})
