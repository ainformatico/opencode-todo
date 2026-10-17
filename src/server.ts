import { Plugin } from "@opencode/plugin"
import * as store from "./store.ts"

export default Plugin.define({
  id: "opencode-todo.server",
  async setup(ctx) {
    const worktree = ctx.location.directory
    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.deleted") continue
          try {
            await store.clear(worktree, event.data.sessionID)
          } catch (error) {
            console.error("[opencode-todo] failed to purge deleted session", error)
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("[opencode-todo] event subscription failed", error)
      }
    })()

    return () => controller.abort()
  },
})
