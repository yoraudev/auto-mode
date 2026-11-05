import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { POLICY } from './prompts.mjs';

const PROVIDERS = {
  typesafe: { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
  custom: { endpoint: '', model: '' },
};

export const DEFAULTS = Object.freeze({
  enabled: true,
  notifications: true,
  provider: 'typesafe',
  ...PROVIDERS.typesafe,
  systemPrompt: POLICY,
  apiKey: '',
  timeoutMs: 20000,
  minConfidence: 0.8,
  maxInputChars: 100000,
});

export const SETTINGS = Object.freeze({
  enabled: { boolean: true },
  notifications: { boolean: true },
  provider: { values: ['typesafe', 'custom'] },
  endpoint: { text: true },
  model: { text: true },
  systemPrompt: { prompt: true },
  apiKey: { text: true, secret: true },
  timeoutMs: { min: 1, max: 25000, integer: true },
  minConfidence: { min: 0, max: 1 },
  maxInputChars: { min: 1, max: 1000000, integer: true },
});

const FILE_SETTINGS = { ...SETTINGS };
const own = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const configPath = (env = process.env) => env.AUTO_MODE_CONFIG || join(homedir(), '.config', 'auto-mode', 'config.json');

function endpointProblem(value) {
  try {
    if (!/^https?:\/\//.test(value)) return true;
    const url = new URL(value);
    if (url.username || url.password || value.includes('#') || /^https?:\/\/[^/]*@/.test(value)) return true;
    if (url.protocol === 'https:') return false;
    const host = url.hostname;
    return !(host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host));
  } catch {
    return true;
  }
}

function problemWith(key, value, rule) {
  if (!rule) return 'Unknown or read-only setting';
  if (rule.boolean) return typeof value === 'boolean' ? undefined : `${key} must be true or false`;
  if (rule.values) return rule.values.includes(value) ? undefined : `${key} must be one of ${rule.values.join(', ')}`;
  if (rule.prompt) {
    if (typeof value !== 'string') return `${key} must be text`;
    if (!value.trim()) return `${key} must not be empty`;
    if (value.length > 50000) return `${key} must be at most 50000 characters`;
    return value.includes('\0') ? `${key} must not contain a null character` : undefined;
  }
  if (rule.text) {
    if (typeof value !== 'string') return `${key} must be text`;
    if (key === 'endpoint') return value.length <= 4096 && !endpointProblem(value) ? undefined : 'endpoint must be HTTPS or loopback HTTP without credentials or fragments';
    if (key === 'apiKey') return value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value) ? undefined : 'apiKey must be an empty key or a token without whitespace or control characters';
    return value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? undefined : 'model must be nonempty text of at most 200 characters';
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${key} must be a finite number`;
  if (rule.integer && !Number.isInteger(value)) return `${key} must be a whole number`;
  if (value < rule.min || value > rule.max) return `${key} must be between ${rule.min} and ${rule.max}`;
  return undefined;
}

function apply(config, patch) {
  const providerChanged = own(patch, 'provider') && patch.provider !== config.provider;
  const endpointChanged = own(patch, 'endpoint') && patch.endpoint !== config.endpoint;
  return {
    ...config,
    ...(providerChanged ? PROVIDERS[patch.provider] : {}),
    ...((providerChanged || endpointChanged) ? { apiKey: '' } : {}),
    ...patch,
  };
}

function readStored(env, warn) {
  const path = configPath(env);
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (record(value)) return value;
  } catch {}
  warn('Auto Mode configuration could not be read as a JSON object; defaults are in use');
  return {};
}

function validLayer(value, warn, fallbackProvider = DEFAULTS.provider) {
  const patch = {};
  const selected = own(value, 'provider') && SETTINGS.provider.values.includes(value.provider) ? value.provider : fallbackProvider;
  for (const [key, rule] of Object.entries(FILE_SETTINGS)) {
    if (!own(value, key)) continue;
    if (selected === 'custom' && (key === 'endpoint' || key === 'model') && value[key] === '') {
      patch[key] = '';
      continue;
    }
    const problem = problemWith(key, value[key], rule);
    if (problem) warn(`Auto Mode configuration: ${problem}; ignoring invalid value`);
    else patch[key] = value[key];
  }
  if ((own(value, 'endpoint') && !own(patch, 'endpoint')) || (own(value, 'provider') && !own(patch, 'provider'))) patch.apiKey = '';
  return patch;
}

export function loadConfig(env = process.env, warn = () => {}) {
  const stored = readStored(env, warn);
  if (stored.provider === 'openai') {
    stored.provider = 'custom';
    stored.apiKey = '';
    if (stored.endpoint === 'https://api.openai.com/v1/chat/completions' && stored.model === 'gpt-4.1-mini') {
      stored.endpoint = '';
      stored.model = '';
    }
  }
  const fileLayer = validLayer(stored, warn);
  if (!own(stored, 'provider') && !own(stored, 'endpoint') && ['base', 'small'].includes(stored.model)) delete fileLayer.model;
  let config = apply({ ...DEFAULTS }, fileLayer);
  const layer = {};
  for (const [name, key] of Object.entries({ AUTO_MODE_PROVIDER: 'provider', AUTO_MODE_ENDPOINT: 'endpoint', AUTO_MODE_MODEL: 'model' })) {
    if (env[name] !== undefined) layer[key] = env[name];
  }
  if (layer.provider === 'openai') layer.provider = 'custom';
  config = apply(config, validLayer(layer, warn));
  const credentialProvider = env.AUTO_MODE_PROVIDER === 'openai' ? 'custom' : env.AUTO_MODE_PROVIDER ?? DEFAULTS.provider;
  const credentialEndpoint = env.AUTO_MODE_ENDPOINT ?? (own(PROVIDERS, credentialProvider) ? PROVIDERS[credentialProvider].endpoint : undefined);
  if (env.AUTO_MODE_API_KEY !== undefined) {
    const problem = problemWith('apiKey', env.AUTO_MODE_API_KEY, SETTINGS.apiKey);
    if (problem) {
      warn(`Auto Mode configuration: ${problem}; ignoring invalid value`);
      config.apiKey = '';
    } else if (config.provider === credentialProvider && config.endpoint && config.endpoint === credentialEndpoint) config.apiKey = env.AUTO_MODE_API_KEY;
    else warn('Auto Mode environment API key does not match the configured provider endpoint and was ignored');
  }
  if (!config.apiKey && env.AUTO_MODE_API_KEY === undefined && config.provider === 'typesafe' && new URL(config.endpoint).origin === 'https://api.typesafe.ai' && env.TYPESAFE_API_KEY !== undefined) {
    const problem = problemWith('apiKey', env.TYPESAFE_API_KEY, SETTINGS.apiKey);
    if (problem) warn(`Auto Mode configuration: ${problem}; ignoring invalid value`);
    else config.apiKey = env.TYPESAFE_API_KEY;
  }
  return config;
}

export function validate(patch, current = DEFAULTS) {
  if (!record(patch)) return 'Configuration patch must be a JSON object';
  for (const [key, value] of Object.entries(patch)) {
    const problem = problemWith(key, value, own(SETTINGS, key) ? SETTINGS[key] : undefined);
    if (problem) return problem;
  }
  const next = apply(current, patch);
  for (const [key, rule] of Object.entries(FILE_SETTINGS)) {
    if (next.provider === 'custom' && (key === 'endpoint' || key === 'model') && next[key] === '') continue;
    const problem = problemWith(key, next[key], rule);
    if (problem) return problem;
  }
  return undefined;
}

export function saveConfig(patch, env = process.env, current = loadConfig(env)) {
  const stored = loadConfig({ AUTO_MODE_CONFIG: configPath(env) });
  const problem = validate(patch, current);
  if (problem) throw new Error(problem);
  const next = apply(current, patch);
  const value = Object.fromEntries(Object.keys(FILE_SETTINGS).map((key) => [key, next[key]]));
  const targetChanged = current.provider !== next.provider || current.endpoint !== next.endpoint;
  const storedTargetMatches = stored.provider === next.provider && stored.endpoint === next.endpoint;
  value.apiKey = own(patch, 'apiKey') ? next.apiKey : !targetChanged && storedTargetMatches ? stored.apiKey : '';
  const path = configPath(env);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(`${path}.tmp`, 0o600);
    renameSync(`${path}.tmp`, path);
  } catch {
    throw new Error('Auto Mode configuration could not be saved');
  }
  return next;
}

export function publicConfig(config) {
  return {
    ...Object.fromEntries(Object.keys(FILE_SETTINGS).filter((key) => key !== 'apiKey').map((key) => [key, config[key]])),
    apiKeyConfigured: typeof config.apiKey === 'string' && config.apiKey.length > 0,
  };
}
