import { isUtf8 } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from 'cordis';
import { MervError, check, type Caller } from '@merv/contracts';
import { serveEvents } from '@merv/api/event-stream';
import type { ApiCredential, MountHandler } from '@merv/api/types';
import type { PiRuntime } from './types.js';

/** A completion carries an answer of up to messageChars (at most six bytes each as JSON) and its
 * checkpoint (2 MB). */
const bodyBytes = 16_000_000;
const workerRoute = /^\/pi-worker\/(next|begin|tool|progress|complete|fail)$/;
/** Far deeper than any tool output nests, and far short of where digesting a body recurses too deep. */
const bodyDepth = 512;

/** How deep the JSON text nests its arrays and objects, read without parsing it. */
function depth(text: string): number {
  let deepest = 0,
    open = 0,
    quoted = false;
  for (let at = 0; at < text.length; at++) {
    const c = text.charCodeAt(at);
    if (quoted) {
      if (c === 92) at++;
      else if (c === 34) quoted = false;
    } else if (c === 34) quoted = true;
    else if (c === 91 || c === 123) deepest = Math.max(deepest, ++open);
    else if (c === 93 || c === 125) open--;
  }
  return deepest;
}

export class PiHttp {
  private readonly responses = new Set<ServerResponse>();
  private closed = false;

  constructor(
    private readonly pi: PiRuntime,
    private readonly rotateMs = 20_000,
    // Held /next answers stay well inside the 10 s request timeout of workers already running.
    private readonly holdMs = 5_000,
  ) {}

  /** `piw_` bearers: a worker's own credential, for the worker routes alone. Every path under
   *  /pi-worker reaches the handler, which answers 404 off its exact routes. */
  readonly credential: ApiCredential = {
    kind: 'pi-worker',
    forbidden: new MervError(
      'pi_forbidden',
      'Worker credentials only reach the worker routes',
      403,
    ),
    routes: (_method, path) => path.startsWith('/pi-worker/'),
    authenticate: (token) => this.pi.authenticateWorker(token),
  };

  /** `POST /pi-worker/<action>`: a worker's request, authenticated by its `piw_` credential. */
  readonly worker: MountHandler = async (req, _res, r) => {
    check(!this.closed, 'pi_unavailable', 'Agent conversations are unavailable', 503);
    const match = workerRoute.exec(r.url.pathname);
    check(
      req.method === 'POST' && match && !r.url.search,
      'not_found',
      'Unknown worker route',
      404,
    );
    check(!req.headers.origin, 'pi_forbidden', 'Worker routes do not accept browser requests', 403);
    check(
      r.principal?.kind === 'pi-worker',
      'pi_unauthorized',
      'A worker credential is required',
      401,
    );
    const token = r.bearer();
    // Read raw, not through r.json: a completion carries what the agent's tools returned, which
    // may hold any key, any depth and half a character, and the handlers check its shape.
    const bytes = await r.bytes(bodyBytes, 'application/json');
    check(isUtf8(bytes), 'invalid_pi_input', 'Expected UTF-8 JSON');
    const text = bytes.toString('utf8');
    check(
      depth(text) <= bodyDepth,
      'invalid_pi_input',
      `JSON nests deeper than ${bodyDepth} levels`,
    );
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      throw new MervError('invalid_pi_input', 'Invalid JSON');
    }
    check(!this.closed, 'pi_unavailable', 'Worker connection closed', 503);
    const action = match[1];
    if (action === 'next') return await this.pi.next(token, input, this.holdMs);
    if (action === 'tool') return { result: await this.pi.tool(token, input) };
    if (action === 'begin') return await this.pi.begin(token, input);
    if (action === 'progress') return await this.pi.progress(token, input);
    if (action === 'complete') return await this.pi.complete(token, input);
    return await this.pi.fail(token, input);
  };

  /** `GET /pi/<id>/events`: a page's live view of one conversation, as its authenticated person. */
  readonly events: MountHandler = async (req, res, r) => {
    const match = /^\/pi\/([A-Za-z0-9_-]{1,200})\/events$/.exec(r.url.pathname);
    check(
      req.method === 'GET' && match && !r.url.search,
      'not_found',
      'Unknown conversation route',
      404,
    );
    await this.stream(await r.caller(), match[1]!, req, res);
  };

  async stream(
    caller: Caller,
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    check(!this.closed, 'pi_unavailable', 'Agent conversations are unavailable', 503);
    await this.pi.authorizeStream(caller, id);
    check(!res.destroyed, 'pi_unavailable', 'Connection closed', 503);
    this.responses.add(res);
    let sequence = -1;
    // A page's authority is read at most once a second, however often words arrive.
    let authorized = Date.now();
    try {
      await serveEvents(req, res, {
        rotateMs: this.rotateMs,
        subscribe: (wake) => this.pi.streams.subscribe(id, wake),
        step: async (send) => {
          if (Date.now() - authorized >= 1000) {
            await this.pi.authorizeStream(caller, id);
            authorized = Date.now();
          }
          const tail = this.pi.streams.snapshot(id);
          const events = tail.tail.filter((event) => event.sequence > sequence);
          if (
            sequence < 0 ||
            events.some((event) => event.type === 'changed') ||
            (events[0] && events[0].sequence > sequence + 1)
          ) {
            const snapshot = await this.pi.snapshot(caller, id);
            await send('snapshot', snapshot);
            sequence = snapshot.sequence;
          } else {
            for (const event of events) {
              await send('delta', { streamId: tail.streamId, ...event });
              sequence = event.sequence;
            }
          }
        },
      });
    } finally {
      this.responses.delete(res);
    }
  }

  close(): void {
    this.closed = true;
    for (const res of this.responses) res.destroy();
    this.responses.clear();
  }
}

export const piApiPlugin = {
  name: 'merv-pi-api',
  inject: ['pi', 'api'],
  apply(ctx: Context) {
    const http = new PiHttp(ctx.pi);
    ctx.effect(() => () => http.close());
    ctx.effect(() => ctx.api.mount('/pi', http.events));
    ctx.effect(() => ctx.api.credential('piw_', http.credential));
    ctx.effect(() => ctx.api.mount('/pi-worker', http.worker));
    ctx.effect(() => {
      const relay = ctx.pi.modelRelay();
      const unmount = ctx.api.mount('/pi-model', relay.handle, { public: true });
      return () => {
        unmount();
        relay.close();
      };
    });
  },
};
export default piApiPlugin;
