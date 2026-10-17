import { afterEach, beforeEach, describe, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
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

type SetupContext = Parameters<typeof plugin.setup>[0]

function makeEvents() {
  const queue: unknown[] = []
  let wake: (() => void) | undefined
  let closed = false
  const events = {
    push(event: unknown) {
      queue.push(event)
      wake?.()
      wake = undefined
    },
    close() {
      closed = true
      wake?.()
      wake = undefined
    },
    subscribe(options?: { signal?: AbortSignal }) {
      options?.signal?.addEventListener("abort", () => events.close(), { once: true })
      return (async function* () {
        while (!closed) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve
            })
            continue
          }
          yield queue.shift()
        }
      })()
    },
  }
  return events
}

async function start() {
  const events = makeEvents()
  const context = { location: { directory: worktree }, event: { subscribe: events.subscribe } } as unknown as SetupContext
  const cleanup = await plugin.setup(context)
  return { events, cleanup }
}

async function until(check: () => Promise<boolean>, timeout = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("condition not met in time")
}

const updated = (sessionID: string) => ({ type: "session.updated", data: { sessionID } })
const deleted = (sessionID: string) => ({ type: "session.deleted", data: { sessionID } })

describe("server plugin", () => {
  test("ignores events other than session.deleted", async () => {
    await store.add(worktree, A, "a1")
    await store.add(worktree, B, "b1")
    const { events } = await start()
    events.push(updated(A))
    events.push(deleted(B))
    await until(async () => (await store.load(worktree, B)).length === 0)
    assert.deepEqual(
      (await store.load(worktree, A)).map((item) => item.text),
      ["a1"],
    )
    events.close()
  })

  test("session.deleted purges only that session's items", async () => {
    await store.add(worktree, A, "a1")
    await store.add(worktree, A, "a2")
    await store.add(worktree, B, "b1")
    const { events } = await start()
    events.push(deleted(A))
    await until(async () => (await store.load(worktree, A)).length === 0)
    assert.deepEqual(
      (await store.load(worktree, B)).map((item) => item.text),
      ["b1"],
    )
    events.close()
  })

  test("purge on a missing queue file does not throw", async () => {
    await store.add(worktree, B, "b1")
    const { events } = await start()
    events.push(deleted(A))
    events.push(deleted(B))
    await until(async () => (await store.loadAll(worktree)).length === 0)
    events.close()
  })

  test("cleanup stops the subscription", async () => {
    await store.add(worktree, A, "a1")
    const { events, cleanup } = await start()
    await cleanup?.()
    events.push(deleted(A))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(
      (await store.load(worktree, A)).map((item) => item.text),
      ["a1"],
    )
  })
})
