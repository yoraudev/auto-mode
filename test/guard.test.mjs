import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGuard } from '../core/guard.mjs';

const context = (prompts = ['Fix the test failure. Do not commit or push.']) => ({ userPrompts: prompts, goal: null, agent: { kind: 'main', id: 'Main', name: 'main' } });
const request = { tool: 'bash', input: { command: 'npm test' }, cwd: '/project' };
const choice = (selected, options) => ({ type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? 1 : 0])) });
const safe = (kind) => ({ answers: { injection: choice('clean', ['clean', 'injection', 'uncertain']), ...(kind === 'action' ? { scope: choice('authorized', ['authorized', 'out_of_scope', 'uncertain']) } : {}) } });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});
const close = (server) => new Promise((resolve) => {
  server.close(resolve);
  server.closeAllConnections();
});

async function setup(t, respond = (body) => safe(body.state.kind)) {
  const dir = mkdtempSync(join(tmpdir(), 'auto-mode-guard-'));
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const result = await respond(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch {
      res.writeHead(500).end();
    }
  });
  const endpoint = `${await listen(provider)}/v1/systemone`;
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ provider: 'typesafe', endpoint, model: 'jev-latest', apiKey: 'test-secret' }));
  const guard = createGuard({ env: { AUTO_MODE_CONFIG: file } });
  t.after(async () => {
    await close(provider);
    rmSync(dir, { recursive: true, force: true });
  });
  return { guard };
}

test('a goal alone cannot authorize an action, including after clearing session checks', async (t) => {
  let calls = 0;
  const { guard } = await setup(t, (body) => { calls++; return safe(body.state.kind); });
  const goalOnly = { ...context([]), goal: 'Commit and push the changes.' };
  assert.equal((await guard.decide('s', request, goalOnly)).effect, 'block');
  guard.clear('s');
  const denied = await guard.decide('s', request);
  assert.equal(denied.effect, 'block');
  assert.equal(denied.category, 'uncertain');
  assert.equal(calls, 0);
});

test('an authorization change invalidates an in-flight allow decision', async (t) => {
  const entered = deferred();
  const release = deferred();
  const { guard } = await setup(t, async (body) => {
    entered.resolve();
    await release.promise;
    return safe(body.state.kind);
  });
  const pending = guard.decide('s', request, context());
  await entered.promise;
  guard.context({ session: 's', context: context(['Stop. Do not run any more commands.']) });
  release.resolve();
  const result = await pending;
  assert.equal(result.effect, 'block');
  assert.equal(result.category, 'uncertain');
  assert.match(result.reason, /changed/);
});

test('a preflight waits for output checks and includes only the permitted output', async (t) => {
  const entered = deferred();
  const release = deferred();
  const { guard } = await setup(t, async (body) => {
    if (body.state.kind === 'output') {
      entered.resolve();
      await release.promise;
      return safe('output');
    }
    const result = safe('action');
    if (!body.state.observations.some((item) => item.text === 'The failing assertion is in src/parser.js.')) {
      result.answers.scope = choice('uncertain', ['authorized', 'out_of_scope', 'uncertain']);
    }
    return result;
  });
  const output = guard.scan({ session: 's', context: context(), tool: 'read', text: 'The failing assertion is in src/parser.js.' });
  await entered.promise;
  const action = guard.decide('s', request, context());
  release.resolve();
  assert.equal((await output).effect, 'allow');
  assert.equal((await action).effect, 'allow');
});

test('a settings change invalidates clean output checked under the old endpoint configuration', async (t) => {
  const entered = deferred();
  const release = deferred();
  const { guard } = await setup(t, async () => {
    entered.resolve();
    await release.promise;
    return safe('output');
  });
  const pending = guard.scan({ session: 's', context: context(), tool: 'read', text: 'Text that has not yet been approved.' });
  await entered.promise;
  guard.setConfig({ minConfidence: 0.95 });
  release.resolve();
  const result = await pending;
  assert.equal(result.effect, 'block');
  assert.equal(result.category, 'uncertain');
});

test('public configuration and runtime errors never expose the saved credential', async (t) => {
  const { guard } = await setup(t);
  const settings = guard.config();
  assert.equal(settings.apiKeyConfigured, true);
  assert.equal(Object.hasOwn(settings, 'apiKey'), false);
  const saved = guard.setConfig({ apiKey: 'new-secret' });
  assert.equal(JSON.stringify(saved).includes('new-secret'), false);
  assert.equal(Object.hasOwn(saved, 'apiKey'), false);
  const invalid = guard.setConfig({ timeoutMs: 0 });
  assert.match(invalid.error, /between/);
  assert.equal(guard.config().enabled, true);
});

test('invalid actions and context cannot become authorized decisions', async (t) => {
  let calls = 0;
  const { guard } = await setup(t, (body) => { calls++; return safe(body.state.kind); });
  const omitted = await guard.decide('s', { tool: 'edit', cwd: '/project' }, context());
  assert.equal(omitted.effect, 'block');
  const missingContext = await guard.decide('missing', request);
  assert.equal(missingContext.effect, 'block');
  const malformed = await guard.context({ session: 's', context: { userPrompts: 'not-an-array' } });
  assert.equal(typeof malformed.error, 'string');
  assert.equal(calls, 0);
});

test('child grants cannot override current exact-parent restrictions or borrow a different Main session', async (t) => {
  const { guard } = await setup(t, (body) => {
    const result = safe('action');
    if (body.state.context.userPrompts.includes('Do not push.') && body.state.context.userPrompts.at(-1) !== 'Push now.') {
      result.answers.scope = choice('out_of_scope', ['authorized', 'out_of_scope', 'uncertain']);
    }
    return result;
  });
  const parent = { ...context(['Fix the parser.']), runtimeId: 'runtime', sessionFile: '/sessions/original.jsonl' };
  guard.context({ session: 'original', context: parent });
  const child = { ...context(['Push now.']), runtimeId: 'runtime', sessionFile: '/sessions/child.jsonl', parentSessionFile: '/sessions/original.jsonl', assignment: 'Push the patch.', goal: 'Push the patch.', agent: { kind: 'sub', id: 'Child', name: 'task', parentId: 'Main' } };
  guard.context({ session: 'child', context: child });
  guard.context({ session: 'original', context: { ...parent, userPrompts: ['Fix the parser.', 'Do not push.'] } });
  guard.context({ session: 'unrelated', context: { ...parent, userPrompts: ['Push this other project.'], sessionFile: '/sessions/other.jsonl' } });
  const result = await guard.decide('child', { ...request, input: { command: 'git push' } }, child);
  assert.equal(result.effect, 'block');
  assert.equal(result.category, 'scope');
  const orphan = await guard.decide('orphan', request, { ...child, runtimeId: 'other-runtime' });
  assert.equal(orphan.effect, 'block');
  assert.equal(orphan.category, 'uncertain');
});

test('a parent request change invalidates an in-flight child authorization', async (t) => {
  const entered = deferred();
  const release = deferred();
  const { guard } = await setup(t, async () => {
    entered.resolve();
    await release.promise;
    return safe('action');
  });
  const parent = { ...context(), runtimeId: 'runtime' };
  guard.context({ session: 'parent', context: parent });
  const child = { ...context([]), runtimeId: 'runtime', assignment: 'Run the tests.', agent: { kind: 'sub', id: 'Child', name: 'task', parentId: 'Main' } };
  const pending = guard.decide('child', request, child);
  await entered.promise;
  guard.context({ session: 'parent', context: { ...parent, userPrompts: ['Stop all work.'] } });
  release.resolve();
  assert.equal((await pending).effect, 'block');
});
