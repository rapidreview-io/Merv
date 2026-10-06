/**
 * Work a member's text could make hold the page's one thread, done in a worker
 * (`markdown-worker.ts`) one job at a time: micromark is superlinear on a few texts, such as
 * thousands of `*` or of links that never close in one paragraph, and a grammar is on some lines
 * of code. A job the worker has not done in READ_MS stands undone (null), and a new worker takes
 * the next. That clock runs only while the worker works, never while it, or a grammar a job
 * needs, still downloads, so a slow download gives up nothing. Where no worker starts, as in a
 * test's DOM, `here` does each job in the page.
 */
const READ_MS = 2000;

export function offThread<Message, Result>(here: (message: Message) => Promise<Result>) {
  /** The results of the jobs done last, by key; null for one not done in time. */
  const results = new Map<string, Result | null>();
  /** The jobs to do, oldest first, each with whoever still waits for it. */
  const waiting = new Map<string, { message: Message; waiters: Set<() => void> }>();
  /** Undefined until one starts; null once none could. */
  let worker: Worker | null | undefined;
  /** Whether the worker has said it loaded: until then it is downloading, not working. */
  let loaded = false;
  let busy = false;
  const inPage = () => worker === null || typeof Worker === 'undefined';

  function keep(key: string, result: Result | null): void {
    results.delete(key);
    results.set(key, result);
    if (results.size > 500) results.delete(results.keys().next().value!);
  }

  /** The oldest job someone still waits for, done in the worker, or in the page where none runs. */
  function next(): void {
    if (busy) return;
    // A job nobody waits for any more, such as reading what a growing text was, is not done.
    for (const [key, job] of waiting) if (!job.waiters.size) waiting.delete(key);
    const [first] = waiting;
    if (!first) return;
    const [key, { message, waiters }] = first;
    busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (result: Result | null) => {
      clearTimeout(timer);
      busy = false;
      keep(key, result);
      waiting.delete(key);
      for (const wake of waiters) wake();
      next();
    };
    if (!inPage())
      try {
        if (!worker) {
          worker = new Worker(new URL('./markdown-worker.ts', import.meta.url), { type: 'module' });
          loaded = false;
        }
      } catch {
        worker = null;
      }
    if (inPage()) {
      here(message).then(done, () => done(null));
      return;
    }
    const time = () =>
      (timer = setTimeout(() => {
        worker?.terminate();
        worker = undefined;
        done(null);
      }, READ_MS));
    worker!.onmessage = (event: MessageEvent<Result | 'loaded' | 'loading'>) => {
      // The worker fetches what this job needs: the clock waits for it.
      if (event.data === 'loading') return clearTimeout(timer);
      if (event.data !== 'loaded') return done(event.data);
      loaded = true;
      time();
    };
    // A worker that cannot start leaves every job to the page.
    worker!.onerror = () => {
      worker = null;
      clearTimeout(timer);
      busy = false;
      next();
    };
    worker!.postMessage(message);
    if (loaded) time();
  }

  return {
    inPage,
    keep,
    /** The result of a job done, null for one that could not be, or undefined while it is not. */
    known: (key: string) => results.get(key),
    /** Has the job done, and `wake` called once it is; what it returns stops the waiting. */
    want(key: string, message: Message, wake: () => void): () => void {
      const job = waiting.get(key) ?? { message, waiters: new Set() };
      waiting.set(key, job);
      job.waiters.add(wake);
      next();
      return () => void job.waiters.delete(wake);
    },
  };
}
