import type { DiffReference } from '@merv/protocol/diff';

interface Part {
  text: string;
  changed: boolean;
}

/** Selection is confined to one hunk, including words split by inline highlighting. */
export function pickedLines(pre: HTMLPreElement, selection = window.getSelection()) {
  if (
    !selection ||
    selection.isCollapsed ||
    !selection.rangeCount ||
    !pre.contains(selection.anchorNode) ||
    !pre.contains(selection.focusNode)
  )
    return [];
  const range = selection.getRangeAt(0);
  return Array.from(pre.querySelectorAll<HTMLElement>(':scope > [data-line]'))
    .filter((line) => {
      if (!range.intersectsNode(line)) return false;
      const overlap = range.cloneRange();
      overlap.selectNodeContents(line);
      if (overlap.compareBoundaryPoints(range.START_TO_START, range) < 0)
        overlap.setStart(range.startContainer, range.startOffset);
      if (overlap.compareBoundaryPoints(range.END_TO_END, range) > 0)
        overlap.setEnd(range.endContainer, range.endOffset);
      return overlap.toString().length > 0;
    })
    .map((line) => Number(line.dataset.line));
}

export function lineReference(
  thread: string,
  path: string,
  hunk: { id: string; diff: string },
  indices: number[],
): DiffReference | undefined {
  let before = 0,
    after = 0,
    previous = 0;
  const lines = hunk.diff.split('\n').map((line) => line.replace(/\r$/, ''));
  const numbers = lines.map((line) => {
    const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (head) {
      before = Number(head[1]);
      after = Number(head[2]);
      previous = 0;
      return 0;
    }
    if (line.startsWith('-')) return (previous = before++);
    if (line.startsWith('+')) return (previous = after++);
    if (line.startsWith(' ')) {
      before++;
      return (previous = after++);
    }
    if (line.startsWith('\\')) return previous;
    return 0;
  });
  const chosen = [...new Set(indices)].filter((i) => numbers[i] > 0).sort((a, b) => a - b);
  if (!chosen.length) return;
  return {
    thread,
    path,
    hunk: hunk.id,
    first: Math.min(...chosen.map((i) => numbers[i])),
    last: Math.max(...chosen.map((i) => numbers[i])),
    lines: chosen.map((i) => lines[i]),
    indices: chosen,
  };
}

/** Approval previews use the requested text; nothing on disk has changed yet. */
export function approvalPreview(request: { kind: string; title: string; detail: string | null }) {
  if (request.kind === 'file_change' && request.detail && /^(?:@@|[+-])/m.test(request.detail))
    return { kind: 'diff', text: request.detail };
  let input;
  try {
    input = JSON.parse(request.detail ?? 'null');
  } catch {
    /* Older requests may have plain text details. */
  }
  if (
    request.kind === 'command' &&
    input?.setup === true &&
    typeof input.command === 'string' &&
    typeof input.boundary === 'string'
  )
    return { kind: 'setup', text: input.command, detail: input.boundary };
  if (
    request.kind === 'command' ||
    (request.kind === 'tool' && /^(Run |Bash\b)/.test(request.title))
  ) {
    const command =
      typeof input?.command === 'string'
        ? input.command
        : request.title.replace(/^(Run |Bash\s*)/, '');
    return { kind: 'command', text: command };
  }
  if (request.kind !== 'tool' || !/^(Edit|Write|MultiEdit)\b/.test(request.title)) return;
  const edits = request.title.startsWith('MultiEdit') ? input?.edits : [input];
  if (!Array.isArray(edits) || !edits.length) return;
  const hunks: string[] = [];
  const lines = (text: string) => (text ? text.replace(/\n$/, '').split('\n') : []);
  for (const edit of edits) {
    const before = request.title.startsWith('Write') ? '' : edit?.old_string;
    const after = request.title.startsWith('Write') ? edit?.content : edit?.new_string;
    if (typeof before !== 'string' || typeof after !== 'string') return;
    const a = lines(before),
      b = lines(after);
    hunks.push(
      [
        `@@ -${a.length ? 1 : 0},${a.length} +${b.length ? 1 : 0},${b.length} @@`,
        // An edit is a fragment of the file, so its own last line says nothing about the file's end.
        ...a.map((line) => `-${line}`),
        ...b.map((line) => `+${line}`),
      ].join('\n'),
    );
  }
  return { kind: 'diff', text: hunks.join('\n') };
}

/** Keep shared words quiet so the actual edit stands out, including punctuation and spacing. */
export function wordDiff(before: string, after: string): [Part[], Part[]] {
  const tokens = (text: string) =>
    text.match(/[\p{L}\p{N}_]+|[^\S\n]+|[^\p{L}\p{N}_\s]|\n/gu) ?? [];
  const a = tokens(before),
    b = tokens(after);
  const sameA = a.map(() => false),
    sameB = b.map(() => false);
  let start = 0,
    endA = a.length,
    endB = b.length;
  while (start < endA && start < endB && a[start] === b[start])
    sameA[start] = sameB[start++] = true;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1])
    sameA[--endA] = sameB[--endB] = true;
  const rows = endA - start,
    cols = endB - start;
  // Generated files can be enormous; keep their middle tinted rather than stall the panel.
  if (rows * cols <= 250_000 && rows && cols) {
    const lengths = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
    for (let i = rows - 1; i >= 0; i--)
      for (let j = cols - 1; j >= 0; j--)
        lengths[i]![j] =
          a[start + i] === b[start + j]
            ? 1 + lengths[i + 1]![j + 1]!
            : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    let i = 0,
      j = 0;
    while (i < rows && j < cols) {
      if (a[start + i] === b[start + j]) {
        sameA[start + i++] = sameB[start + j++] = true;
      } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++;
      else j++;
    }
  }
  const parts = (words: string[], same: boolean[]) => {
    const out: Part[] = [];
    words.forEach((text, i) => {
      const changed = !same[i],
        last = out.at(-1);
      if (last?.changed === changed) last.text += text;
      else out.push({ text, changed });
    });
    return out;
  };
  return [parts(a, sameA), parts(b, sameB)];
}

/** Compare whole replacement runs so an inserted line does not misalign the lines after it. */
export function diffLines(diff: string) {
  const lines = diff
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .map((text) => ({
      kind: text.startsWith('+')
        ? 'is-add'
        : text.startsWith('-')
          ? 'is-del'
          : text.startsWith('@@')
            ? 'is-hunk'
            : '',
      parts: [{ text, changed: false }],
    }));
  const paint = (indices: number[], parts: Part[]) => {
    for (const i of indices)
      lines[i]!.parts = [{ text: lines[i]!.parts[0]!.text[0]!, changed: false }];
    let row = 0;
    for (const part of parts)
      part.text.split('\n').forEach((text, i) => {
        if (i) row++;
        if (text) lines[indices[row]!]!.parts.push({ text, changed: part.changed });
      });
  };
  for (let i = 0; i < lines.length;) {
    if (lines[i]!.kind !== 'is-del') {
      i++;
      continue;
    }
    const removed: number[] = [],
      added: number[] = [];
    for (const [kind, indices] of [
      ['is-del', removed],
      ['is-add', added],
    ] as const) {
      while (i < lines.length) {
        if (lines[i]!.kind === kind) indices.push(i++);
        else if (lines[i]!.parts[0]!.text.startsWith('\\')) i++;
        else break;
      }
    }
    if (!added.length) continue;
    const text = (indices: number[]) =>
      indices.map((n) => lines[n]!.parts[0]!.text.slice(1)).join('\n');
    const [before, after] = wordDiff(text(removed), text(added));
    paint(removed, before);
    paint(added, after);
  }
  return lines;
}
