import type { MervError } from '@merv/contracts';

/**
 * Calls in flight: at most `total` in the process and `perProject` for one project, so no one
 * project's calls (a reader's MCP client, say) take every slot. A call past either waits its
 * turn, in order, for up to `waitMs`: a Pi answer that searches six things at once runs them
 * all, a few at a time, rather than having some refused.
 */
export class Slots {
  private running = 0;
  private readonly held = new Map<string, number>();
  private readonly queue: { project: string; start: () => void }[] = [];

  constructor(
    private readonly total: number,
    private readonly perProject: number,
  ) {}

  acquire(
    project: string,
    waitMs: number,
    signal: AbortSignal,
    busy: () => MervError,
  ): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    // Anyone waiting is waiting on a limit this call does not share, or it would have started.
    if (this.free(project)) return Promise.resolve(this.take(project));
    return new Promise((resolve, reject) => {
      const waiter = {
        project,
        start: () => {
          settle();
          resolve(this.take(project));
        },
      };
      const settle = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const stop = () => {
        settle();
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        settle();
        reject(busy());
      }, waitMs);
      signal.addEventListener('abort', stop, { once: true });
      this.queue.push(waiter);
    });
  }

  private free(project: string): boolean {
    return this.running < this.total && (this.held.get(project) ?? 0) < this.perProject;
  }

  private take(project: string): () => void {
    this.running++;
    this.held.set(project, (this.held.get(project) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      const left = this.held.get(project)! - 1;
      if (left > 0) this.held.set(project, left);
      else this.held.delete(project);
      // The first waiter a freed slot admits, in the order they came.
      this.queue.find((waiter) => this.free(waiter.project))?.start();
    };
  }
}
