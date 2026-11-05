import { validate } from './config.mjs';
import { INJECTION_CRITERIA, SCOPE_CRITERIA, composePrompts } from './prompts.mjs';

const MAX_RESPONSE_BYTES = 65536;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const probability = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const decision = (category, reason, confidence = null) => ({ effect: category === 'safe' ? 'allow' : 'block', category, reason, confidence });
const unavailable = () => decision('unavailable', 'The remote decision provider is unavailable or returned an invalid response.');

function validInput(input) {
  if (!record(input) || !['action', 'output'].includes(input.kind) || !record(input.context)) return false;
  const { userPrompts, goal, agent } = input.context;
  if (!Array.isArray(userPrompts) || !userPrompts.every((prompt) => typeof prompt === 'string')) return false;
  if (goal !== null && typeof goal !== 'string') return false;
  if (agent !== null && (!record(agent) || !['kind', 'id', 'name'].every((key) => typeof agent[key] === 'string') || (agent.parentId !== undefined && typeof agent.parentId !== 'string'))) return false;
  if (input.observations !== undefined && (!Array.isArray(input.observations) || !input.observations.every((item) => record(item) && typeof item.tool === 'string' && typeof item.text === 'string'))) return false;
  if (input.kind === 'action') return record(input.request) && typeof input.request.tool === 'string' && input.request.tool.length > 0 && record(input.request.input) && typeof input.request.cwd === 'string';
  return record(input.output) && typeof input.output.tool === 'string' && typeof input.output.text === 'string';
}

function nativeChoice(answer, criteria) {
  if (!record(answer) || answer.type !== 'choice' || typeof answer.choice !== 'string' || !Object.hasOwn(criteria, answer.choice) || !probability(answer.confidence)) throw new Error('Invalid choice');
  const keys = Object.keys(criteria);
  if (!exactKeys(answer.probabilities, keys)) throw new Error('Invalid probabilities');
  let total = 0;
  for (const key of keys) {
    const value = answer.probabilities[key];
    if (!probability(value) || value > answer.probabilities[answer.choice]) throw new Error('Invalid probabilities');
    total += value;
  }
  if (Math.abs(total - 1) > 0.01) throw new Error('Invalid probabilities');
  return { choice: answer.choice, confidence: answer.confidence };
}

function parseNative(body, action) {
  if (!record(body) || !exactKeys(body.answers, action ? ['injection', 'scope'] : ['injection'])) throw new Error('Invalid answers');
  const injection = nativeChoice(body.answers.injection, INJECTION_CRITERIA);
  const scope = action ? nativeChoice(body.answers.scope, SCOPE_CRITERIA) : null;
  return { injection: injection.choice, scope: scope?.choice, confidence: scope ? Math.min(injection.confidence, scope.confidence) : injection.confidence };
}

function parseOpenAI(body, action) {
  if (!record(body) || !Array.isArray(body.choices) || body.choices.length !== 1) throw new Error('Invalid choices');
  const choice = body.choices[0];
  if (!record(choice) || (choice.finish_reason !== undefined && choice.finish_reason !== 'stop') || !record(choice.message) || typeof choice.message.content !== 'string' || choice.message.refusal || choice.message.tool_calls) throw new Error('Invalid message');
  const result = JSON.parse(choice.message.content);
  if (!exactKeys(result, action ? ['injection', 'scope', 'confidence'] : ['injection', 'confidence']) || typeof result.injection !== 'string' || !Object.hasOwn(INJECTION_CRITERIA, result.injection) || !probability(result.confidence) || (action && (typeof result.scope !== 'string' || !Object.hasOwn(SCOPE_CRITERIA, result.scope)))) throw new Error('Invalid classification');
  return result;
}

function normalize(result, minConfidence) {
  const { injection, scope, confidence } = result;
  if (injection === 'injection') return decision('injection', 'The remote evaluator classified the content as active prompt injection.', confidence);
  if (scope === 'out_of_scope') return decision('scope', 'The remote evaluator classified the proposed action as outside direct user authorization.', confidence);
  if (injection === 'uncertain' || scope === 'uncertain' || confidence < minConfidence) return decision('uncertain', 'The remote evaluator did not establish safety and authorization with sufficient confidence.', confidence);
  return decision('safe', scope === undefined ? 'The remote evaluator classified the content as clean with sufficient confidence.' : 'The remote evaluator classified the action as clean and authorized with sufficient confidence.', confidence);
}

async function readBounded(response, signal) {
  if (!response || !response.ok || response.redirected || response.status < 200 || response.status >= 300) throw new Error('Provider failed');
  const length = response.headers?.get('content-length');
  if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new Error('Oversized response');
  if (!response.body?.getReader) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid response body');
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Oversized response');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

export async function evaluate(config, input, { fetch: fetchImpl = globalThis.fetch } = {}) {
  let timer;
  let controller;
  try {
    if (!record(config) || validate({}, config) || !config.apiKey || typeof fetchImpl !== 'function') return unavailable();
    const serialized = JSON.stringify(input);
    if (typeof serialized !== 'string' || serialized.length > config.maxInputChars) return decision('uncertain', 'The complete evaluation input exceeds the configured input limit.');
    const state = JSON.parse(serialized);
    if (!validInput(state)) return unavailable();
    if (state.kind === 'action' && !state.context.userPrompts.some((prompt) => prompt.trim())) return decision('uncertain', 'No direct user authorization is available for the proposed action.');
    const action = state.kind === 'action';
    const prompts = composePrompts(config.systemPrompt);
    const body = config.provider === 'typesafe' ? {
      model: config.model,
      state,
      questions: {
        injection: { type: 'choice', instructions: prompts.injection, criteria: INJECTION_CRITERIA },
        ...(action ? { scope: { type: 'choice', instructions: prompts.scope, criteria: SCOPE_CRITERIA } } : {}),
      },
    } : {
      model: config.model,
      messages: [{ role: 'system', content: prompts.openai }, { role: 'user', content: serialized }],
      temperature: 0,
      response_format: { type: 'json_object' },
    };
    controller = new AbortController();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Provider timed out'));
      }, config.timeoutMs);
    });
    const operation = (async () => {
      const response = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      const result = await readBounded(response, controller.signal);
      return config.provider === 'typesafe' ? parseNative(result, action) : parseOpenAI(result, action);
    })();
    return normalize(await Promise.race([operation, deadline]), config.minConfidence);
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
    controller?.abort();
  }
}
