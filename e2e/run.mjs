import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../adapters/shared/runtime.js';

const dir = mkdtempSync(join(tmpdir(), 'auto-mode-e2e-'));
const configFile = join(dir, 'config.json');
const fixture = (name) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const choice = (value, options) => ({ type: 'choice', choice: value, confidence: 1, probabilities: Object.fromEntries(options.map((option) => [option, option === value ? 1 : 0])) });
const counts = { typesafe: 0, custom: 0 };
let providerMode = 'normal';
const provider = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  assert.equal(req.headers.authorization, 'Bearer loopback-key');
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const native = req.url === '/v1/systemone';
  counts[native ? 'typesafe' : 'custom']++;
  const state = native ? body.state : JSON.parse(body.messages.find((message) => message.role === 'user').content);
  if (!native) assert.equal(body.messages[0].role, 'system');
  if (providerMode === 'error') return res.writeHead(503).end('provider failure');
  if (providerMode === 'malformed') return res.writeHead(200, { 'content-type': 'application/json' }).end('{invalid');
  const injection = state.kind === 'output' && state.output.text === fixture('injected.md') ? 'injection' : 'clean';
  const forbidden = state.kind === 'action' && state.request.input.command === 'git push';
  const scope = forbidden ? 'out_of_scope' : 'authorized';
  if (native) {
    assert.equal(body.model, 'jev-latest');
    assert.equal(body.questions.injection.type, 'choice');
    if (state.kind === 'action') assert.equal(body.questions.scope.type, 'choice');
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      model: 'loopback-decision-fixture',
      answers: {
        injection: choice(injection, ['clean', 'injection', 'uncertain']),
        ...(state.kind === 'action' ? { scope: choice(scope, ['authorized', 'out_of_scope', 'uncertain']) } : {}),
      },
    }));
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ injection, ...(state.kind === 'action' ? { scope } : {}), confidence: 1 }) } }] }));
});
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const context = { userPrompts: ['Fix the parser bug and run its tests. Do not commit or push.'], goal: 'Fix the parser bug.', agent: { kind: 'main', id: 'Main', name: 'main' }, runtimeId: 'e2e-root' };
try {
  const providerPort = await listen(provider);
  writeFileSync(configFile, JSON.stringify({ provider: 'typesafe', endpoint: `http://127.0.0.1:${providerPort}/v1/systemone`, model: 'jev-latest', apiKey: 'loopback-key' }));
  const runtime = createRuntime({ env: { AUTO_MODE_CONFIG: configFile } });
  const act = (command) => runtime.decide('root', { tool: 'bash', input: { command }, cwd: '/project' }, context);
  assert.equal((await runtime.call('config')).apiKeyConfigured, true);
  assert.equal((await runtime.call('config')).apiKey, undefined);
  assert.equal((await act('npm test')).effect, 'allow');
  const outOfScope = await act('git push');
  assert.equal(outOfScope.effect, 'block');
  assert.equal(outOfScope.category, 'scope');
  const clean = await runtime.scan({ session: 'root', context, tool: 'read', text: fixture('clean.md') });
  assert.equal(clean.effect, 'allow');
  const injected = await runtime.scan({ session: 'root', context, tool: 'read', text: fixture('injected.md') });
  assert.equal(injected.effect, 'block');
  assert.equal(injected.category, 'injection');
  assert.equal((await act('npm test')).effect, 'allow');
  const goalEscalation = await runtime.decide('root', { tool: 'bash', input: { command: 'git push' }, cwd: '/project' }, { ...context, goal: 'Commit and push the patch.' });
  assert.equal(goalEscalation.effect, 'block');
  const child = { userPrompts: [], goal: null, assignment: 'Push the patch as part of finishing.', runtimeId: 'e2e-root', agent: { kind: 'sub', id: 'Child', name: 'task', parentId: 'Main' } };
  assert.equal((await runtime.decide('child', { tool: 'bash', input: { command: 'git push' }, cwd: '/project' }, child)).category, 'scope');
  const missing = await runtime.decide('orphan', { tool: 'bash', input: { command: 'npm test' }, cwd: '/project' }, { ...child, runtimeId: 'other-process' });
  assert.equal(missing.effect, 'block');
  await runtime.call('clear', { session: 'root' });
  assert.equal((await runtime.call('session', { session: 'root' })).checks, 0);
  assert.equal((await runtime.decide('root', { tool: 'bash', input: { command: 'git push' }, cwd: '/project' }, context)).category, 'scope');
  providerMode = 'error';
  assert.equal((await act('npm test')).effect, 'block');
  providerMode = 'malformed';
  assert.equal((await runtime.scan({ session: 'root', context, tool: 'read', text: 'A response cannot be safely checked now.' })).effect, 'block');
  providerMode = 'normal';
  const customEndpoint = `http://127.0.0.1:${providerPort}/v1/chat/completions`;
  const switched = await runtime.call('config', { provider: 'custom', endpoint: customEndpoint, model: 'custom-decision-model' });
  assert.equal(switched.apiKeyConfigured, false);
  assert.equal((await act('npm test')).effect, 'block');
  await runtime.call('config', { apiKey: 'loopback-key' });
  assert.equal((await act('npm test')).effect, 'allow');
  assert.equal((await act('git push')).effect, 'block');
  assert.equal((await runtime.scan({ session: 'root', context, tool: 'read', text: fixture('injected.md') })).category, 'injection');
  await runtime.call('config', { maxInputChars: 1000 });
  assert.equal((await runtime.scan({ session: 'root', context, tool: 'read', text: 'x'.repeat(1200) })).effect, 'block');
  await runtime.call('config', { enabled: false });
  assert.deepEqual(await act('npm test'), { disabled: true });
  assert.equal((await runtime.call('config')).apiKey, undefined);
  assert.ok(counts.typesafe >= 8 && counts.custom >= 3);
  console.log(`e2e passed: in-process guard, native JEV protocol (${counts.typesafe} requests), custom chat-completions protocol (${counts.custom} requests), injection/scope gates, inherited restrictions, endpoint failures, key isolation`);
  console.log('Decision responses came from a deterministic loopback fixture; live model accuracy was not measured.');
} finally {
  await new Promise((resolve) => { provider.close(resolve); provider.closeAllConnections(); });
  rmSync(dir, { recursive: true, force: true });
}