// A three-way merge of one section's text, so that writers who edit different paragraphs of the
// same section at the same time do not refuse each other.

/** Base lines [start, end) replaced by `lines`; start === end is an insertion. */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
}
/** The most line pairs one diff compares, so a merge never costs more than refusing it. */
const MOST_CELLS = 1_000_000;

/** The hunks that turn `base` into `next`, in base order; null when too large to compare. */
function hunks(base: string[], next: string[]): Hunk[] | null {
  let head = 0;
  while (head < base.length && head < next.length && base[head] === next[head]) head++;
  let tail = 0;
  while (
    tail < base.length - head &&
    tail < next.length - head &&
    base[base.length - 1 - tail] === next[next.length - 1 - tail]
  )
    tail++;
  const a = base.slice(head, base.length - tail),
    b = next.slice(head, next.length - tail);
  if ((a.length + 1) * (b.length + 1) > MOST_CELLS) return null;
  // Longest common subsequence lengths of every pair of suffixes.
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
  const result: Hunk[] = [];
  let i = 0,
    j = 0,
    open: Hunk | null = null;
  const close = () => {
    if (open) result.push(open);
    open = null;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i++;
      j++;
    } else if (
      j < b.length &&
      (i === a.length || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)
    ) {
      open ??= { start: head + i, end: head + i, lines: [] };
      open.lines.push(b[j++]!);
    } else {
      open ??= { start: head + i, end: head + i, lines: [] };
      open.end = head + ++i;
    }
  }
  close();
  return result;
}

const same = (x: Hunk, y: Hunk) =>
  x.start === y.start &&
  x.end === y.end &&
  x.lines.length === y.lines.length &&
  x.lines.every((line, n) => line === y.lines[n]);

/**
 * `ours`, written against `base`, applied to `theirs`, which another writer made from the same
 * base: line by line, as Git merges. Null when the two changed the same or adjacent lines. Two
 * insertions at the same place keep both, ours first, as writers who met the other's text
 * placed their own.
 */
export function mergeText(base: string, ours: string, theirs: string): string | null {
  const lines = base.split('\n');
  const mine = hunks(lines, ours.split('\n'));
  const other = hunks(lines, theirs.split('\n'));
  if (!mine || !other) return null;
  const all: Hunk[] = [];
  for (const hunk of mine) {
    // Hunks of one diff are apart by at least one unchanged line, so touching ones clash too.
    const clashes = other.filter((o) => o.start <= hunk.end && hunk.start <= o.end);
    if (clashes.length === 1 && same(clashes[0]!, hunk)) continue;
    const inserted = (h: Hunk) => h.start === h.end && h.start === hunk.start;
    if (clashes.length > 1 || (clashes.length && !(inserted(hunk) && inserted(clashes[0]!))))
      return null;
    all.push(hunk);
  }
  // Ours sort before theirs at the same place: the sort is stable, and ours are listed first.
  const ordered = [...all, ...other].sort((x, y) => x.start - y.start);
  for (let n = 1; n < ordered.length; n++) if (ordered[n]!.start < ordered[n - 1]!.end) return null;
  const merged: string[] = [];
  let at = 0;
  for (const hunk of ordered) {
    merged.push(...lines.slice(at, hunk.start), ...hunk.lines);
    at = hunk.end;
  }
  merged.push(...lines.slice(at));
  return merged.join('\n');
}
