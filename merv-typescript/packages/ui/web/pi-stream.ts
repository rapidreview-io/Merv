import type { PiEvent, PiSnapshot } from '@merv/pi/models';
import { readEventStream } from './event-stream';

export type PiDelta = PiEvent & { streamId: string };
/** Pi's stream: its snapshots and its deltas. Resolves as `readEventStream` does. */
export const readPiEvents = (
  id: string,
  signal: AbortSignal,
  onSnapshot: (snapshot: PiSnapshot) => void,
  onDelta: (delta: PiDelta) => void,
): Promise<boolean> =>
  readEventStream(`/pi/${encodeURIComponent(id)}/events`, signal, (event, value) => {
    if (event === 'snapshot' && 'conversation' in value && 'streamId' in value)
      onSnapshot(value as PiSnapshot);
    if (
      event === 'delta' &&
      'streamId' in value &&
      'sequence' in value &&
      'commandId' in value &&
      'type' in value &&
      'text' in value
    )
      onDelta(value as PiDelta);
  });
