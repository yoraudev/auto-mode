export const CHOICES = {
  provider: {
    title: "Provider",
    description: "Where prompts, tool inputs, and tool output are sent for decisions",
    options: [
      { value: "typesafe", label: "TypeSafe JEV", description: "Native System One API" },
      { value: "custom", label: "Custom endpoint", description: "Custom chat-completions decision API" },
    ],
  },
}

export const NUMBERS = {
  timeoutMs: { title: "Timeout (ms)", help: "Remote decision deadline; timeout blocks the operation" },
  minConfidence: { title: "Minimum confidence", help: "Required confidence from 0 to 1; uncertainty blocks" },
  maxInputChars: { title: "Maximum input characters", help: "Full decision input limit; oversized inputs block without truncation" },
}

export const STRINGS = {
  endpoint: { title: "Endpoint", help: "Complete remote API URL. Changing this clears the saved API key" },
  model: { title: "Model", help: "Remote decision model identifier" },
  apiKey: { title: "API key", help: "Enter a replacement key; the stored key is never displayed. Enter CLEAR to remove it" },
}

export const PROMPTS = {
  systemPrompt: { title: "System prompt", help: "Evaluator security policy. The built-in prompt is the default; replacing it can weaken protection" },
}
