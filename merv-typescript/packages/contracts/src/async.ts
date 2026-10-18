/** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
export const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', stop, { once: true });
  });
/** Sequential async collection operations keep transactional callbacks in source order. */
export async function mapAsync<T extends readonly unknown[], U>(
  values: T,
  fn: (value: T[number], index: number) => U | Promise<U>,
): Promise<U[]> {
  const output: U[] = [];
  for (let index = 0; index < values.length; index++) output.push(await fn(values[index], index));
  return output;
}
export async function everyAsync<T>(
  values: readonly T[],
  fn: (value: T, index: number) => unknown | Promise<unknown>,
): Promise<boolean> {
  for (let index = 0; index < values.length; index++)
    if (!(await fn(values[index], index))) return false;
  return true;
}
