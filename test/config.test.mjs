import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULTS, loadConfig, publicConfig, saveConfig, validate } from '../core/config.mjs';
import { POLICY } from '../core/prompts.mjs';

function fixture(t, stored) {
  const directory = mkdtempSync(join(tmpdir(), 'auto-mode-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { AUTO_MODE_CONFIG: join(directory, 'config.json') };
  if (stored !== undefined) writeFileSync(env.AUTO_MODE_CONFIG, typeof stored === 'string' ? stored : JSON.stringify(stored));
  return env;
}

test('defaults select the native remote provider and fail closed without credentials', (t) => {
  const config = loadConfig(fixture(t));
  assert.deepEqual(config, DEFAULTS);
  assert.equal(config.provider, 'typesafe');
  assert.equal(config.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(config.model, 'jev-latest');
  assert.equal(config.timeoutMs, 20000);
  assert.equal(config.minConfidence, 0.8);
  assert.equal(publicConfig(config).apiKeyConfigured, false);
});

test('the evaluator prompt defaults to the built-in policy and persists a custom replacement', (t) => {
  const env = fixture(t);
  const config = loadConfig(env);
  assert.equal(config.systemPrompt, POLICY);
  assert.equal(validate({ systemPrompt: 'Custom policy\nSecond line.' }, config), undefined);
  assert.equal(validate({ systemPrompt: '' }, config), 'systemPrompt must not be empty');
  assert.equal(validate({ systemPrompt: 'x'.repeat(50001) }, config), 'systemPrompt must be at most 50000 characters');
  assert.equal(validate({ systemPrompt: 'x\0y' }, config), 'systemPrompt must not contain a null character');
  const saved = saveConfig({ systemPrompt: 'Custom policy\nSecond line.' }, env);
  assert.equal(saved.systemPrompt, 'Custom policy\nSecond line.');
  assert.equal(loadConfig(env).systemPrompt, 'Custom policy\nSecond line.');
  assert.equal(publicConfig(saved).systemPrompt, 'Custom policy\nSecond line.');
});

test('public configuration never returns credentials or unknown legacy fields', (t) => {
  const secret = 'secret-key-not-for-output';
  const env = fixture(t, { apiKey: secret, device: 'cpu', window: 512, strong: 0.9 });
  const visible = publicConfig({ ...loadConfig(env), secretEcho: secret });
  assert.equal(visible.apiKeyConfigured, true);
  assert.equal(Object.hasOwn(visible, 'apiKey'), false);
  assert.equal(Object.hasOwn(visible, 'device'), false);
  assert.equal(JSON.stringify(visible).includes(secret), false);
});

test('provider changes apply matching endpoint and model defaults and clear old keys', (t) => {
  const env = fixture(t, { apiKey: 'native-secret', model: 'jev-1.14.0' });
  const config = saveConfig({ provider: 'custom' }, env);
  assert.equal(config.provider, 'custom');
  assert.equal(config.endpoint, '');
  assert.equal(config.model, '');
  assert.equal(config.apiKey, '');
  assert.equal(loadConfig(env).apiKey, '');
  const native = saveConfig({ provider: 'typesafe' }, env);
  assert.equal(native.model, 'jev-latest');
  assert.equal(native.endpoint, DEFAULTS.endpoint);
});

test('endpoint changes clear saved credentials unless explicitly replaced', (t) => {
  const env = fixture(t, { apiKey: 'old-secret' });
  assert.equal(saveConfig({ endpoint: 'http://127.0.0.1:8888/decision' }, env).apiKey, '');
  const replaced = saveConfig({ provider: 'custom', endpoint: 'https://custom.example/classify', model: 'chosen-model', apiKey: 'replacement-secret' }, env);
  assert.equal(replaced.endpoint, 'https://custom.example/classify');
  assert.equal(replaced.model, 'chosen-model');
  assert.equal(replaced.apiKey, 'replacement-secret');
  assert.equal(saveConfig({ enabled: false }, env).apiKey, 'replacement-secret');
});

test('legacy local model names migrate to JEV without changing explicit remote models', (t) => {
  for (const model of ['base', 'small']) {
    for (const legacy of [{ model }, { model, device: 'cpu', window: 512, overlap: 64 }]) {
      const env = fixture(t, legacy);
      assert.equal(loadConfig(env).model, 'jev-latest');
      assert.equal(publicConfig(loadConfig(env)).model, 'jev-latest');
      saveConfig({ enabled: false }, env);
      const saved = JSON.parse(readFileSync(env.AUTO_MODE_CONFIG, 'utf8'));
      assert.equal(saved.model, 'jev-latest');
      assert.equal(Object.hasOwn(saved, 'device'), false);
      assert.equal(Object.hasOwn(saved, 'window'), false);
    }
    assert.equal(loadConfig(fixture(t, { provider: 'typesafe', model })).model, model);
    assert.equal(loadConfig(fixture(t, { endpoint: 'https://custom.example/classify', model })).model, model);
    assert.equal(loadConfig({ ...fixture(t, { model }), AUTO_MODE_MODEL: model }).model, model);
  }
});

test('the legacy OpenAI provider becomes a custom endpoint without retaining its old defaults', (t) => {
  const env = fixture(t, { provider: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4.1-mini', apiKey: 'legacy-key' });
  const config = loadConfig(env);
  assert.equal(config.provider, 'custom');
  assert.equal(config.endpoint, '');
  assert.equal(config.model, '');
  assert.equal(config.apiKey, '');
});

test('saving discards legacy inference settings and creates owner-only configuration', (t) => {
  const env = fixture(t, { device: 'gpu', modelsDir: '/old', window: 512, overlap: 64, trust: 'anything', apiKey: 'secret' });
  saveConfig({ notifications: false }, env);
  const stored = JSON.parse(readFileSync(env.AUTO_MODE_CONFIG, 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), Object.keys(DEFAULTS).sort());
  assert.equal(stored.notifications, false);
  assert.equal(stored.apiKey, 'secret');
  if (process.platform !== 'win32') assert.equal(statSync(env.AUTO_MODE_CONFIG).mode & 0o777, 0o600);
});

test('configuration validation rejects insecure endpoints and malformed settings without echoing values', () => {
  for (const endpoint of ['http://example.com/api', 'file:///tmp/secret', 'https://user:secret@example.com/api', 'https://example.com/api#fragment', 'not-a-url']) assert.equal(typeof validate({ endpoint }, DEFAULTS), 'string');
  for (const endpoint of ['https://custom.example/api', 'http://localhost:1234/api', 'http://127.0.0.2:1234/api', 'http://[::1]:1234/api']) assert.equal(validate({ endpoint }, DEFAULTS), undefined);
  for (const patch of [null, [], { device: 'cpu' }, { enabled: 'true' }, { notifications: 'on' }, { provider: 'chat' }, { timeoutMs: 0 }, { timeoutMs: 25001 }, { timeoutMs: 1.5 }, { minConfidence: NaN }, { minConfidence: 1.1 }, { maxInputChars: 1000001 }, { maxInputChars: 0 }, { model: '' }, { apiKey: 'secret\r\nheader' }]) assert.equal(typeof validate(patch, DEFAULTS), 'string');
  assert.equal(validate({ timeoutMs: 25000, maxInputChars: 1000000, minConfidence: 0 }, DEFAULTS), undefined);
  assert.equal(validate({ apiKey: 'secret\nvalue' }, DEFAULTS).includes('secret'), false);
  assert.equal(validate({ 'secret-unknown-field': true }, DEFAULTS).includes('secret'), false);
});

test('environment configuration is validated and provider changes do not forward saved credentials', (t) => {
  const env = fixture(t, { apiKey: 'native-secret' });
  const warnings = [];
  const config = loadConfig({ ...env, AUTO_MODE_PROVIDER: 'custom', AUTO_MODE_MODEL: '', AUTO_MODE_ENDPOINT: 'http://remote.example/secret' }, (warning) => warnings.push(warning));
  assert.equal(config.provider, 'custom');
  assert.equal(config.endpoint, '');
  assert.equal(config.model, '');
  assert.equal(config.apiKey, '');
  assert.equal(warnings.length, 1);
  assert.equal(warnings.join('').includes('native-secret'), false);
  assert.equal(warnings.join('').includes('remote.example'), false);
});

test('native environment fallback is restricted to official origin and native provider', (t) => {
  const env = fixture(t);
  assert.equal(loadConfig({ ...env, TYPESAFE_API_KEY: 'fallback-secret' }).apiKey, 'fallback-secret');
  assert.equal(loadConfig({ ...env, AUTO_MODE_ENDPOINT: 'https://attacker.example/v1/systemone', TYPESAFE_API_KEY: 'fallback-secret' }).apiKey, '');
  assert.equal(loadConfig({ ...env, AUTO_MODE_ENDPOINT: 'https://api.typesafe.ai:8443/v1/systemone', TYPESAFE_API_KEY: 'fallback-secret' }).apiKey, '');
  assert.equal(loadConfig({ ...env, AUTO_MODE_PROVIDER: 'custom', TYPESAFE_API_KEY: 'fallback-secret' }).apiKey, '');
  assert.equal(loadConfig({ ...env, AUTO_MODE_API_KEY: '', TYPESAFE_API_KEY: 'fallback-secret' }).apiKey, '');
  assert.equal(loadConfig({ ...env, AUTO_MODE_PROVIDER: 'custom', AUTO_MODE_ENDPOINT: 'https://custom.example/api', AUTO_MODE_MODEL: 'custom-model', AUTO_MODE_API_KEY: 'custom-secret' }).apiKey, 'custom-secret');
});

test('environment credentials are bound to their explicit or default provider endpoint', (t) => {
  const custom = fixture(t, { provider: 'custom', endpoint: 'https://custom.example/api', model: 'custom-model' });
  assert.equal(loadConfig({ ...custom, AUTO_MODE_API_KEY: 'native-env-secret' }).apiKey, '');
  assert.equal(loadConfig({ ...custom, AUTO_MODE_PROVIDER: 'custom', AUTO_MODE_API_KEY: 'custom-env-secret' }).apiKey, '');
  assert.equal(loadConfig({ ...custom, AUTO_MODE_PROVIDER: 'custom', AUTO_MODE_ENDPOINT: 'https://custom.example/api', AUTO_MODE_API_KEY: 'bound-secret' }).apiKey, 'bound-secret');
  const unset = fixture(t, { provider: 'custom' });
  assert.equal(loadConfig({ ...unset, AUTO_MODE_API_KEY: 'native-env-secret' }).apiKey, '');
  assert.equal(loadConfig({ ...unset, AUTO_MODE_PROVIDER: 'custom', AUTO_MODE_API_KEY: 'custom-env-secret' }).apiKey, '');
  const stored = fixture(t, { provider: 'custom', endpoint: 'https://custom.example/api', apiKey: 'stored-secret' });
  assert.equal(loadConfig({ ...stored, AUTO_MODE_API_KEY: 'unbound-env-secret' }).apiKey, 'stored-secret');
  const native = fixture(t);
  assert.equal(loadConfig({ ...native, AUTO_MODE_API_KEY: 'native-env-secret' }).apiKey, 'native-env-secret');
  saveConfig({ endpoint: 'https://custom.example/api' }, native);
  assert.equal(loadConfig({ ...native, AUTO_MODE_API_KEY: 'native-env-secret' }).apiKey, '');
});

test('malformed files and invalid secrets produce only sanitized warnings', (t) => {
  for (const stored of ['{"apiKey":"private-secret",', { endpoint: 'https://private-secret@example.com', apiKey: 'private-secret' }, { apiKey: 'private-secret\n' }]) {
    const warnings = [];
    const config = loadConfig(fixture(t, stored), (warning) => warnings.push(warning));
    assert.equal(config.apiKey, '');
    assert.ok(warnings.length > 0);
    assert.equal(warnings.join('').includes('private-secret'), false);
  }
});

test('invalid runtime patches never write credentials or mutate stored configuration', (t) => {
  const env = fixture(t, { apiKey: 'existing-secret' });
  const before = readFileSync(env.AUTO_MODE_CONFIG, 'utf8');
  assert.throws(() => saveConfig({ apiKey: 'new-secret\n' }, env), (error) => !error.message.includes('new-secret'));
  assert.equal(readFileSync(env.AUTO_MODE_CONFIG, 'utf8'), before);
});

test('key-only runtime saves bind the replacement to the effective environment endpoint', (t) => {
  const file = fixture(t, { provider: 'custom', endpoint: 'https://stored.example/api', model: 'stored-model', apiKey: 'stored-secret' });
  const env = { ...file, AUTO_MODE_PROVIDER: 'custom', AUTO_MODE_ENDPOINT: 'https://effective.example/api', AUTO_MODE_MODEL: 'effective-model', AUTO_MODE_API_KEY: 'environment-secret' };
  const next = saveConfig({ apiKey: 'replacement-secret' }, env);
  const stored = JSON.parse(readFileSync(file.AUTO_MODE_CONFIG, 'utf8'));
  assert.equal(next.endpoint, 'https://effective.example/api');
  assert.equal(next.apiKey, 'replacement-secret');
  assert.equal(stored.endpoint, 'https://effective.example/api');
  assert.equal(stored.model, 'effective-model');
  assert.equal(stored.apiKey, 'replacement-secret');
  assert.equal(JSON.stringify(stored).includes('environment-secret'), false);
});

test('unrelated runtime saves never persist environment-only credentials', (t) => {
  const file = fixture(t, { provider: 'custom', endpoint: 'https://stored.example/api', apiKey: 'stored-secret' });
  const env = { ...file, AUTO_MODE_PROVIDER: 'custom', AUTO_MODE_ENDPOINT: 'https://effective.example/api', AUTO_MODE_API_KEY: 'environment-secret' };
  let current = saveConfig({ notifications: false }, env);
  assert.equal(current.apiKey, 'environment-secret');
  assert.equal(JSON.parse(readFileSync(file.AUTO_MODE_CONFIG, 'utf8')).apiKey, '');
  current = saveConfig({ enabled: false }, env, current);
  assert.equal(current.apiKey, 'environment-secret');
  assert.equal(readFileSync(file.AUTO_MODE_CONFIG, 'utf8').includes('environment-secret'), false);
  const sameTargetFile = fixture(t, { apiKey: 'saved-secret' });
  const sameTargetEnv = { ...sameTargetFile, AUTO_MODE_API_KEY: 'environment-secret' };
  assert.equal(saveConfig({ notifications: false }, sameTargetEnv).apiKey, 'environment-secret');
  assert.equal(JSON.parse(readFileSync(sameTargetFile.AUTO_MODE_CONFIG, 'utf8')).apiKey, 'saved-secret');
});

test('sequential saves preserve runtime endpoint overrides and cleared credentials', (t) => {
  const file = fixture(t, { provider: 'custom', endpoint: 'https://stored.example/api', apiKey: 'stored-secret' });
  const env = { ...file, AUTO_MODE_PROVIDER: 'custom', AUTO_MODE_ENDPOINT: 'https://effective.example/api', AUTO_MODE_API_KEY: 'environment-secret' };
  let current = saveConfig({ endpoint: 'https://runtime.example/api' }, env);
  assert.equal(current.endpoint, 'https://runtime.example/api');
  assert.equal(current.apiKey, '');
  current = saveConfig({ notifications: false }, env, current);
  assert.equal(current.endpoint, 'https://runtime.example/api');
  assert.equal(current.apiKey, '');
  let stored = JSON.parse(readFileSync(file.AUTO_MODE_CONFIG, 'utf8'));
  assert.equal(stored.endpoint, 'https://runtime.example/api');
  assert.equal(stored.apiKey, '');
  current = saveConfig({ apiKey: 'runtime-secret' }, env, current);
  current = saveConfig({ enabled: false }, env, current);
  stored = JSON.parse(readFileSync(file.AUTO_MODE_CONFIG, 'utf8'));
  assert.equal(current.apiKey, 'runtime-secret');
  assert.equal(stored.apiKey, 'runtime-secret');
  current = saveConfig({ provider: 'typesafe' }, env, current);
  assert.equal(current.endpoint, DEFAULTS.endpoint);
  assert.equal(current.apiKey, '');
  assert.equal(JSON.parse(readFileSync(file.AUTO_MODE_CONFIG, 'utf8')).apiKey, '');
});
