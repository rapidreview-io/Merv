/** Keep markdown as text so an agent's answer never becomes HTML. */
export type Block =
  | { kind: 'code'; language: string; text: string }
  | {
      kind: 'table';
      head: string[];
      rows: string[][];
      align: ('left' | 'center' | 'right' | null)[];
    }
  | { kind: 'math'; text: string }
  | { kind: 'heading' | 'paragraph'; text: string }
  /** start: the number an ordered list begins at, kept only when it is not 1. */
  | { kind: 'list'; ordered: boolean; items: string[]; start?: number };

/** Pipes inside code and escaped pipes belong to their cell. */
export function cells(line: string): string[] {
  const parts: string[] = [];
  let cell = '';
  let ticks = 0;
  const text = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (char === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      ticks = ticks === run ? 0 : ticks || run;
      cell += '`'.repeat(run);
      i += run - 1;
    } else if (char === '|' && !ticks) {
      parts.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  parts.push(cell.trim());
  return parts;
}

const fence = (line: string) => {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})([^\n]*)$/);
  if (!match || match[2]!.includes('`')) return null;
  match[2] = match[2]!.trim().split(/\s/, 1)[0]!;
  return match;
};
const list = (line: string) => line.match(/^\s*([-*+] |\d+\. )\s*(.*)$/);
const heading = (line: string) => line.match(/^\s{0,3}#{1,3}\s+([^\n]+?)(?:(?<!\s)\s+#+)?$/);
function table(lines: string[], i: number): Extract<Block, { kind: 'table' }>['align'] | undefined {
  if (!lines[i]?.includes('|') || !lines[i + 1]?.includes('|')) return;
  const separator = cells(lines[i + 1]!);
  if (
    separator.length !== cells(lines[i]!).length ||
    !separator.every((cell) => /^:?-{3,}:?$/.test(cell))
  )
    return;
  return separator.map((cell) =>
    cell.startsWith(':')
      ? cell.endsWith(':')
        ? 'center'
        : 'left'
      : cell.endsWith(':')
        ? 'right'
        : null,
  );
}

/** Cache the next display closer once: many unfinished openers must never rescan the tail. */
function displayMathEnds(lines: string[]): Map<number, number> {
  const ends = new Map<number, number>();
  let dollar: number | undefined, bracket: number | undefined;
  const closes = (text: string, marker: string) => {
    if (!text.endsWith(marker)) return false;
    let slashes = 0;
    for (let i = text.length - marker.length - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
    return slashes % 2 === 0;
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (fence(lines[i]!)) {
      dollar = undefined;
      bracket = undefined;
      continue;
    }
    const dollarEnd = closes(line, '$$'),
      bracketEnd = closes(line, '\\]');
    if (line.startsWith('$$')) {
      if (line.length >= 4 && dollarEnd) ends.set(i, i);
      else if (dollar !== undefined) ends.set(i, dollar);
    } else if (line.startsWith('\\[')) {
      if (bracketEnd) ends.set(i, i);
      else if (bracket !== undefined) ends.set(i, bracket);
    }
    if (dollarEnd) dollar = i;
    if (bracketEnd) bracket = i;
  }
  return ends;
}

export function markdown(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const mathEnds = displayMathEnds(lines);
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    const start = fence(line);
    if (start) {
      const code: string[] = [];
      const close = new RegExp(`^\\s{0,3}${start[1]![0]}{${start[1]!.length},}\\s*$`);
      for (i++; i < lines.length && !close.test(lines[i]!); i++) code.push(lines[i]!);
      if (i < lines.length) i++;
      blocks.push({ kind: 'code', language: start[2]!.toLowerCase(), text: code.join('\n') });
    } else if (mathEnds.has(i)) {
      const end = mathEnds.get(i)!;
      const math = lines.slice(i, end + 1);
      math[0] = math[0]!.trimStart().slice(2);
      math[math.length - 1] = math[math.length - 1]!.trimEnd().slice(0, -2);
      blocks.push({ kind: 'math', text: math.join('\n').trim() });
      i = end + 1;
    } else if (table(lines, i)) {
      const head = cells(line);
      const align = table(lines, i)!;
      const rows: string[][] = [];
      for (
        i += 2;
        i < lines.length &&
        lines[i]!.trim() &&
        lines[i]!.includes('|') &&
        !fence(lines[i]!) &&
        !mathEnds.has(i);
        i++
      ) {
        const row = cells(lines[i]!);
        // Do not expand short rows to header width: a wide header followed by many short rows
        // must remain proportional to the source, rather than header width times row count.
        rows.push(row.slice(0, head.length));
      }
      blocks.push({ kind: 'table', head, rows, align });
    } else if (heading(line)) {
      blocks.push({ kind: 'heading', text: heading(line)![1]! });
      i++;
    } else if (list(line)) {
      const ordered = /^\d/.test(list(line)![1]!);
      const items: string[] = [];
      for (
        ;
        i < lines.length && list(lines[i]!) && /^\d/.test(list(lines[i]!)![1]!) === ordered;
        i++
      )
        items.push(list(lines[i]!)![2]!);
      // A list that goes on after a paragraph or a code block keeps counting from where it was.
      const first = ordered ? Number.parseInt(list(line)![1]!, 10) : 1;
      blocks.push({
        kind: 'list',
        ordered,
        items,
        ...(first !== 1 && Number.isSafeInteger(first) && { start: first }),
      });
    } else if (line.trim()) {
      const para = [line];
      for (
        i++;
        i < lines.length &&
        lines[i]!.trim() &&
        !fence(lines[i]!) &&
        !mathEnds.has(i) &&
        !list(lines[i]!) &&
        !heading(lines[i]!) &&
        !table(lines, i);
        i++
      )
        para.push(lines[i]!);
      blocks.push({ kind: 'paragraph', text: para.join(' ') });
    } else i++;
  }
  return blocks;
}

/** Console output is kept readable; a block runs as one script, so a `cd` carries to the lines after
 *  it, and its one Run sits on its first command. Only prompt lines count when there are any. */
export function commands(
  language: string,
  text: string,
): { text: string; command?: string }[] | undefined {
  const lines = text.split('\n');
  const prompted = lines.some((line) => line.startsWith('$ '));
  if (
    !/^(sh|bash|zsh|shell|console)$/i.test(language) &&
    !lines.every((line) => line.startsWith('$ '))
  )
    return;
  const runnable = (line: string) =>
    prompted ? line.startsWith('$ ') : !!line.trim() && !line.trimStart().startsWith('#');
  const script = prompted
    ? lines
        .filter(runnable)
        .map((line) => line.slice(2))
        .join('\n')
    : text;
  const first = lines.findIndex(runnable);
  return lines.map((line, i) => ({ text: line, ...(i === first && { command: script }) }));
}

/** Interactive zsh does not enable comments by default. Keep quoted and heredoc data intact. */
export function terminalScript(script: string): string {
  const kept: string[] = [],
    docs: { end: string; tabs: boolean }[] = [];
  let quote = '',
    ansi = false,
    reading = false,
    continued = false,
    joined = false,
    arithmetic = 0,
    parameter = 0;
  for (const line of script.split('\n')) {
    if (reading) {
      kept.push(line);
      if ((docs[0]!.tabs ? line.replace(/^\t+/, '') : line) === docs[0]!.end) docs.shift();
      reading = docs.length > 0;
      continue;
    }
    if (
      !quote &&
      !continued &&
      !arithmetic &&
      !parameter &&
      (!line.trim() || line.trimStart().startsWith('#'))
    )
      continue;
    if (!continued) joined = false;
    kept.push(line);
    continued = false;
    let escaped = -1;
    for (let i = 0; i < line.length; i++) {
      const char = line[i]!;
      if (char === '\\' && (quote !== "'" || ansi)) {
        if (i === line.length - 1) continued = true;
        else escaped = i + 1;
        i++;
        continue;
      }
      if (quote) {
        if (char === quote) quote = '';
        continue;
      }
      if ('\'"`'.includes(char)) {
        quote = char;
        ansi = char === "'" && line[i - 1] === '$';
        continue;
      }
      if (arithmetic) {
        if (char === '(') arithmetic++;
        if (char === ')') arithmetic--;
        continue;
      }
      if (line.slice(i, i + 2) === '((') {
        arithmetic = 2;
        i++;
        continue;
      }
      if (line.slice(i, i + 2) === '${') {
        parameter++;
        i++;
        continue;
      }
      if (parameter) {
        if (char === '}') parameter--;
        continue;
      }
      if (char === '#' && (i === 0 ? !joined : i - 1 !== escaped && /[\s;|&]/.test(line[i - 1]!))) {
        kept[kept.length - 1] = line.slice(0, i).trimEnd();
        break;
      }
      if (line.slice(i, i + 2) !== '<<' || line[i + 2] === '<' || line[i - 1] === '<') continue;
      let j = i + 2,
        end = '',
        quoted = '';
      const tabs = line[j] === '-';
      if (tabs) j++;
      while (/\s/.test(line[j] ?? '') && j < line.length) j++;
      const start = j;
      for (; j < line.length; j++) {
        const next = line[j]!;
        if (next === '\\' && quoted !== "'") {
          end += line[++j] ?? '';
          continue;
        }
        if (quoted) {
          if (next === quoted) quoted = '';
          else end += next;
        } else if (next === '"' || next === "'") quoted = next;
        else if (/[\s;&|<>()]/.test(next)) break;
        else end += next;
      }
      if (j > start) {
        docs.push({ end, tabs });
        i = j - 1;
      }
    }
    if (continued && line.length > 1)
      joined = line.length - 2 === escaped || !/[\s;|&]/.test(line.at(-2)!);
    reading = docs.length > 0 && !quote && !continued;
  }
  return kept.join('\n');
}

export function filePath(text: string): { path: string; line?: number } | undefined {
  const match = text.match(
    /^((?:\.{0,2}\/)?[\w@+.-]+(?:\/[\w@+.-]+)*\.[a-zA-Z0-9]+)(?::([1-9]\d*))?$/,
  );
  return match ? { path: match[1]!, ...(match[2] && { line: Number(match[2]) }) } : undefined;
}

/** Shared with rendering. Bound failed links at their next opener; start paths only at token edges. */
const inlinePattern =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\[\]\n]+\]\([^\s()]+\)|https?:\/\/[^\s<>]+|(?<![\w@+./-])(?:\.{0,2}\/)?[\w@+.-]+(?:\/[\w@+.-]+)*\.[a-zA-Z0-9]+(?::[1-9]\d*)?)/g;

export type Inline =
  | { kind: 'text' | 'code' | 'math' | 'strong' | 'url' | 'file'; text: string }
  | { kind: 'link'; text: string; href: string };

/** Shared inline tokens keep search independent of renderer libraries. Delimiter positions and
 * legacy matches are scanned once; failed math openers never retry the remainder of the input. */
export function inlineTokens(text: string): Inline[] {
  const legacy = [...text.matchAll(inlinePattern)];
  const escaped = new Uint8Array(text.length);
  const dollars: number[] = [],
    parens: number[] = [],
    newlines: number[] = [];
  const ticks: { start: number; width: number; line: number }[] = [];
  let slashes = 0;
  for (let i = 0; i < text.length; i++) {
    escaped[i] = slashes % 2;
    const char = text[i]!;
    if (char === '$' && !escaped[i] && text[i - 1] !== '$' && text[i + 1] !== '$') dollars.push(i);
    if (char === '\\' && !escaped[i] && text[i + 1] === ')') parens.push(i);
    if (char === '\n' || char === '\r') newlines.push(i);
    if (char === '`' && text[i - 1] !== '`') {
      let width = 1;
      while (text[i + width] === '`') width++;
      ticks.push({ start: i, width, line: newlines.length });
    }
    slashes = char === '\\' ? slashes + 1 : 0;
  }
  const codeEnds = new Map<number, { end: number; width: number }>();
  const nextTick = new Map<number, { start: number; line: number }>();
  for (let t = ticks.length - 1; t >= 0; t--) {
    const tick = ticks[t]!,
      next = nextTick.get(tick.width);
    if (next?.line === tick.line && next.start > tick.start + tick.width)
      codeEnds.set(tick.start, { end: next.start, width: tick.width });
    nextTick.set(tick.width, tick);
  }
  const tokens: Inline[] = [];
  const plain = (value: string) => {
    if (!value) return;
    const previous = tokens.at(-1);
    if (previous?.kind === 'text') previous.text += value;
    else tokens.push({ kind: 'text', text: value });
  };
  let i = 0,
    from = 0,
    matchIndex = 0,
    dollarIndex = 0,
    parenIndex = 0,
    newlineIndex = 0;
  while (i < text.length) {
    const code = codeEnds.get(i);
    if (code) {
      plain(text.slice(from, i));
      tokens.push({ kind: 'code', text: text.slice(i + code.width, code.end) });
      i = code.end + code.width;
      from = i;
      continue;
    }
    while (matchIndex < legacy.length && legacy[matchIndex]!.index! < i) matchIndex++;
    const match = legacy[matchIndex];
    if (match?.index === i) {
      plain(text.slice(from, i));
      const piece = match[0];
      if (piece.startsWith('`')) tokens.push({ kind: 'code', text: piece.slice(1, -1) });
      else if (piece.startsWith('**')) tokens.push({ kind: 'strong', text: piece.slice(2, -2) });
      else if (piece.startsWith('[')) {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(piece)!;
        tokens.push({ kind: 'link', text: link[1]!, href: link[2]! });
      } else if (/^https?:\/\//.test(piece)) {
        let end = piece.length;
        while (end && '.,;!?)'.includes(piece[end - 1]!)) end--;
        const url = piece.slice(0, end);
        tokens.push({ kind: 'url', text: url });
        plain(piece.slice(url.length));
      } else tokens.push({ kind: 'file', text: piece });
      i += piece.length;
      from = i;
      matchIndex++;
      continue;
    }
    while (newlineIndex < newlines.length && newlines[newlineIndex]! < i) newlineIndex++;
    while (dollarIndex < dollars.length && dollars[dollarIndex]! <= i) dollarIndex++;
    while (parenIndex < parens.length && parens[parenIndex]! <= i + 1) parenIndex++;
    const lineEnd = newlines[newlineIndex] ?? text.length;
    const dollar =
      text[i] === '$' &&
      !escaped[i] &&
      text[i - 1] !== '$' &&
      text[i + 1] !== '$' &&
      !!text[i + 1] &&
      !/\s/.test(text[i + 1]!);
    const paren = text[i] === '\\' && !escaped[i] && text[i + 1] === '(';
    const end = dollar ? dollars[dollarIndex] : paren ? parens[parenIndex] : undefined;
    const width = dollar ? 1 : 2;
    const validClose =
      end !== undefined &&
      (!dollar || (!/\s/.test(text[end - 1]!) && !/\d/.test(text[end + 1] ?? '')));
    if (validClose && end !== undefined && end < lineEnd && end > i + width) {
      plain(text.slice(from, i));
      tokens.push({ kind: 'math', text: text.slice(i + width, end) });
      i = end + width;
      from = i;
    } else if (text[i] === '\\' && !escaped[i] && text[i + 1] === '$') {
      plain(text.slice(from, i));
      plain('$');
      i += 2;
      from = i;
    } else i++;
  }
  plain(text.slice(from));
  return tokens;
}

function inlineText(text: string): string {
  return inlineTokens(text)
    .map((token) => (token.kind === 'strong' ? inlineText(token.text) : token.text))
    .join('');
}

/** One string per searchable rendered block. Phrases never span separate paragraphs/cells. */
export function renderedMarkdownBlocks(text: string): string[] {
  return markdown(text).flatMap((block) => {
    if (block.kind === 'table') return [...block.head, ...block.rows.flat()].map(inlineText);
    if (block.kind === 'list') return block.items.map(inlineText);
    if (block.kind === 'code') {
      const lines = commands(block.language, block.text);
      return lines
        ? [block.language || 'shell', ...lines.map((line) => line.text || ' ')]
        : [block.language, block.text];
    }
    if (block.kind === 'math') return [block.text];
    return [inlineText(block.text)];
  });
}
