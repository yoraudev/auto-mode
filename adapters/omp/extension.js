import { isDecision, unavailable } from "../shared/runtime.js"
import { withheldNote } from "../shared/notices.js"
import { toRequest } from "./request.js"
import { openSettings, statusText } from "./settings.js"

const STATUS_KEY = "auto-mode"
const INPUT_ENTRY = "auto-mode-direct-input"
const textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : ""
const activeObjective = (goal) => goal?.status === "active" && typeof goal.objective === "string" ? goal.objective : null

async function bounded(operation) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation).catch(() => unavailable()),
      new Promise((resolve) => { timer = setTimeout(() => resolve(unavailable()), 26000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function createExtension({ call, scan: scanOutput, decide }) {
  return function autoMode(pi) {
    let epoch = 0
    let pending = []
    let goalUpdate
    let config
    const sessionOf = (ctx) => ctx.sessionManager.getSessionId()
    const showStatus = (ctx, current) => {
      config = current
      if (ctx.hasUI && current) ctx.ui.setStatus(STATUS_KEY, statusText(current, ctx.ui.theme))
    }
    const notify = (ctx, message) => {
      try {
        if (ctx.hasUI && config?.notifications !== false) ctx.ui.notify(message, "warning")
      } catch {}
    }
    const contextOf = (ctx) => {
      const userPrompts = []
      const assignments = []
      let goal = null
      let modeId
      let marked = 0
      let userGoalInput = false
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === INPUT_ENTRY && typeof entry.data?.text === "string" && (entry.data.source === "interactive" || entry.data.source === "rpc")) {
          userPrompts.push(entry.data.text)
          if (/^\/goal(?:\s|$)/.test(entry.data.text.trim())) userGoalInput = true
          else marked++
        } else if (entry.type === "message" && entry.message?.role === "user") {
          const text = textOf(entry.message.content)
          if (entry.message.attribution === "user") {
            if (userGoalInput && text && text === goal && ctx.agent?.kind !== "sub") {
              userPrompts.push(text)
              userGoalInput = false
            } else {
              if (!marked && text) (ctx.agent?.kind === "sub" ? assignments : userPrompts).push(text)
              if (marked) marked--
            }
          } else if (ctx.agent?.kind === "sub" && text) {
            assignments.push(text)
          }
        } else if (entry.type === "mode_change") {
          modeId = entry.id
          goal = entry.mode === "goal" ? activeObjective(entry.data?.goal) : null
        }
      }
      for (const text of pending) if (!userPrompts.includes(text)) userPrompts.push(text)
      if (goalUpdate && goalUpdate.modeId === modeId) goal = goalUpdate.objective
      const agent = ctx.agent ? { kind: ctx.agent.kind, id: ctx.agent.id, name: ctx.agent.name, ...(ctx.agent.parentId ? { parentId: ctx.agent.parentId } : {}) } : null
      const sessionFile = ctx.sessionManager.getSessionFile?.() ?? null
      const parentSession = ctx.agent?.kind === "sub" ? ctx.sessionManager.getHeader?.()?.parentSession : null
      const parentSessionFile = typeof parentSession === "string" && /[\\/]/.test(parentSession) ? parentSession : null
      return { userPrompts, goal, agent, runtimeId: String(process.pid), assignment: assignments.length ? assignments.join("\n\n") : null, sessionFile, parentSessionFile }
    }
    const publish = (ctx) => call("context", { session: sessionOf(ctx), context: contextOf(ctx) }).catch(() => undefined)
    const reset = async (_event, ctx) => {
      epoch++
      pending = []
      goalUpdate = undefined
      await publish(ctx)
      showStatus(ctx, await call("config"))
    }
    for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) pi.on(event, reset)

    pi.on("input", async (event, ctx) => {
      if (event.source !== "interactive" && event.source !== "rpc") return
      if (typeof event.text !== "string" || !event.text) return
      epoch++
      if (pi.appendEntry) pi.appendEntry(INPUT_ENTRY, { text: event.text, source: event.source })
      else pending.push(event.text)
      await publish(ctx)
    })

    pi.on("before_agent_start", async (_event, ctx) => {
      await publish(ctx)
    })

    pi.on("goal_updated", async (event, ctx) => {
      epoch++
      const modes = ctx.sessionManager.getBranch().filter((entry) => entry.type === "mode_change")
      goalUpdate = { modeId: modes.at(-1)?.id, objective: event.state?.enabled === false ? null : activeObjective(event.goal) }
      await publish(ctx)
    })

    const evaluate = async (ctx, operation) => {
      try {
        const session = sessionOf(ctx)
        const context = contextOf(ctx)
        const snapshot = JSON.stringify(context)
        const version = epoch
        const decision = await bounded(() => operation(session, context))
        if (version !== epoch || session !== sessionOf(ctx) || snapshot !== JSON.stringify(contextOf(ctx))) return { effect: "block", category: "uncertain", reason: "The active user context changed while the operation was being checked.", confidence: null }
        if (decision?.disabled === true) return decision
        if (!context.userPrompts.length && context.agent?.kind !== "sub") return { effect: "block", category: "uncertain", reason: "No verifiable direct user request is available on this branch.", confidence: null }
        return isDecision(decision) ? decision : unavailable()
      } catch {
        return unavailable()
      }
    }

    pi.on("tool_call", async (event, ctx) => {
      const decision = await evaluate(ctx, (session, context) => decide(session, toRequest(event, ctx.cwd), context))
      if (decision.disabled || decision.effect === "allow") return
      notify(ctx, `Auto mode blocked ${event.toolName}: ${decision.reason}`)
      return { block: true, reason: `Auto mode blocked this call: ${decision.reason}` }
    })

    pi.on("tool_result", async (event, ctx) => {
      const text = textOf(event.content)
      if (!text) return
      const decision = await evaluate(ctx, (session, context) => scanOutput({ session, context, tool: event.toolName, text }))
      if (decision.disabled || decision.effect === "allow") return
      notify(ctx, `Auto mode withheld the output of ${event.toolName} and stopped the agent: ${decision.reason}`)
      try { ctx.abort() } catch {}
      return { content: [{ type: "text", text: withheldNote }], isError: true, details: {} }
    })

    pi.registerCommand("auto-mode", {
      description: "Automatic remote decision settings",
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) return
        await openSettings({ ui: ctx.ui, call, session: sessionOf(ctx), onChange: (current) => showStatus(ctx, current) })
      },
    })
  }
}
