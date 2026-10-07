import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from 'cordis';
import { z } from 'zod';
import { check, MervError, pathSegment } from '@merv/contracts';
import { serveEvents } from '@merv/api/event-stream';
import type { Api, ApiRequest, MountHandler } from '@merv/api/types';
import type { Session, Sessions } from './types.js';
import { unknownEndpoint } from '@merv/api/errors';

/**
 * What Sessions' HTTP routes and credentials use of Sessions. Each body, and the enrollment's
 * selected project, is handed on as it came: Sessions parses and checks it.
 */
export type SessionRoutes = Pick<
  Sessions,
  | 'authenticate'
  | 'managed'
  | 'observations'
  | 'threads'
  | 'messaging'
  | 'inquiries'
  | 'dispatch'
  | 'offer'
  | 'list'
  | 'get'
  | 'control'
  | 'attach'
  | 'launchConnections'
  | 'huggingfaceAccess'
  | 'workspaceResult'
  | 'transcript'
  | 'streams'
  | 'conversation'
  | 'resume'
  | 'heartbeat'
  | 'release'
>;
/** Runs a read-only route in a snapshot scope: no writer lock, writes refused. */
type SnapshotRead = <T>(fn: () => Promise<T>) => Promise<T>;

// Sessions parses every other body. A project halt refuses a body sessionId, which would halt
// one session and leave dispatch on.
const haltInput = z.object({ reason: z.string().min(1).max(200).optional() }).strict();
const messageInput = z
  .object({ body: z.string().min(1).max(8000), requestId: z.string().min(1).max(200) })
  .strict();

/**
 * What a runner tells the worker it launches about the lease, sent with each attach: the runner
 * adds only what its harness and workspace give, then the frozen assignment. Only a visit that
 * keeps a conversation is told it may ask its owner: no later visit would continue another's.
 */
export const workerPrompt = (session: Pick<Session, 'continuity' | 'inquiry'>) =>
  session.inquiry
    ? inquiryPrompt(session.inquiry.messageId)
    : [
        'You are the worker for one Merv workflow step. The following assignment is frozen for this lease.',
        'Use the Merv MCP tools to inspect the assigned work, perform it, and follow its handoff instruction.',
        'Tool arguments are constrained by the server. Stop when the handoff completes or the lease/revision is no longer valid.',
        'Continue the same assigned work after an interruption or a return. Read everything its context holds from earlier attempts, including the feedback on them; open anything omitted through the referenced records. Keep the commands you ran, their results and open questions as evidence. Work that waits for an operator is not yours to replace or fail.',
        // Workers read the assignment's tool list as the boundary of what they may look at and
        // then invent what the project already holds. The list binds writes; reads are open.
        'The tool list inside the assignment names the tools that carry your writes, bound to this work. Reading is not bounded that way: every read tool this server offers you works on anything in this project, whether or not the assignment names it.',
        'Look before you invent. If your work needs something the assignment does not fix — a script, a protocol, a configuration, a threshold, a model — first read whether the project has already fixed it, and use that. Say in your submission what you found and reused, and what you had to choose yourself and why.',
        ...(session.continuity
          ? [
              'If the work cannot go on without the owner’s decision and no tool can settle it, call session.ask_owner with one self-contained question and stop: your visit ends, the work waits for the answer, and it comes back to you in this conversation with the answer as a queued message.',
            ]
          : []),
        'Before each handoff, read session.messages for this session and address every queued message. A new message may also appear as session_message_pending on any Merv tool call. Read it with session.messages, then call session.message.ack with a stable requestId and a concise reply about what you will do. Acknowledging a message changes nothing already submitted; a change it asks of submitted work goes through the workflow’s own actions, never quietly.',
      ].join('\n');
/** What an inquiry visit is told instead, the one place that says what an inquiry is: its
 *  assignment carries only the question. */
const inquiryPrompt = (messageId: string) =>
  [
    'A person over this project is asking you a question about your earlier work in this conversation: an inquiry visit, not a work visit. The frozen assignment below carries the question.',
    'Nothing you do here is part of your work: you hold no lease on it. Use only the Merv read tools to check anything you need, and make no workflow moves, commits or writes. This conversation is not kept for your work; your next work visit is told of the question and your answer.',
    `Answer once, plainly and from what you know, with session.message.ack {messageId: "${messageId}", reply, requestId}. That reply is the answer the person reads, and it ends this visit: stop after it.`,
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
  (method === 'GET' && /^\/sessions\/session_[A-Za-z0-9_]+(\/control)?$/.test(path)) ||
  (method === 'POST' &&
    /^\/sessions\/session_[A-Za-z0-9_]+\/(attach|heartbeat|release|workspace-result|transcript|stream|conversation|resume|huggingface-access|launch-connections)$/.test(
      path,
    )) ||
  (method === 'POST' && /^\/code\/v2\/[A-Za-z0-9_/-]+$/.test(path)) ||
  (method === 'PUT' &&
    /^\/code\/v2\/uploads\/[A-Za-z0-9_]{1,80}\/parts\/(0|[1-9][0-9]{0,14})$/.test(path));

/** The path's identifier is bound over the body's. The result is typed as the input of the method
 *  it is handed to (`never` fits any), unchecked: Sessions parses and checks each body. */
function bound<T = never>(body: unknown, key: string, value: string): T {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body as T;
  if (Object.hasOwn(body, key)) throw new MervError('invalid_input', `${key} is bound by the path`);
  return { ...body, [key]: value } as T;
}

/** The routes of a source credential or a managed runner: one read decision before any body;
 *  Sessions parses each body and authorizes each effect. */
async function controls(req: IncomingMessage, r: ApiRequest, sessions: SessionRoutes) {
  const path = r.url.pathname;
  const caller = await r.caller();
  const callsRoute = /^\/sessions\/threads\/([^/]+)\/calls$/.exec(path);
  if (callsRoute && req.method === 'GET')
    return await sessions.observations.calls(caller, pathSegment(callsRoute[1]!));
  const conversationRoute = /^\/sessions\/threads\/([^/]+)\/conversation$/.exec(path);
  if (conversationRoute && req.method === 'GET')
    return await sessions.threads.conversation(caller, pathSegment(conversationRoute[1]!));
  // A thread's messages and questions; a person's message to it, which answers its questions.
  // A person's question to the thread's agent, answered by a read-only inquiry visit.
  const askRoute = /^\/sessions\/threads\/([^/]+)\/ask$/.exec(path);
  if (askRoute && req.method === 'POST')
    return {
      inquiry: await sessions.inquiries.ask(
        caller,
        bound(await r.json(messageInput), 'threadId', pathSegment(askRoute[1]!)),
      ),
    };
  const messagesRoute = /^\/sessions\/threads\/([^/]+)\/messages$/.exec(path);
  if (messagesRoute && req.method === 'GET')
    return await sessions.messaging.thread(caller, pathSegment(messagesRoute[1]!));
  if (messagesRoute && req.method === 'POST')
    return {
      message: await sessions.messaging.message(
        caller,
        bound(await r.json(messageInput), 'threadId', pathSegment(messagesRoute[1]!)),
      ),
    };
  if (path === '/sessions/status' && req.method === 'GET')
    return await sessions.dispatch.projectStatus(caller);
  if (path === '/sessions/dispatch' && req.method === 'PUT')
    return { dispatch: await sessions.dispatch.setDispatch(caller, await r.json()) };
  if (path === '/sessions/halt' && req.method === 'POST')
    return await sessions.dispatch.halt(caller, await r.json(haltInput));
  if (path === '/sessions/lease' && req.method === 'POST')
    return await sessions.dispatch.lease(caller, await r.json());
  if (path === '/sessions/runners/heartbeat' && req.method === 'POST')
    return { runner: await sessions.dispatch.heartbeatRunner(caller, await r.json()) };
  const settingsRoute = /^\/sessions\/runners\/([^/]+)\/settings$/.exec(path);
  if (settingsRoute && req.method === 'PUT') {
    const body = bound(await r.json(), 'runnerId', pathSegment(settingsRoute[1]!));
    return { runner: await sessions.dispatch.setRunnerSettings(caller, body) };
  }
  if (path === '/sessions' && req.method === 'GET')
    return { sessions: await sessions.list(caller) };
  if (path === '/sessions/offer' && req.method === 'POST')
    return { session: await sessions.offer(caller, await r.json()) };
  const route =
    /^\/sessions\/(session_[^/]+)(?:\/(control|attach|heartbeat|release|halt|workspace-result|transcript|stream|conversation|resume|huggingface-access|launch-connections))?$/.exec(
      path,
    );
  if (route) {
    const sessionId = pathSegment(route[1]!);
    if (!route[2] && req.method === 'GET')
      return { session: await sessions.get(caller, sessionId) };
    // What a runner's tick polls: the control fields alone, never the assignment.
    if (route[2] === 'control' && req.method === 'GET')
      return { control: await sessions.control(caller, sessionId) };
    if (req.method === 'POST' && route[2] === 'halt')
      return await sessions.dispatch.halt(caller, { ...(await r.json(haltInput)), sessionId });
    if (req.method === 'POST' && route[2] === 'huggingface-access') {
      if (!caller.managed)
        throw new MervError('managed_runner_forbidden', 'Managed runner authority required', 403);
      return await sessions.huggingfaceAccess(
        caller,
        bound(await r.json(undefined, 4096), 'sessionId', sessionId),
      );
    }
    if (req.method === 'POST' && route[2] === 'launch-connections')
      return await sessions.launchConnections(
        caller,
        bound(await r.json(undefined, 4096), 'sessionId', sessionId),
      );
    if (req.method === 'POST' && route[2] === 'stream') {
      // A runner's batch is under a megabyte; this leaves it room.
      const input = bound(await r.json(undefined, 2 << 20), 'sessionId', sessionId);
      return { stream: await sessions.streams.append(caller, input) };
    }
    if (req.method === 'POST' && route[2] === 'transcript') {
      const input = bound(await r.json(undefined, 4096), 'sessionId', sessionId);
      return { transcript: await sessions.transcript(caller, input) };
    }
    if (req.method === 'POST' && route[2] === 'conversation') {
      const input = bound(await r.json(undefined, 4096), 'sessionId', sessionId);
      return { conversation: await sessions.conversation(caller, input) };
    }
    if (req.method === 'POST' && route[2] === 'resume')
      return {
        download: await sessions.resume(
          caller,
          bound(await r.json(undefined, 4096), 'sessionId', sessionId),
        ),
      };
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
        ...(route[2] === 'attach'
          ? { launchConnections: true, prompt: workerPrompt(session) }
          : {}),
      };
    }
  }
  throw unknownEndpoint();
}

/** The newest events a page is sent first; a reader further behind than this starts over. */
const SNAPSHOT = 500;
/**
 * `GET /sessions/<id>/events[?after=<seq>]`: one worker agent's live stream for an operator's
 * page, as server-sent events. `snapshot` carries the newest events (the page starts over),
 * `events` what followed, `rotate` asks the page to reconnect with `after` set to the last seq it
 * holds, and `end` says the stream will not grow. Authority is read once per connection, which
 * rotates every 20 seconds; whether the stream still grows, at most once a second.
 */
async function agentEvents(
  req: IncomingMessage,
  res: ServerResponse,
  r: ApiRequest,
  sessionId: string,
  streams: Sessions['streams'],
): Promise<void> {
  const after = r.url.searchParams.get('after');
  check(
    [...r.url.searchParams.keys()].every((key) => key === 'after') &&
      r.url.searchParams.getAll('after').length <= 1 &&
      (after === null || /^(0|[1-9][0-9]{0,14})$/.test(after)),
    'invalid_input',
    'The events route takes only after=<seq>',
  );
  let seq = after === null ? -1 : Number(after);
  const caller = await r.caller();
  await streams.authorize(caller);
  let growing = await streams.growing(sessionId, caller.projectId);
  let read = Date.now();
  await serveEvents(req, res, {
    rotateMs: 20_000,
    subscribe: (wake) => streams.subscribe(sessionId, wake),
    step: async (send) => {
      if (Date.now() - read >= 1000) {
        growing = await streams.growing(sessionId, caller.projectId);
        read = Date.now();
      }
      const events = seq < 0 ? [] : await streams.after(sessionId, seq, SNAPSHOT + 1);
      if (seq < 0 || events.length > SNAPSHOT) {
        const snapshot = await streams.snapshot(sessionId);
        await send('snapshot', { events: snapshot });
        seq = snapshot.at(-1)?.seq ?? 0;
      } else if (events.length) {
        await send('events', { events });
        seq = events.at(-1)!.seq;
      }
      // Read after its authority said it would not grow: the page holds all there will be.
      if (growing) return;
      await send('end', {});
      return false;
    },
  });
}

/**
 * `GET /sessions/live`: the project's live feed for an operator's Agents page, one connection
 * for every live visit, as server-sent events. `snapshot` carries each live visit's newest
 * events (the page starts over), `tail` what changed since (LiveFeedFrame), and `rotate` asks the
 * page to reconnect, which starts over. Authority is read once per connection, which rotates
 * every 20 seconds; a batch this process takes wakes it, and it reads again every 2 seconds.
 */
async function liveFeed(
  req: IncomingMessage,
  res: ServerResponse,
  r: ApiRequest,
  streams: Sessions['streams'],
): Promise<void> {
  check(!r.url.search, 'invalid_input', 'The live feed takes no query');
  const caller = await r.caller();
  await streams.authorize(caller);
  const held = new Map<string, number>();
  let first = true;
  await serveEvents(req, res, {
    rotateMs: 20_000,
    subscribe: (wake) => streams.subscribeFeed(caller.projectId, wake),
    step: async (send) => {
      const frame = await streams.feed(caller.projectId, held);
      if (first) await send('snapshot', frame ?? { live: [], visits: [] });
      else if (frame) await send('tail', frame);
      first = false;
    },
  });
}

/** `/sessions`: runner enrollment authenticates itself; every other route is a source
 *  credential's or a managed runner's. */
function sessionRoutes(sessions: SessionRoutes, read: SnapshotRead): MountHandler {
  return async (req, res, r) => {
    const path = r.url.pathname;
    if (
      path.endsWith('/huggingface-access') ||
      path.endsWith('/resume') ||
      path.endsWith('/launch-connections')
    )
      res.setHeader('Cache-Control', 'no-store');
    if (!r.principal) {
      if (path !== '/sessions/runners/enroll' || req.method !== 'POST' || r.url.search)
        throw unknownEndpoint();
      const token = r.bearer();
      // Only an enrollment credential enrolls; any other is refused before its body is read.
      if (!/^me_[0-9a-f]{64}$/.test(token))
        throw new MervError('unauthorized', 'Invalid managed enrollment', 401);
      const body = await r.json(undefined, 4096);
      const enrolled = await sessions.managed.enroll(token, body, req.headers['x-merv-project-id']);
      return { controlToken: enrolled.controlToken };
    }
    if (path === '/sessions/live' && req.method === 'GET')
      return await liveFeed(req, res, r, sessions.streams);
    const events = /^\/sessions\/(session_[^/]+)\/events$/.exec(path);
    if (events && req.method === 'GET')
      return await agentEvents(req, res, r, pathSegment(events[1]!), sessions.streams);
    // The threads of work items by instanceId, one or more (a wave and its lenses are read at
    // once); else the project's, a page older than `before`.
    if (path === '/sessions/threads' && req.method === 'GET') {
      const query = [...r.url.searchParams.keys()];
      check(
        query.every((key) => key === 'instanceId') || (query.length === 1 && query[0] === 'before'),
        'invalid_input',
        'The threads route takes instanceId=<id> (repeated for several), before=<cursor> or nothing',
      );
      const instanceIds = r.url.searchParams.getAll('instanceId');
      const before = r.url.searchParams.get('before') ?? undefined;
      const caller = await r.caller();
      return instanceIds.length
        ? { threads: await read(() => sessions.threads.list(caller, instanceIds)) }
        : await read(() => sessions.threads.project(caller, before));
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
        authenticate: (token) => sessions.managed.authenticate(token),
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
        public: ['/sessions/runners/enroll'],
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
