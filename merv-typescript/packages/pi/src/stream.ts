import { randomUUID } from 'node:crypto';
import { check } from '@merv/contracts';
import type { PiEvent } from './types.js';

const busy = 'Too many agent streams are open; retry shortly';

interface Tail {
  id: string;
  sequence: number;
  bytes: number;
  events: PiEvent[];
  listeners: Set<() => void>;
}

export class PiStreams {
  private readonly tails = new Map<string, Tail>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(
    // Recent events, for pages keeping up; one further behind reads a snapshot, which carries the
    // answer so far whole (PiService.snapshot).
    private readonly maxBytes = 64_000,
    private readonly maxConversations = 128,
  ) {}

  /** With every tail read, only a new reader is refused; writers get a detached tail. */
  private get(id: string, reader = false): Tail {
    let tail = this.tails.get(id);
    if (!tail) {
      tail = { id: randomUUID(), sequence: 0, bytes: 0, events: [], listeners: new Set() };
      if (this.tails.size >= this.maxConversations) {
        const available = [...this.tails].find(([, item]) => item.listeners.size === 0);
        check(available || !reader, 'pi_stream_busy', busy, 429);
        if (!available) return tail;
        this.tails.delete(available[0]);
      }
      this.tails.set(id, tail);
    }
    return tail;
  }

  /** Published events never change, so a page reads the tail without copying each of them. */
  snapshot(id: string) {
    const tail = this.get(id);
    return { streamId: tail.id, sequence: tail.sequence, tail: tail.events.slice() };
  }

  /** Resolves at the next wake(id), or after `ms`; no tail or reader slot is taken. */
  wait(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, waiters);
      const wake = () => {
        clearTimeout(timer);
        waiters.delete(wake);
        if (!waiters.size) this.waiters.delete(id);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      waiters.add(wake);
    });
  }

  wake(id: string): void {
    for (const wake of this.waiters.get(id) ?? []) wake();
  }

  publish(id: string, event: Omit<PiEvent, 'sequence'>): void {
    const tail = this.get(id);
    const value = { ...event, sequence: ++tail.sequence };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.maxBytes) return;
    tail.events.push(value);
    tail.bytes += bytes;
    while (tail.bytes > this.maxBytes) {
      tail.bytes -= Buffer.byteLength(JSON.stringify(tail.events.shift()!));
    }
    for (const listener of tail.listeners) listener();
  }

  /** Asks the open pages of `id`, if any, to re-read, keeping its tail: a turn there may be
   * streaming. */
  nudge(id: string): void {
    if (this.tails.get(id)?.listeners.size)
      this.publish(id, { commandId: '', type: 'changed', text: '' });
  }

  changed(id: string, commandId = ''): void {
    const tail = this.get(id);
    tail.events = [];
    tail.bytes = 0;
    this.publish(id, { commandId, type: 'changed', text: '' });
  }

  subscribe(id: string, listener: () => void): () => void {
    const tail = this.get(id, true);
    check(tail.listeners.size < 8, 'pi_stream_busy', busy, 429);
    tail.listeners.add(listener);
    return () => {
      tail.listeners.delete(listener);
    };
  }

  close(): void {
    for (const waiters of [...this.waiters.values()]) for (const wake of waiters) wake();
    for (const tail of this.tails.values()) {
      for (const listener of tail.listeners) listener();
      tail.listeners.clear();
    }
    this.tails.clear();
  }
}
