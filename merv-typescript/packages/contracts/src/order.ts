/**
 * Items in an order that puts every prerequisite before what waits on it, stable by listed
 * position. Undefined when the dependencies form a cycle. Shared because the program that
 * validates a plan and the one that creates its records must agree on the order.
 */
export function ordered<T extends { key: string; dependsOn: string[] }>(
  items: T[],
): T[] | undefined {
  const done = new Set<string>();
  const result: T[] = [];
  while (result.length < items.length) {
    const next = items.find(
      (item) => !done.has(item.key) && item.dependsOn.every((dependency) => done.has(dependency)),
    );
    if (!next) return undefined;
    done.add(next.key);
    result.push(next);
  }
  return result;
}
