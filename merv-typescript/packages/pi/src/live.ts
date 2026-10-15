import type { Caller } from '@merv/contracts';
import type { PiEvent, PiSnapshot } from './models.js';

/** What a live view reads of Pi: PiRuntime satisfies it. */
export interface PiLiveSource {
  snapshot(caller: Caller, id: string): Promise<PiSnapshot>;
  authorizeStream(caller: Caller, id: string): Promise<void>;
  readonly streams: {
    snapshot(id: string): { streamId: string; sequence: number; tail: PiEvent[] };
    subscribe(id: string, listener: () => void): () => void;
  };
}

/**
 * One page's live view of a conversation, as `serveEvents` takes it: a whole `snapshot` first and
 * whenever the tail cannot carry the page forward, else each new event as a `delta`. `view` is
 * what a snapshot sends (the whole of it by default); deltas are always sent as they are. Pi's own
 * `/pi/<id>/events` and any plugin serving the same conversation to someone else use this, so the
 * stream a page reads is the same wherever it is served.
 */
export function piLiveView(
  pi: PiLiveSource,
  caller: Caller,
  id: string,
  view: (snapshot: PiSnapshot) => unknown = (snapshot) => snapshot,
) {
  let sequence = -1;
  // A page's authority is read at most once a second, however often words arrive.
  let authorized = Date.now();
  return {
    subscribe: (wake: () => void) => pi.streams.subscribe(id, wake),
    step: async (send: (event: 'snapshot' | 'delta', data: unknown) => Promise<void>) => {
      if (Date.now() - authorized >= 1000) {
        await pi.authorizeStream(caller, id);
        authorized = Date.now();
      }
      const tail = pi.streams.snapshot(id);
      const events = tail.tail.filter((event) => event.sequence > sequence);
      if (
        sequence < 0 ||
        events.some((event) => event.type === 'changed') ||
        (events[0] && events[0].sequence > sequence + 1)
      ) {
        const snapshot = await pi.snapshot(caller, id);
        await send('snapshot', view(snapshot));
        sequence = snapshot.sequence;
      } else {
        for (const event of events) {
          await send('delta', { streamId: tail.streamId, ...event });
          sequence = event.sequence;
        }
      }
    },
  };
}
