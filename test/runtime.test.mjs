import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRuntime, isDecision, unavailable } from '../adapters/shared/runtime.js';
import { DEFAULTS } from '../core/config.mjs';

const allow = { effect: 'allow', category: 'safe', reason: 'Authorized.', confidence: 0.99 };
const context = { userPrompts: ['Fix the parser. Do not commit.'], goal: 'Fix parser errors.', agent: { kind: 'main', id: 'Main', name: 'main' }, runtimeId: '123', assignment: null };
const request = { tool: 'bash', input: { command: 'git status', cwd: '/actual' }, cwd: '/session' };

function setup(t, stored = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-mode-runtime-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ ...DEFAULTS, ...stored }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { env: { AUTO_MODE_CONFIG: path } };
}

test('the runtime exposes config, session state and direct decisions', async (t) => {
  const { env } = setup(t);
  const runtime = createRuntime({ env, evaluate: async () => allow });
  assert.equal((await runtime.call('config')).apiKeyConfigured, false);
  await runtime.call('context', { session: 's', context });
  assert.deepEqual(await runtime.call('session', { session: 's' }), { checks: 0, blocked: 0, lastDecision: undefined });
  assert.deepEqual(await runtime.decide('s', request, context), allow);
  assert.deepEqual(await runtime.scan({ session: 's', context, tool: 'read', text: 'X' }), allow);
  assert.equal((await runtime.call('session', { session: 's' })).checks, 2);
  await runtime.call('clear', { session: 's' });
  assert.equal((await runtime.call('session', { session: 's' })).checks, 0);
});

test('an evaluation failure or malformed decision blocks instead of allowing', async (t) => {
  const { env } = setup(t);
  const failing = createRuntime({ env, evaluate: async () => { throw new Error('offline secret-token'); } });
  const blocked = await failing.decide('s', request, context);
  assert.equal(blocked.effect, 'block');
  assert.equal(blocked.category, 'unavailable');
  assert.doesNotMatch(JSON.stringify(blocked), /secret-token/);
  const malformed = createRuntime({ env, evaluate: async () => ({ effect: 'ask', pending: true }) });
  assert.equal((await malformed.decide('s', request, context)).effect, 'block');
  assert.equal(isDecision(allow), true);
  assert.equal(isDecision({ effect: 'allow', category: 'safe', reason: 'No confidence', confidence: null }), false);
  assert.equal(isDecision(unavailable()), true);
});

test('explicit disablement is respected and unknown runtime actions fail closed', async (t) => {
  const { env } = setup(t, { enabled: false });
  const runtime = createRuntime({ env, evaluate: async () => allow });
  assert.deepEqual(await runtime.decide('s', request, context), { disabled: true });
  assert.deepEqual(await runtime.scan({ session: 's', context, tool: 'read', text: 'X' }), { disabled: true });
  await assert.rejects(runtime.call('unknown'), /Unknown Auto Mode action/);
});

test('runtime configuration changes are validated and never expose credentials', async (t) => {
  const { env } = setup(t, { apiKey: 'secret-token' });
  const runtime = createRuntime({ env, evaluate: async () => allow });
  assert.equal((await runtime.call('config')).apiKeyConfigured, true);
  assert.equal(Object.hasOwn(await runtime.call('config'), 'apiKey'), false);
  const invalid = await runtime.call('config', { timeoutMs: 0 });
  assert.match(invalid.error, /between/);
  const saved = await runtime.call('config', { notifications: false });
  assert.equal(saved.notifications, false);
  assert.equal(JSON.stringify(saved).includes('secret-token'), false);
});