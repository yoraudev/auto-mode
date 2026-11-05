import { resolve } from 'node:path';
import { loadConfig, publicConfig, saveConfig, validate } from './config.mjs';
import { evaluate } from './decision.mjs';

const MAX_SESSIONS = 500;
const MAX_OBSERVATIONS = 8;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const block = (reason, category = 'uncertain') => ({ effect: 'block', category, reason, confidence: null });
const unavailable = () => block('The remote decision provider is unavailable or returned an invalid response.', 'unavailable');
const categories = new Set(['safe', 'injection', 'scope', 'uncertain', 'unavailable']);
const validDecision = (value) => value && (value.effect === 'allow' || value.effect === 'block') && categories.has(value.category) && typeof value.reason === 'string' && (value.confidence === null || (Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1)) && (value.effect !== 'allow' || (value.category === 'safe' && value.confidence !== null));

function validContext(value) {
  return object(value)
    && Array.isArray(value.userPrompts)
    && value.userPrompts.every((prompt) => typeof prompt === 'string')
    && (value.delegatedUserPrompts === undefined || (Array.isArray(value.delegatedUserPrompts)
      && value.delegatedUserPrompts.every((group) => Array.isArray(group) && group.every((prompt) => typeof prompt === 'string'))))
    && (value.goal === null || typeof value.goal === 'string')
    && (value.runtimeId === undefined || typeof value.runtimeId === 'string')
    && (value.assignment === undefined || value.assignment === null || typeof value.assignment === 'string')
    && (value.sessionFile === undefined || value.sessionFile === null || typeof value.sessionFile === 'string')
    && (value.parentSessionFile === undefined || value.parentSessionFile === null || typeof value.parentSessionFile === 'string')
    && (value.agent === null || (object(value.agent)
      && ['main', 'sub'].includes(value.agent.kind)
      && typeof value.agent.id === 'string'
      && typeof value.agent.name === 'string'
      && (value.agent.parentId === undefined || typeof value.agent.parentId === 'string')));
}

export function createGuard({ env = process.env, log = () => {}, evaluate: evaluateDecision = evaluate } = {}) {
  let config = loadConfig(env, log);
  let generation = 0;
  const sessions = new Map();
  const agents = new Map();
  const files = new Map();
  const agentKey = (context) => context.runtimeId && context.agent ? `${context.runtimeId}:${context.agent.id}` : null;
  const fileKey = (runtimeId, file) => {
    if (!runtimeId || !file) return null;
    const path = resolve(file).replaceAll('\\', '/');
    return `${runtimeId}:${process.platform === 'win32' ? path.toLowerCase() : path}`;
  };
  const forget = (id, session) => {
    sessions.delete(id);
    for (const [key, value] of agents) if (value === session) agents.delete(key);
    for (const [key, value] of files) if (value === session) files.delete(key);
  };
  const sessionOf = (id) => {
    if (typeof id !== 'string' || !id.trim() || id.length > 256) return undefined;
    let session = sessions.get(id);
    if (!session) {
      for (const [key, candidate] of sessions) {
        if (sessions.size < MAX_SESSIONS) break;
        if (!candidate.inflight) forget(key, candidate);
      }
      if (sessions.size >= MAX_SESSIONS) return undefined;
      session = { id, context: null, contextKey: '', version: 0, observations: [], observed: 0, pending: new Set(), inflight: 0, checks: 0, blocked: 0 };
    }
    sessions.delete(id);
    sessions.set(id, session);
    return session;
  };
  const updateContext = (session, context) => {
    if (!validContext(context)) return false;
    const key = JSON.stringify(context);
    if (session.contextKey !== key) {
      if (session.context) {
        const oldIdentity = agentKey(session.context);
        const oldFile = fileKey(session.context.runtimeId, session.context.sessionFile);
        if (oldIdentity && oldIdentity !== agentKey(context) && agents.get(oldIdentity) === session) agents.delete(oldIdentity);
        if (oldFile && oldFile !== fileKey(context.runtimeId, context.sessionFile) && files.get(oldFile) === session) files.delete(oldFile);
        if (session.context.runtimeId !== context.runtimeId || session.context.agent?.parentId !== context.agent?.parentId
          || session.context.parentSessionFile !== context.parentSessionFile) session.parent = undefined;
      }
      session.context = context;
      session.contextKey = key;
      session.version++;
      session.observations = [];
      session.observed++;
    }
    const identity = agentKey(context);
    if (identity) agents.set(identity, session);
    const file = fileKey(context.runtimeId, context.sessionFile);
    if (file) files.set(file, session);
    return true;
  };
  const authorizationOf = (session) => {
    const lineage = [];
    let current = session;
    while (current) {
      if (!current.context || lineage.includes(current) || lineage.length >= 16 || sessions.get(current.id) !== current) return undefined;
      lineage.push(current);
      const context = current.context;
      if (context.agent?.kind !== 'sub') break;
      if (!context.runtimeId || !context.agent.parentId) return undefined;
      const parentFile = fileKey(context.runtimeId, context.parentSessionFile);
      const parent = parentFile
        ? files.get(parentFile)
        : current.parent ?? agents.get(`${context.runtimeId}:${context.agent.parentId}`);
      if (!parent || parent.context?.agent?.id !== context.agent.parentId || parent.context.runtimeId !== context.runtimeId) return undefined;
      current.parent = parent;
      current = parent;
    }
    lineage.reverse();
    return {
      context: {
        ...session.context,
        userPrompts: lineage[0].context.userPrompts,
        delegatedUserPrompts: lineage.slice(1).map((item) => item.context.userPrompts),
        goal: [...lineage].reverse().find((item) => item.context.goal)?.context.goal ?? null,
        assignment: lineage.map((item) => item.context.assignment).filter(Boolean).join('\n\n') || null,
      },
      lineage: lineage.map((item) => ({ session: item, version: item.version })),
    };
  };
  const view = (session) => ({ checks: session?.checks ?? 0, blocked: session?.blocked ?? 0, lastDecision: session?.lastDecision });
  const remember = (session, decision, kind) => {
    session.checks++;
    if (decision.effect === 'block') session.blocked++;
    session.lastDecision = decision;
    log(`${kind} -> ${decision.effect} (${decision.category})`);
    return decision;
  };
  const assess = async (body, kind) => {
    if (!config.enabled) return { disabled: true };
    const session = sessionOf(body.session);
    if (!session) return block('A valid session is required, or the session capacity has been reached.');
    if (body.context !== undefined && !updateContext(session, body.context)) return remember(session, block('The user authorization context is invalid.'), kind);
    if (!session.context) return remember(session, block('The user authorization context is missing.'), kind);
    const authorization = authorizationOf(session);
    if (!authorization) return remember(session, block('The parent session authorization could not be verified.'), kind);
    if (kind === 'action' && !authorization.context.userPrompts.some((prompt) => prompt.trim())) {
      return remember(session, block('No direct user request is available. A goal or assistant plan cannot authorize this action.'), kind);
    }
    if (kind === 'action' && (!object(body.request) || typeof body.request.tool !== 'string' || !body.request.tool.trim()
      || !object(body.request.input) || typeof body.request.cwd !== 'string')) {
      return remember(session, block('The complete tool name, raw input, and working directory are required.'), kind);
    }
    if (kind === 'output' && (typeof body.tool !== 'string' || !body.tool.trim() || typeof body.text !== 'string')) {
      return remember(session, block('The complete tool name and output text are required.'), kind);
    }
    const staleAuthorization = () => authorization.lineage.some((item) => item.version !== item.session.version || sessions.get(item.session.id) !== item.session);
    const settingsRevision = generation;
    session.inflight++;
    const run = async () => {
      if (kind === 'action') await Promise.all([...session.pending]);
      if (staleAuthorization() || settingsRevision !== generation) return block('The authorization context or settings changed during this check. Retry under the current request.');
      const observed = session.observed;
      const input = {
        kind,
        context: authorization.context,
        ...(kind === 'action' ? { request: body.request, observations: [...session.observations] } : { output: { tool: body.tool, text: body.text } }),
      };
      let decision;
      try {
        decision = await evaluateDecision({ ...config }, input);
        if (!validDecision(decision)) decision = unavailable();
      } catch {
        decision = unavailable();
      }
      if (staleAuthorization() || settingsRevision !== generation || (kind === 'action' && observed !== session.observed)) {
        return block('The authorization context, tool observations, or settings changed during this check. Retry under the current request.');
      }
      if (kind === 'output' && decision.effect === 'allow') {
        session.observations.push({ tool: body.tool, text: body.text });
        let chars = session.observations.reduce((count, item) => count + item.text.length, 0);
        while (session.observations.length > MAX_OBSERVATIONS || chars > config.maxInputChars) {
          chars -= session.observations.shift().text.length;
        }
        session.observed++;
      }
      return decision;
    };
    const job = run();
    if (kind === 'output') session.pending.add(job);
    try {
      return remember(session, await job, kind);
    } finally {
      session.pending.delete(job);
      session.inflight--;
    }
  };
  return {
    config: () => publicConfig(config),
    setConfig: (patch) => {
      const problem = validate(patch, config);
      if (problem) return { error: problem };
      try {
        config = saveConfig(patch, env, config);
        generation++;
        log('settings changed');
        return publicConfig(config);
      } catch (error) {
        return { error: error.message };
      }
    },
    context: ({ session: id, context }) => {
      const session = sessionOf(id);
      if (!session || !updateContext(session, context)) return { error: 'A valid session and user authorization context are required.' };
      return { ok: true };
    },
    decide: (session, request, context) => assess({ session, request, context }, 'action'),
    scan: (body) => assess(body, 'output'),
    session: (id) => view(sessions.get(id)),
    clear: (id) => {
      const session = sessionOf(id);
      if (!session) return { error: 'A valid session is required.' };
      session.version++;
      session.observations = [];
      session.observed++;
      session.checks = 0;
      session.blocked = 0;
      session.lastDecision = undefined;
      return view(session);
    },
  };
}
