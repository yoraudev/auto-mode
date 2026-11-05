export function toRequest({ toolName, input = {} }, cwd) {
  return { tool: toolName, input, cwd }
}
