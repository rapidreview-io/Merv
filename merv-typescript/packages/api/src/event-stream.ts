import type { IncomingMessage, ServerResponse } from 'node:http';

/** Writes one server-sent event, waiting for the socket to drain, and gives up on it after 5 s. */
export type SendEvent = (event: string, data: unknown) => Promise<void>;

/**
 * One page's live view, as server-sent events. `subscribe` is taken before the headers, so a
 * refusal there is an ordinary error answer; its wake, and a refresh every two seconds, run
 * `step`, one at a time, which sends what is new. A step that throws or answers false ends the
 * stream; after `rotateMs` it sends `rotate` and closes, so the reader reconnects at once and
 * authority is never held open for long. Resolves once the response has ended.
 */
export async function serveEvents(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    rotateMs: number;
    subscribe(wake: () => void): () => void;
    step(send: SendEvent): Promise<boolean | void>;
  },
): Promise<void> {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let running: Promise<void> | undefined;
  let dirty = false;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (res.headersSent) res.end();
    finish();
  };
  const send: SendEvent = async (event, data) => {
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
        if ((await options.step(send)) === false) stop();
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
    unsubscribe = options.subscribe(pump);
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
    deadline = setTimeout(() => void send('rotate', {}).then(stop, stop), options.rotateMs);
    pump();
    await done;
    await running;
  } finally {
    unsubscribe?.();
    clearInterval(refresh);
    clearTimeout(deadline);
    res.off('close', stop);
    req.off('aborted', stop);
    stop();
  }
}
