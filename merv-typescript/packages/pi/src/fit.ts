/** One result as the model is shown it, about 10,000 tokens: later turns replay it (the worker
 * clips older results first). UTF-8 bytes track tokens better than characters. */
const resultBytes = 32_000;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null));
/** The largest `make(n)`, n from `whole` down, that fits resultBytes. */
const within = <T>(whole: number, make: (n: number) => T): T => {
  let shown = whole;
  for (let bytes = size(make(shown)); bytes > resultBytes && shown > 0; bytes = size(make(shown)))
    shown = Math.min(shown - 1, Math.floor((shown * (resultBytes - 200)) / bytes));
  return make(shown);
};
/** Objects inside arrays keep only their scalar fields, their strings clipped to 300 characters:
 * every record's id, title and status in a list far too long to show whole. */
const index = (value: unknown, listed = false): unknown =>
  Array.isArray(value)
    ? value.map((item) => index(item, true))
    : !value || typeof value !== 'object'
      ? value
      : Object.fromEntries(
          Object.entries(value)
            .filter(([, item]) => !listed || item === null || typeof item !== 'object')
            .map(([key, item]) => [
              key,
              !listed
                ? index(item)
                : typeof item === 'string' && item.length > 300
                  ? `${item.slice(0, 300)}…`
                  : item,
            ]),
        );
/** Each array of `value`, top-level or a field of it, keeping at most `count` of its items: those
 * created last, else its last; `cut` collects what each left out. */
const newest = (value: unknown, count: number, cut: string[], name = 'items'): unknown => {
  if (Array.isArray(value)) {
    if (value.length <= count) return value;
    const at = (item: unknown) => (item as { createdAt?: unknown })?.createdAt;
    const dated = value.every((item) => typeof at(item) === 'string');
    const kept = new Set(
      (dated
        ? [...value.keys()].sort((a, b) => String(at(value[b])).localeCompare(String(at(value[a]))))
        : [...value.keys()].reverse()
      ).slice(0, count),
    );
    cut.push(`${name}: ${count} of ${value.length} shown, newest`);
    return value.filter((_item, key) => kept.has(key));
  }
  return value && typeof value === 'object' && name === 'items'
    ? Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, newest(item, count, cut, key)]),
      )
    : value;
};
/** A tool's result as the model is shown it: whole when it fits resultBytes, otherwise by the
 * first of these that fits, each saying how to read the rest. A write's receipt goes the same way:
 * it still says the write succeeded, and keeps its ids. */
export function fit(name: string, result: unknown): unknown {
  // An artifact's text, or one section of the paper: a slice, and where to read on.
  const read =
    (name === 'artifact.read' || name === 'paper.read') &&
    typeof (result as { content?: unknown })?.content === 'string'
      ? (result as { content: string; encoding?: string; offset?: number; total?: number })
      : null;
  // Base64 is never shown: it is bytes the model cannot read.
  if (read?.encoding === 'base64') {
    const { content, ...rest } = read;
    return {
      ...rest,
      note: `Binary content (${Buffer.byteLength(content, 'base64')} bytes) is not shown`,
    };
  }
  if (size(result) <= resultBytes) return result;
  if (read) {
    const start = read.offset ?? 0;
    return within(read.content.length, (count) => {
      // Never half a character.
      const end = /[\uD800-\uDBFF]/.test(read.content[count - 1] ?? '') ? count - 1 : count;
      return {
        ...read,
        content: read.content.slice(0, end),
        note: `Characters ${start}–${start + end} of ${read.total ?? read.content.length} are shown; read on with offset ${start + end}`,
      };
    });
  }
  const note =
    name === 'paper.read'
      ? 'Shown as an index: read one section with paper.read, its kind and section id'
      : 'Shown as an index: read one record with its get tool';
  const listed = index(result);
  if (size(listed) < size(result)) {
    if (size({ index: listed, note }) <= resultBytes) return { index: listed, note };
    const longest = Math.max(
      ...[listed, ...Object.values(listed ?? {})].map((part) =>
        Array.isArray(part) ? part.length : 0,
      ),
    );
    const shown = within(longest, (count) => {
      const cut: string[] = [];
      const kept = newest(listed, count, cut);
      return { index: kept, note: [note, ...cut].join('. ') };
    });
    if (size(shown) <= resultBytes) return shown;
  }
  const json = JSON.stringify(result);
  const bytes = Buffer.byteLength(json);
  const partial = Buffer.from(json)
    .subarray(0, resultBytes - 200)
    .toString()
    .replace(/\uFFFD$/, '');
  return {
    partial,
    truncated: `Only the first ${Buffer.byteLength(partial)} of ${bytes} bytes are shown`,
  };
}
