import { createGuard } from "../../core/guard.mjs"

export const OFFLINE_REASON = "Auto mode could not complete the decision; the operation was blocked."
export const unavailable = () => ({ effect: "block", category: "unavailable", reason: OFFLINE_REASON, confidence: null })

const categories = new Set(["safe", "injection", "scope", "uncertain", "unavailable"])
export const isDecision = (value) => value && (value.effect === "allow" || value.effect === "block") && categories.has(value.category) && typeof value.reason === "string" && (value.confidence === null || (Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1)) && (value.effect !== "allow" || (value.category === "safe" && value.confidence !== null))

export function createRuntime(options = {}) {
  const guard = createGuard({ env: options.env, log: options.log, evaluate: options.evaluate })
  const call = async (path, body) => {
    if (path === "config") return body === undefined ? guard.config() : guard.setConfig(body)
    if (path === "session") return guard.session(body?.session)
    if (path === "clear") return guard.clear(body?.session)
    if (path === "context") return guard.context(body ?? {})
    throw new Error(`Unknown Auto Mode action: ${path}`)
  }
  return { call, scan: guard.scan, decide: guard.decide, guard }
}