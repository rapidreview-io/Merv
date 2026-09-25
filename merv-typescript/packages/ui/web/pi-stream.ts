import { currentToken, projectSelection } from './api';

export interface PiConversation {
  id: string;
  title: string;
  activeCommandId: string | null;
  updatedAt: string;
}
export interface PiCommand {
  id: string;
  status: 'waiting' | 'starting' | 'working' | 'saving' | 'completed' | 'interrupted';
  messages: { role: 'user' | 'assistant'; text: string }[];
  error: string | null;
  /** The machine key the turn ran (or will run) on; absent on turns from before machines. */
  machine?: string;
}
/** Mirrors the server's PiMachine, PiMachineOption, PiMove and PiHostView. */
export interface PiMachine {
  key: string;
  label: string;
  vcpu: number;
  memoryGiB: number;
  diskGB: number;
}
export interface PiMachineOption extends PiMachine {
  available: boolean;
  reason?: string;
}
export type PiMoveBy = 'person' | 'agent' | 'deadline';
export interface PiMove {
  at: string;
  by: PiMoveBy;
  from: string;
  to: string;
  outcome: 'moved' | 'failed' | 'cancelled';
  reason?: string;
  conversationId?: string;
}
export interface PiHostView {
  machine: PiMachine | null;
  preferred: string;
  catalog: PiMachineOption[];
  state: 'none' | 'starting' | 'ready';
  idleEndsAt: string | null;
  idleSeconds: number;
  moving: { to: string; by: PiMoveBy; since: string } | null;
  lastMove: PiMove | null;
}
export interface PiEvent {
  sequence: number;
  commandId: string;
  type: 'text' | 'progress' | 'changed';
  text: string;
}
/** What the person is waiting on, and since when; an older server leaves it out. */
export interface PiStage {
  name: string;
  since: string;
  detail?: string;
}
export interface PiSnapshot {
  stage?: PiStage;
  /** The server's clock when this was read; an older server leaves it out. */
  now?: string;
  /** False when this project cannot run the agent at all. */
  available: boolean;
  conversation: PiConversation;
  commands: PiCommand[];
  /** The person's machine in this project; an older server leaves it out. */
  host?: PiHostView;
  streamId: string;
  sequence: number;
  tail: PiEvent[];
}
export type PiDelta = PiEvent & { streamId: string };
type Frame = { event: string; data: string };

export class PiStreamError extends Error {
  constructor(readonly status: number) {
    super(`Agent stream unavailable (${status})`);
  }
}

export function piFrameParser(accept: (frame: Frame) => void, maxFrameChars = 65_536) {
  let pending = '';
  let event = '';
  let data = '';
  let discarded = false;
  let overflow = false;
  const line = (value: string) => {
    if (!value) {
      if (!discarded && data) accept({ event: event || 'message', data: data.slice(0, -1) });
      event = '';
      data = '';
      discarded = false;
      return;
    }
    if (discarded || value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = content;
    if (field === 'data') {
      if (data.length + content.length > maxFrameChars) {
        discarded = true;
        data = '';
      } else data += `${content}\n`;
    }
  };
  return (chunk: string) => {
    let start = 0;
    let end = chunk.indexOf('\n');
    while (end !== -1) {
      if (overflow) {
        overflow = false;
        pending = '';
      } else if (pending.length + end - start > maxFrameChars) {
        pending = '';
        discarded = true;
      } else {
        line((pending + chunk.slice(start, end)).replace(/\r$/, ''));
        pending = '';
      }
      start = end + 1;
      end = chunk.indexOf('\n', start);
    }
    if (!overflow && pending.length + chunk.length - start > maxFrameChars) {
      pending = '';
      discarded = true;
      overflow = true;
    } else if (!overflow) {
      pending += chunk.slice(start);
    }
  };
}

/** Resolves true when the server closed the stream on purpose, so reconnecting says nothing. */
export async function readPiEvents(
  id: string,
  signal: AbortSignal,
  onSnapshot: (snapshot: PiSnapshot) => void,
  onDelta: (delta: PiDelta) => void,
): Promise<boolean> {
  const response = await fetch(`/pi/${encodeURIComponent(id)}/events`, {
    signal,
    credentials: 'omit',
    headers: {
      accept: 'text/event-stream',
      ...(currentToken() ? { authorization: `Bearer ${currentToken()}` } : {}),
      ...(projectSelection() ? { 'x-merv-project-id': projectSelection()! } : {}),
    },
  });
  if (!response.ok || !response.body) throw new PiStreamError(response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rotated = false;
  const parse = piFrameParser(
    ({ event, data }) => {
      if (event === 'rotate') rotated = true;
      try {
        const value: unknown = JSON.parse(data);
        if (!value || typeof value !== 'object') return;
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
      } catch {}
    },
    32 * 1024 * 1024,
  );
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      parse(decoder.decode(value, { stream: true }));
    }
    parse(decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return rotated;
}
