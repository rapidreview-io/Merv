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
/** A session's own lease controls, whose bodies take the server's limit. */
const leaseControls = new Set(['attach', 'workspace-result', 'heartbeat', 'release']);

/**
 * What a runner tells the worker it launches about the lease, sent with each attach: the runner
 * adds only what its harness and workspace give, then the frozen assignment. Only a visit that
 * keeps a conversation is told it may ask its owner: no later visit would continue another's.
 */
export const workerPrompt = (session: Session) =>
  session.kind === 'inquiry'
    ? inquiryPrompt(session.inquiry.messageId)
    : [
        'You are the worker for one Merv workflow step. The following assignment is frozen for this lease.',
        'Use the Merv MCP tools to inspect the assigned work, perform it, and follow its handoff instruction.',
        'Tool arguments are constrained by the server. Stop when the handoff completes or the lease/revision is no longer valid.',
        // A visit supervising long remote work was closed mid-turn at a deadline it never saw,
        // and its successor rebuilt what it knew: the deadline is said, with what to keep.
        `This visit's lease ends at ${session.hardDeadline}, ${leaseMinutes(session)} minutes after it was offered. Merv then closes the visit, mid-turn if need be, and a remote job still running does not extend it. Long work outlives a visit: as you go, keep in the project what the next visit needs to go on (the ids of jobs and workflows still running, checkpoints, what is left)${session.continuity ? '; the next visit continues this conversation.' : '; the next visit starts afresh from those records.'}`,
        'Continue the same assigned work after an interruption or a return. Read everything its context holds from earlier attempts, including the feedback on them; open anything omitted through the referenced records. Keep the commands you ran, their results and open questions as evidence. Work that waits for an operator is not yours to replace or fail.',
        // A successor resumed a conversation ten hours old as though it were the latest, and
        // rebuilt from the machine what the visit whose conversation never arrived had done.
        ...(session.continuity?.resume?.missed
          ? [missedVisits(session.continuity.resume.missed)]
          : []),
        // Agents blocked on a person ended their turn and were re-offered the same work, again
        // and again: a stop is no way to wait, so they are told what it does and what does wait.
        `Do not end your turn without the handoff${session.continuity ? ' or session.ask_owner' : ''}. Merv counts a visit that just stops as a failed launch: it offers the same work again within a minute with nothing changed, and holds it for an admin once a visit stops that way twice.`,
        // Workers read the assignment's tool list as the boundary of what they may look at and
        // then invent what the project already holds. The list binds writes; reads are open.
        'The tool list inside the assignment names the tools that carry your writes, bound to this work. Reading is not bounded that way: every read tool this server offers you works on anything in this project, whether or not the assignment names it.',
        'Look before you invent. If your work needs something the assignment does not fix — a script, a protocol, a configuration, a threshold, a model — first read whether the project has already fixed it, and use that. Say in your submission what you found and reused, and what you had to choose yourself and why.',
        ...(session.continuity
          ? [
              'If the work cannot go on without the owner’s decision or someone else’s action (an operator’s fix, access, budget or a repair) and no tool can settle it, call session.ask_owner with one self-contained question that says what you wait for, and stop: your visit ends, the work waits for the answer, and it comes back to you in this conversation with the answer as a queued message.',
            ]
          : []),
        'A person may send a message to your thread while you work. Until you acknowledge it, every Merv call but session.messages and session.message.ack is refused with session_message_pending, which carries the message: acknowledge it at once with session.message.ack, a stable requestId and a concise reply about what you will do (you may still check things after), then send the refused call again, as it was unless the message changes what it should do. Before each handoff, call session.messages (without sessionId) and address every message still waiting. Acknowledging a message changes nothing already submitted; a change it asks of submitted work goes through the workflow’s own actions, never quietly.',
      ].join('\n');
/** What a visit is told of the visits its conversation lacks: those that kept none Merv got. */
const missedVisits = ({ visits, from, to }: { visits: number; from: string; to: string }) => {
  const one = visits === 1;
  return `${one ? 'This work’s last visit' : `This work’s last ${visits} visits`}, from ${from} to ${to}, kept no conversation that reached Merv: any conversation you continue ends before ${one ? 'it' : 'them'}, and nothing ${one ? 'it' : 'they'} did is in it. Before you go on, read what ${one ? 'it' : 'they'} left in the project: its records, artifacts and commits, and the machines and jobs still running.`;
};
/** A lease's length as its worker is told it, in whole minutes from its offer. */
const leaseMinutes = (session: Session) =>
  Math.max(
    0,
    Math.round((Date.parse(session.hardDeadline) - Date.parse(session.createdAt)) / 60_000),
  );
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
    return { sessions: await sessions.list(caller, true) };
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
    // Control is read, never posted.
    const action = req.method === 'POST' && route[2] !== 'control' ? route[2] : undefined;
    if (action) {
      if (action === 'huggingface-access' && !caller.managed)
        throw new MervError('managed_runner_forbidden', 'Managed runner authority required', 403);
      // A runner's stream batch is under a megabyte; this leaves it room. The lease controls
      // take the server's limit, and every other body 4 KiB.
      const limit = action === 'stream' ? 2 << 20 : leaseControls.has(action) ? undefined : 4096;
      const input = bound(await r.json(undefined, limit), 'sessionId', sessionId);
      if (action === 'huggingface-access') return await sessions.huggingfaceAccess(caller, input);
      if (action === 'launch-connections') return await sessions.launchConnections(caller, input);
      if (action === 'stream') return { stream: await sessions.streams.append(caller, input) };
      if (action === 'transcript') return { transcript: await sessions.transcript(caller, input) };
      if (action === 'conversation')
        return { conversation: await sessions.conversation(caller, input) };
      if (action === 'resume') return { download: await sessions.resume(caller, input) };
      const session =
        action === 'attach'
          ? await sessions.attach(caller, input)
          : action === 'workspace-result'
            ? await sessions.workspaceResult(caller, input)
            : action === 'heartbeat'
              ? await sessions.heartbeat(caller, input)
              : await sessions.release(caller, input);
      // Runners released before the unconditional call ask for launch connections only when
      // attach says so; self-hosted ones may still be running.
      return {
        session,
        ...(action === 'attach' ? { launchConnections: true, prompt: workerPrompt(session) } : {}),
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
    subscribe: (wake) => streams.subscribe(sessionId, caller.actorId, wake),
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
    subscribe: (wake) => streams.subscribeFeed(caller.projectId, caller.actorId, wake),
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
    // A thread's conversation, a part at a time: on from where `before` says a read stopped. It
    // reads its rows on a snapshot of its own and downloads holding none.
    const conversation = /^\/sessions\/threads\/([^/]+)\/conversation$/.exec(path);
    if (conversation && req.method === 'GET') {
      const before = r.url.searchParams.get('before') ?? undefined;
      check(
        [...r.url.searchParams.keys()].join() === (before === undefined ? '' : 'before'),
        'invalid_input',
        'The conversation route takes before=<cursor> or nothing',
      );
      const caller = await r.caller();
      return await sessions.threads.conversation(caller, pathSegment(conversation[1]!), before);
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
