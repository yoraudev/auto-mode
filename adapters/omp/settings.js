import { CHOICES, NUMBERS, PROMPTS, STRINGS } from "../shared/settings.js"

export const statusText = (config, theme) => {
  const plain = config.enabled ? `auto mode: ${config.provider}/${config.model}` : "auto mode: off"
  if (!theme) return plain
  if (!config.enabled) return `${theme.fg("warning", "○")} ${theme.fg("dim", "auto mode:")} ${theme.fg("warning", "off")}`
  return `${theme.fg("success", "●")} ${theme.fg("dim", "auto mode:")} ${theme.fg("accent", config.provider)}${theme.fg("dim", "/")}${theme.fg("text", config.model)}`
}

async function pick(key, config, ui) {
  if (CHOICES[key]) {
    const item = CHOICES[key]
    const labels = item.options.map((option) => `${option.label ?? option.value}: ${option.description}`)
    const label = await ui.select(`${item.title}. ${item.description}. Now: ${config[key]}`, labels)
    const index = labels.indexOf(label)
    return index < 0 ? undefined : item.options[index].value
  }
  if (PROMPTS[key]) {
    const item = PROMPTS[key]
    const value = await ui.editor(`${item.title}. ${item.help}`, config[key])
    if (value === undefined || !value.trim()) return undefined
    return value.trim()
  }
  const item = NUMBERS[key] ?? STRINGS[key]
  const value = await ui.input(`${item.title}. ${item.help}`, key === "apiKey" ? "" : String(config[key]))
  if (value === undefined || !value.trim()) return undefined
  return NUMBERS[key] ? Number(value) : key === "apiKey" && value === "CLEAR" ? "" : value.trim()
}

export async function openSettings({ ui, call, session, onChange = () => {} }) {
  for (;;) {
    const config = await call("config").catch(() => undefined)
    if (!config) return ui.notify("Auto mode: configuration could not be read. Operations remain blocked unless Auto mode is explicitly disabled.", "error")
    onChange(config)
    const state = session ? await call("session", { session }).catch(() => undefined) : undefined
    const entries = [
      ["enabled", { label: "Auto mode", description: "select to toggle" }],
      ["notifications", { label: "Notifications", description: "select to toggle" }],
    ]
    for (const [key, item] of Object.entries({ ...CHOICES, ...STRINGS, ...PROMPTS, ...NUMBERS })) {
      entries.push([key, { label: item.title, description: item.help ?? item.description }])
    }
    if (state?.checks || state?.blocked) entries.push(["clear", { label: "Clear session counters", description: "keep user restrictions" }])
    const color = (text, tone) => ui.theme ? ui.theme.fg(tone, text) : text
    const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "")
    const valueOf = (key) => key === "enabled" ? config.enabled ? "on" : "off" : key === "notifications" ? config.notifications ? "on" : "off" : key === "apiKey" ? config.apiKeyConfigured ? "configured (hidden)" : "not configured" : key === "systemPrompt" ? `${config.systemPrompt.length} characters` : key === "clear" ? `${state?.checks ?? 0} checks, ${state?.blocked ?? 0} blocked` : key === "endpoint" || key === "model" ? config[key] || "not set" : String(config[key])
    const toneOf = (key) => key === "enabled" ? config.enabled ? "success" : "warning" : key === "clear" || (key === "apiKey" && !config.apiKeyConfigured) ? "warning" : "accent"
    const display = (key, item) => `${color(item.label, toneOf(key))} ${color(`· ${valueOf(key)}`, "dim")}`
    const options = entries.map(([key, item]) => ({ label: display(key, item), description: item.description }))
    const label = await ui.select("Auto mode: automatic remote allow/block", options)
    if (label === undefined) return
    const key = entries.find(([entryKey, item]) => plain(display(entryKey, item)) === plain(label))?.[0]
    if (key === undefined) return
    if (key === "clear") {
      const result = await call("clear", { session }).catch(() => undefined)
      ui.notify(result ? "Auto mode: session counters cleared; user restrictions are unchanged." : "Auto mode: session state could not be cleared.", result ? "info" : "error")
      continue
    }
    const value = key === "enabled" || key === "notifications" ? !config[key] : await pick(key, config, ui)
    if (value === undefined || value === config[key]) continue
    const patch = { [key]: value }
    if (key === "endpoint" || key === "provider") patch.apiKey = ""
    const result = await call("config", patch).catch(() => ({ error: "Settings could not be saved." }))
    if (!result || result.error) {
      ui.notify(`Auto mode: ${result?.error ?? "settings could not be saved."}`, "error")
      continue
    }
    onChange(result)
    if (key === "enabled") ui.notify(result.enabled ? "Auto mode is on." : "Auto mode is off. Tool calls and tool output are not checked.", result.enabled ? "info" : "warning")
    else if (key === "systemPrompt") ui.notify("Auto mode: system prompt updated.", "info")
    else if (key === "apiKey") ui.notify("Auto mode: API key updated (hidden).", "info")
    else if (key === "endpoint" || key === "provider") ui.notify("Auto mode: destination updated and the previous API key cleared. Set a key for this destination before continuing.", "warning")
    else ui.notify("Auto mode: settings updated.", "info")
  }
}
