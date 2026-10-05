import type { HuggingFaceAccess } from '@merv/secrets/types';
import type { IncomingMessage } from 'node:http';
import type { Context } from 'cordis';
import { z } from 'zod';
import { MervError, pathSegment, type Caller } from '@merv/contracts';
import type { Api, ApiRequest, MountHandler } from '@merv/api/types';
import type { NativeMcpConnection } from './types.js';

/**
 * What Sessions' HTTP routes and credentials use of Sessions. Each body, and the enrollment's
 * selected project, is handed on as it came: Sessions parses and checks it.
 */
export interface SessionRoutes {
  authenticate(token: string): Promise<Caller>;
  authenticateManaged(token: string): Promise<Caller>;
  enrollManaged(
    token: string,
    input: unknown,
    projectId?: unknown,
  ): Promise<{ controlToken: string }>;
  registerAgent(caller: Caller, input: unknown): Promise<unknown>;
  agents(caller: Caller): Promise<unknown[]>;
  agent(caller: Caller, agentId: string): Promise<unknown>;
  agentObservation(caller: Caller, agentId: string): Promise<unknown>;
  retireAgent(caller: Caller, agentId: string): Promise<unknown>;
  rotateAgent(caller: Caller, agentId: string): Promise<unknown>;
  agentSelf(token: string): Promise<unknown>;
  assignAgent(token: string, input: unknown): Promise<unknown>;
  releaseAgentAssignment(token: string, executionId: string): Promise<unknown>;
  resetAgentContext(token: string, reason: string): Promise<unknown>;
  projectStatus(caller: Caller): Promise<unknown>;
  setDispatch(caller: Caller, input: unknown): Promise<unknown>;
  halt(caller: Caller, input: { sessionId?: string; reason?: string }): Promise<unknown>;
  lease(caller: Caller, input: unknown): Promise<unknown>;
  heartbeatRunner(caller: Caller, input: unknown): Promise<unknown>;
  setRunnerSettings(caller: Caller, input: unknown): Promise<unknown>;
  offer(caller: Caller, input: unknown): Promise<unknown>;
  list(caller: Caller): Promise<unknown[]>;
  get(caller: Caller, sessionId: string): Promise<unknown>;
  attach(caller: Caller, input: unknown): Promise<unknown>;
  launchConnections(
    caller: Caller,
    input: unknown,
  ): Promise<{ connections: NativeMcpConnection[] }>;
  huggingfaceAccess(caller: Caller, input: unknown): Promise<{ access: HuggingFaceAccess | null }>;
  huggingface(caller: Caller, input: unknown): Promise<{ hfToken: string | null }>;
  workspaceResult(caller: Caller, input: unknown): Promise<unknown>;
  transcript(caller: Caller, input: unknown): Promise<unknown>;
  heartbeat(caller: Caller, input: unknown): Promise<unknown>;
  release(caller: Caller, input: unknown): Promise<unknown>;
}
/** Runs a read-only route in a snapshot scope: no writer lock, writes refused. */
export type SnapshotRead = <T>(fn: () => Promise<T>) => Promise<T>;

const nonblank = z.string().trim().min(1).max(512);
// Sessions parses every other body. These two unwrap the one field a method takes, and a
// project halt refuses a body sessionId, which would halt one session and leave dispatch on.
const agentReleaseInput = z.object({ executionId: nonblank }).strict();
const agentResetInput = z.object({ reason: nonblank }).strict();
const haltInput = z.object({ reason: z.string().min(1).max(200).optional() }).strict();
const unknownEndpoint = () => new MervError('not_found', 'Unknown endpoint', 404);

/**
 * What a runner tells the worker it launches about the lease, sent with each attach: the runner
 * adds only what its harness and workspace give, then the frozen assignment.
 */
export const workerPrompt = [
  'You are the worker for one Merv workflow step. The following assignment is frozen for this lease.',
  'Use the Merv MCP tools to inspect the assigned work, perform it, and follow its handoff instruction.',
  'Tool arguments are constrained by the server. Stop when the handoff completes or the lease/revision is no longer valid.',
  'Continue the same assigned work after an interruption or a return. Read everything its context holds from earlier attempts, including the feedback on them; open anything omitted through the referenced records. Keep the commands you ran, their results and open questions as evidence. Work that waits for an operator is not yours to replace or fail.',
  // Workers read the assignment's tool list as the boundary of what they may look at and
  // then invent what the project already holds. The list binds writes; reads are open.
  'The tool list inside the assignment names the tools that carry your writes, bound to this work. Reading is not bounded that way: every read tool this server offers you works on anything in this project, whether or not the assignment names it.',
  'Look before you invent. If your work needs something the assignment does not fix — a script, a protocol, a configuration, a threshold, a model — first read whether the project has already fixed it, and use that. Say in your submission what you found and reused, and what you had to choose yourself and why.',
  'Before each handoff, read session.messages for this session and address every queued message. A new message may also appear as session_message_pending on any Merv tool call. Read it with session.messages, then call session.message.ack with a stable requestId and a concise reply about what you will do. Acknowledging a message changes nothing already submitted; a change it asks of submitted work goes through the workflow’s own actions, never quietly.',
].join('\n');

/** Managed supervisor bearers have no general project, tool or administration transport. */
const managedRoute = (method: string, path: string): boolean =>
  (method === 'POST' &&
    [
      '/sessions/runners/heartbeat',
      '/sessions/lease',
      '/code/commands/next',
      '/code/commands/complete',
    ].includes(path)) ||
  (method === 'GET' && /^\/sessions\/session_[A-Za-z0-9_]+$/.test(path)) ||
  (method === 'POST' &&
    /^\/sessions\/session_[A-Za-z0-9_]+\/(attach|heartbeat|release|workspace-result|transcript|huggingface|huggingface-access|launch-connections)$/.test(
      path,
    )) ||
  (method === 'POST' && /^\/code\/v2\/[A-Za-z0-9_/-]+$/.test(path)) ||
  (method === 'PUT' &&
    /^\/code\/v2\/uploads\/[A-Za-z0-9_]{1,80}\/parts\/(0|[1-9][0-9]{0,14})$/.test(path));

/** The path's identifier is bound over the body's. */
function bound(body: unknown, key: string, value: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  if (Object.hasOwn(body, key)) throw new MervError('invalid_input', `${key} is bound by the path`);
  return { ...body, [key]: value };
}

/** A continuing agent's own routes: matched first, so an unknown one costs no authentication,
 *  and its key is checked before any body is read. */
async function agentSelf(req: IncomingMessage, r: ApiRequest, sessions: SessionRoutes) {
  if ([...r.url.searchParams].length)
    throw new MervError('invalid_input', 'Agent routes do not accept query parameters');
  const action = r.url.pathname.slice('/sessions/self'.length);
  if (
    req.method === 'GET'
      ? action !== ''
      : req.method !== 'POST' || !['/assignment', '/release', '/context-reset'].includes(action)
  )
    throw new MervError('not_found', 'Unknown agent control route', 404);
  const token = r.bearer();
  const self = await sessions.agentSelf(token);
  if (req.method === 'GET') return self;
  if (action === '/assignment')
    return { execution: await sessions.assignAgent(token, await r.json()) };
  if (action === '/release')
    return {
      execution: await sessions.releaseAgentAssignment(
        token,
        (await r.json(agentReleaseInput)).executionId,
      ),
    };
  return {
    agent: await sessions.resetAgentContext(token, (await r.json(agentResetInput)).reason),
  };
}

/** The routes of a source credential or a managed runner: one read decision before any body;
 *  Sessions parses each body and authorizes each effect. */
async function controls(req: IncomingMessage, r: ApiRequest, sessions: SessionRoutes) {
  const path = r.url.pathname;
  const caller = await r.caller();
  if (path === '/sessions/agents') {
    if (req.method === 'GET') return { agents: await sessions.agents(caller) };
    if (req.method === 'POST')
      return { agent: await sessions.registerAgent(caller, await r.json()) };
  }
  const observationRoute = /^\/sessions\/agents\/([^/]+)\/observation$/.exec(path);
  if (observationRoute && req.method === 'GET')
    return await sessions.agentObservation(caller, pathSegment(observationRoute[1]!));
  const rotateAgentRoute = /^\/sessions\/agents\/([^/]+)\/rotate$/.exec(path);
  if (rotateAgentRoute && req.method === 'POST')
    return await sessions.rotateAgent(caller, pathSegment(rotateAgentRoute[1]!));
  const agentRoute = /^\/sessions\/agents\/([^/]+)$/.exec(path);
  if (agentRoute) {
    const agentId = pathSegment(agentRoute[1]!);
    if (req.method === 'GET') return await sessions.agent(caller, agentId);
    if (req.method === 'DELETE') return { agent: await sessions.retireAgent(caller, agentId) };
  }
  if (path === '/sessions/status' && req.method === 'GET')
    return await sessions.projectStatus(caller);
  if (path === '/sessions/dispatch' && req.method === 'PUT')
    return { dispatch: await sessions.setDispatch(caller, await r.json()) };
  if (path === '/sessions/halt' && req.method === 'POST')
    return await sessions.halt(caller, await r.json(haltInput));
  if (path === '/sessions/lease' && req.method === 'POST')
    return await sessions.lease(caller, await r.json());
  if (path === '/sessions/runners/heartbeat' && req.method === 'POST')
    return { runner: await sessions.heartbeatRunner(caller, await r.json()) };
  const settingsRoute = /^\/sessions\/runners\/([^/]+)\/settings$/.exec(path);
  if (settingsRoute && req.method === 'PUT') {
    const body = bound(await r.json(), 'runnerId', pathSegment(settingsRoute[1]!));
    return { runner: await sessions.setRunnerSettings(caller, body) };
  }
  if (path === '/sessions' && req.method === 'GET')
    return { sessions: await sessions.list(caller) };
  if (path === '/sessions/offer' && req.method === 'POST')
    return { session: await sessions.offer(caller, await r.json()) };
  const route =
    /^\/sessions\/(session_[^/]+)(?:\/(attach|heartbeat|release|halt|workspace-result|transcript|huggingface|huggingface-access|launch-connections))?$/.exec(
      path,
    );
  if (route) {
    const sessionId = pathSegment(route[1]!);
    if (!route[2] && req.method === 'GET')
      return { session: await sessions.get(caller, sessionId) };
    if (req.method === 'POST' && route[2] === 'halt')
      return await sessions.halt(caller, { ...(await r.json(haltInput)), sessionId });
    if (
      req.method === 'POST' &&
      (route[2] === 'huggingface' || route[2] === 'huggingface-access')
    ) {
      if (!caller.managed)
        throw new MervError('managed_runner_forbidden', 'Managed runner authority required', 403);
      return await sessions[route[2] === 'huggingface' ? 'huggingface' : 'huggingfaceAccess'](
        caller,
        bound(await r.json(undefined, 4096), 'sessionId', sessionId),
      );
    }
    if (req.method === 'POST' && route[2] === 'launch-connections')
      return await sessions.launchConnections(
        caller,
        bound(await r.json(undefined, 4096), 'sessionId', sessionId),
      );
    if (req.method === 'POST' && route[2] === 'transcript') {
      const input = bound(await r.json(undefined, 4096), 'sessionId', sessionId);
      return { transcript: await sessions.transcript(caller, input) };
    }
    if (req.method === 'POST' && route[2]) {
      const input = bound(await r.json(), 'sessionId', sessionId);
      const session =
        route[2] === 'attach'
          ? await sessions.attach(caller, input)
          : route[2] === 'workspace-result'
            ? await sessions.workspaceResult(caller, input)
            : route[2] === 'heartbeat'
              ? await sessions.heartbeat(caller, input)
              : await sessions.release(caller, input);
      // Runners released before the unconditional call ask for launch connections only when
      // attach says so; self-hosted ones may still be running.
      return {
        session,
        ...(route[2] === 'attach' ? { launchConnections: true, prompt: workerPrompt } : {}),
      };
    }
  }
  throw unknownEndpoint();
}

/** `/sessions`: an agent's own routes and runner enrollment authenticate themselves; every other
 *  route is a source credential's or a managed runner's. */
function sessionRoutes(sessions: SessionRoutes, read: SnapshotRead): MountHandler {
  return async (req, res, r) => {
    const path = r.url.pathname;
    if (
      path.endsWith('/huggingface') ||
      path.endsWith('/huggingface-access') ||
      path.endsWith('/launch-connections')
    )
      res.setHeader('Cache-Control', 'no-store');
    if (!r.principal) {
      if (path === '/sessions/self' || path.startsWith('/sessions/self/'))
        return await agentSelf(req, r, sessions);
      if (path !== '/sessions/runners/enroll' || req.method !== 'POST' || r.url.search)
        throw unknownEndpoint();
      const token = r.bearer();
      // Only an enrollment credential enrolls; any other is refused before its body is read.
      if (!/^me_[0-9a-f]{64}$/.test(token))
        throw new MervError('unauthorized', 'Invalid managed enrollment', 401);
      const body = await r.json(undefined, 4096);
      const enrolled = await sessions.enrollManaged(token, body, req.headers['x-merv-project-id']);
      return { controlToken: enrolled.controlToken };
    }
    if ([...r.url.searchParams].length)
      throw new MervError('invalid_input', 'Session routes do not accept query parameters');
    return req.method === 'GET'
      ? await read(() => controls(req, r, sessions))
      : await controls(req, r, sessions);
  };
}

/**
 * Registers Sessions' three credentials and mounts `/sessions`; the disposer withdraws them all,
 * after which their bearers and routes answer 503. A session credential (`ms_`) uses only
 * POST /mcp, a managed runner (`mr_`) only its control routes, and an enrollment credential
 * (`me_`) only enrollment, which authenticates it itself.
 */
export function mountSessions(
  api: Pick<Api, 'mount' | 'credential'>,
  sessions: SessionRoutes,
  read: SnapshotRead = (fn) => fn(),
): () => void {
  const registrations = [
    () =>
      api.credential('ms_', {
        kind: 'session',
        forbidden: new MervError(
          'session_transport_forbidden',
          'Session credentials may only use POST /mcp',
          403,
        ),
        routes: (method, path) => method === 'POST' && path === '/mcp',
        authenticate: (token) => sessions.authenticate(token),
      }),
    () =>
      api.credential('mr_', {
        kind: 'managed',
        forbidden: new MervError(
          'managed_runner_forbidden',
          'Managed runner route is not allowed',
          403,
        ),
        routes: (method, path, query) => !query && managedRoute(method, path),
        authenticate: (token) => sessions.authenticateManaged(token),
      }),
    () =>
      api.credential('me_', {
        kind: 'enrollment',
        forbidden: new MervError(
          'managed_runner_forbidden',
          'Enrollment credentials may only enroll a runner',
          403,
        ),
        routes: () => false,
      }),
    () =>
      api.mount('/sessions', sessionRoutes(sessions, read), {
        public: ['/sessions/self', '/sessions/runners/enroll'],
      }),
  ];
  const disposers: (() => void)[] = [];
  const dispose = () => {
    for (const disposer of disposers.splice(0)) disposer();
  };
  try {
    for (const register of registrations) disposers.push(register());
  } catch (error) {
    // A conflict leaves nothing of this registration behind.
    dispose();
    throw error;
  }
  return dispose;
}

export const sessionsApiPlugin = {
  name: 'merv-sessions-api',
  inject: ['sessions', 'api'],
  apply(ctx: Context) {
    // GET routes read in a snapshot scope of the store Sessions keeps its rows in.
    const read: SnapshotRead = (fn) => {
      const state = ctx.get('state');
      return state ? state.snapshot(fn) : fn();
    };
    ctx.effect(() => mountSessions(ctx.api, ctx.sessions, read));
  },
};
export default sessionsApiPlugin;
