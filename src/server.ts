import type { Plugin } from "@opencode-ai/plugin"
import * as store from "./store.ts"

const server: Plugin = async (input) => {
  const worktree = input.worktree
  return {
    event: async ({ event }) => {
      if (event.type !== "session.deleted") return
      try {
        await store.clear(worktree, event.properties.info.id)
      } catch (error) {
        console.error("[opencode-todo] failed to purge deleted session", error)
      }
    },
  }
}

export default { id: "opencode-todo.server", server }
