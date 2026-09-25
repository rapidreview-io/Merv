import { isUtf8 } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from 'cordis';
import { MervError, check, type Caller } from '@merv/contracts';
import type { MountHandler } from '@merv/api/types';
import type { PiApiProvider } from '@merv/api/pi';
import { piModelRelay } from './relay.js';
import type { PiRuntime } from './types.js';

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

/** A completion carries an answer of up to messageChars (at most six bytes each as JSON) and its
 * checkpoint (2 MB). */
const bodyBytes = 16_000_000;

async function body(req: IncomingMessage): Promise<unknown> {
  check(
    !req.destroyed && req.headers['content-type']?.split(';')[0].trim() === 'application/json',
    'invalid_pi_input',
    'Expected JSON',
    415,
  );
  check(
    Number(req.headers['content-length'] ?? 0) <= bodyBytes,
    'pi_body_too_large',
    'Request exceeds its limit',
    413,
  );
  const chunks: Buffer[] = [];
  let size = 0;
  const timeout = setTimeout(() => req.destroy(), 10_000);
  timeout.unref();
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      check(size <= bodyBytes, 'pi_body_too_large', 'Request exceeds its limit', 413);
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    check(isUtf8(bytes), 'invalid_pi_input', 'Expected UTF-8 JSON');
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new MervError('invalid_pi_input', 'Invalid JSON');
    }
  } finally {
    clearTimeout(timeout);
    req.resume();
  }
}

export class PiHttp implements PiApiProvider {
  private readonly responses = new Set<ServerResponse>();
  private closed = false;

  constructor(
    private readonly pi: PiRuntime,
    private readonly rotateMs = 20_000,
    // Held /next answers stay well inside the 10 s request timeout of workers already running.
    private readonly holdMs = 5_000,
  ) {}

  readonly worker: MountHandler = async (req, res) => {
    try {
      check(!this.closed, 'pi_unavailable', 'Agent conversations are unavailable', 503);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const match = /^\/pi-worker\/(next|begin|tool|progress|complete|fail)$/.exec(url.pathname);
      check(
        req.method === 'POST' && match && !url.search,
        'not_found',
        'Unknown worker route',
        404,
      );
      check(
        !req.headers.origin,
        'pi_forbidden',
        'Worker routes do not accept browser requests',
        403,
      );
      const token = req.headers.authorization?.match(/^Bearer (piw_[A-Za-z0-9_.-]+)$/)?.[1];
      check(token, 'pi_unauthorized', 'A worker credential is required', 401);
      await this.pi.authenticateWorker(token);
      const input = await body(req);
      check(!this.closed && !res.destroyed, 'pi_unavailable', 'Worker connection closed', 503);
      const action = match[1];
      if (action === 'next') json(res, 200, await this.pi.next(token, input, this.holdMs));
      else if (action === 'tool') json(res, 200, { result: await this.pi.tool(token, input) });
      else if (action === 'begin') json(res, 200, await this.pi.begin(token, input));
      else if (action === 'progress') json(res, 200, await this.pi.progress(token, input));
      else if (action === 'complete') json(res, 200, await this.pi.complete(token, input));
      else json(res, 200, await this.pi.fail(token, input));
    } catch (error) {
      req.resume();
      json(res, error instanceof MervError ? error.status : 500, {
        error:
          error instanceof MervError
            ? { code: error.code, message: error.message }
            : { code: 'pi_unavailable', message: 'Agent operation failed' },
      });
    }
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
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let sequence = -1;
    // A page's authority is read at most once a second, however often words arrive.
    let authorized = Date.now();
    let running: Promise<void> | undefined;
    let dirty = false;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (res.headersSent) res.end();
      finish();
    };
    const send = async (event: string, data: unknown): Promise<void> => {
      if (stopped || res.destroyed) return;
      if (res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) return;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          res.destroy();
          finishWrite();
        }, 5000);
        const finishWrite = () => {
          clearTimeout(timeout);
          res.off('drain', finishWrite);
          res.off('close', finishWrite);
          resolve();
        };
        res.once('drain', finishWrite);
        res.once('close', finishWrite);
      });
    };
    const pump = () => {
      dirty = true;
      if (running || stopped) return;
      running = (async () => {
        while (dirty && !stopped) {
          dirty = false;
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
        }
      })()
        .catch(stop)
        .finally(() => {
          running = undefined;
          if (dirty && !stopped) pump();
        });
    };
    let unsubscribe: (() => void) | undefined;
    let refresh: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      unsubscribe = this.pi.streams.subscribe(id, pump);
      res.once('close', stop);
      req.once('aborted', stop);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
      });
      res.flushHeaders();
      refresh = setInterval(pump, 2000);
      // Say the close is deliberate so the reader reconnects at once, without a notice.
      deadline = setTimeout(() => void send('rotate', {}).then(stop, stop), this.rotateMs);
      pump();
      await done;
      await running;
    } finally {
      unsubscribe?.();
      clearInterval(refresh);
      clearTimeout(deadline);
      res.off('close', stop);
      req.off('aborted', stop);
      this.responses.delete(res);
      stop();
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
    const log = (record: object) => void process.stderr.write(`${JSON.stringify(record)}\n`);
    ctx.effect(() => () => http.close());
    ctx.effect(() => ctx.api.registerPi(http));
    ctx.effect(() => ctx.api.mount('/pi-worker', http.worker));
    ctx.effect(() =>
      ctx.api.mountModelRelay(
        '/pi-model',
        piModelRelay({
          enabled: ctx.pi.config.enabled,
          models: ctx.pi.config.models,
          providerKey: () => process.env[ctx.pi.config.modelApiKeyEnv] ?? '',
          authority: {
            authorize: (token) => ctx.pi.authorizeModel(token),
            validate: (grant) => ctx.pi.validateModel(grant),
          },
          onFailure: log,
          reserve: (grant, body) => ctx.pi.reserveModel(grant, body),
          onUsage: async (record, grant, reserved) => {
            log(record);
            await ctx.pi.settleModel(record, grant, reserved);
          },
        }),
      ),
    );
  },
};
export default piApiPlugin;
