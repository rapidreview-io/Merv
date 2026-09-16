/** Sequential async collection operations keep transactional callbacks in source order. */
export async function mapAsync<T extends readonly unknown[], U>(
  values: T,
  fn: (value: T[number], index: number) => U | Promise<U>,
): Promise<U[]> {
  const output: U[] = [];
  for (let index = 0; index < values.length; index++) output.push(await fn(values[index], index));
  return output;
}
export async function filterAsync<T>(
  values: readonly T[],
  fn: (value: T, index: number) => unknown | Promise<unknown>,
): Promise<T[]> {
  const output: T[] = [];
  for (let index = 0; index < values.length; index++)
    if (await fn(values[index], index)) output.push(values[index]);
  return output;
}
export async function someAsync<T>(
  values: readonly T[],
  fn: (value: T, index: number) => unknown | Promise<unknown>,
): Promise<boolean> {
  for (let index = 0; index < values.length; index++)
    if (await fn(values[index], index)) return true;
  return false;
}
export async function everyAsync<T>(
  values: readonly T[],
  fn: (value: T, index: number) => unknown | Promise<unknown>,
): Promise<boolean> {
  for (let index = 0; index < values.length; index++)
    if (!(await fn(values[index], index))) return false;
  return true;
}
export async function findAsync<T>(
  values: readonly T[],
  fn: (value: T, index: number) => unknown | Promise<unknown>,
): Promise<T | undefined> {
  for (let index = 0; index < values.length; index++)
    if (await fn(values[index], index)) return values[index];
}
export async function forEachAsync<T>(
  values: readonly T[],
  fn: (value: T, index: number) => unknown | Promise<unknown>,
): Promise<void> {
  for (let index = 0; index < values.length; index++) await fn(values[index], index);
}
