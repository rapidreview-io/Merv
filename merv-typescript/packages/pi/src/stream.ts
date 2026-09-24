import { randomUUID } from 'node:crypto';
import type { PiEvent } from './types.js';

interface Tail {
  id: string;
  sequence: number;
  bytes: number;
  events: PiEvent[];
  listeners: Set<() => void>;
}

export class PiStreams {
  private readonly tails = new Map<string, Tail>();

  constructor(
    private readonly maxBytes = 64_000,
    private readonly maxConversations = 128,
  ) {}

  private get(id: string): Tail {
    let tail = this.tails.get(id);
    if (!tail) {
      if (this.tails.size >= this.maxConversations) {
        const available = [...this.tails].find(([, item]) => item.listeners.size === 0);
        if (!available) throw new Error('Pi stream capacity reached');
        this.tails.delete(available[0]);
      }
      tail = { id: randomUUID(), sequence: 0, bytes: 0, events: [], listeners: new Set() };
      this.tails.set(id, tail);
    }
    return tail;
  }

  snapshot(id: string) {
    const tail = this.get(id);
    return { streamId: tail.id, sequence: tail.sequence, tail: structuredClone(tail.events) };
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

  changed(id: string, commandId = ''): void {
    const tail = this.get(id);
    tail.events = [];
    tail.bytes = 0;
    this.publish(id, { commandId, type: 'changed', text: '' });
  }

  subscribe(id: string, listener: () => void): () => void {
    const tail = this.get(id);
    if (tail.listeners.size >= 8) throw new Error('Pi stream subscriber limit reached');
    tail.listeners.add(listener);
    return () => {
      tail.listeners.delete(listener);
    };
  }

  close(): void {
    for (const tail of this.tails.values()) {
      for (const listener of tail.listeners) listener();
      tail.listeners.clear();
    }
    this.tails.clear();
  }
}
