import { Fragment, memo, useMemo, useRef, type ReactNode } from 'react';
import { Link, useHref } from 'react-router-dom';
import { useTool } from './api';

/**
 * Briefs, deliveries and reports are written in Markdown, and they are most of
 * what a person reads here, so they are read as documents rather than as source.
 * The file is three parts kept apart on purpose: a pure parser to a small tree
 * (`parseMarkdown`, which never throws and never sees the DOM), the names of the
 * records a text mentions (`recordNames`, `RecordLink`), and one component that
 * draws the tree as React elements. Nothing is ever handed to the browser as
 * HTML: a tag an author wrote is text, an image is a link that loads nothing, and
 * an address the app would not open itself never becomes an href.
 */

export type Align = 'left' | 'center' | 'right' | null;
export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong' | 'em' | 'del'; children: Inline[] }
  | { type: 'link'; href: string; external: boolean; title?: string; children: Inline[] }
  | { type: 'break' }
  | { type: 'id'; id: string };
export interface ListItem {
  /** A task-list box: true or false where the author drew one, absent otherwise. */
  checked?: boolean;
  children: Block[];
}
export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'code'; lang?: string; value: string }
  | { type: 'quote'; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; loose: boolean; items: ListItem[] }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: 'rule' };

/* Record ids ------------------------------------------------------------- */

/**
 * Every id this system mints is `newId(prefix)`: a lowercase prefix, an underscore
 * and a UUID's 32 hex digits (`art_…`, `wf_…`, `review_…`, `claim_…`, `exp_sub_…`).
 * The shape is recognised whole, so a prefix a later plugin adds is still shortened
 * rather than printed, and only the prefixes below know where they lead.
 */
const ID = '[a-z][a-z_]{0,30}_[0-9a-f]{32}(?![0-9A-Za-z_])';
const ID_AT = new RegExp(ID, 'y');
const ID_ANYWHERE = new RegExp(`(?<![0-9A-Za-z_])(${ID})`, 'g');
/** The prefixes whose id alone says which page opens it; a `wf_` may be any of five kinds. */
const ROUTE_OF_PREFIX: Record<string, string> = { art: '/artifacts', review: '/reviews' };

export const prefixOf = (id: string) => id.slice(0, id.lastIndexOf('_'));
/** Where an id leads when nothing but its shape is known. */
export const recordRoute = (id: string): string | undefined => {
  const route = ROUTE_OF_PREFIX[prefixOf(id)];
  return route && `${route}/${id}`;
};
/** What stands for an id nobody could name: its prefix and its last six. */
export const shortId = (id: string) => `${prefixOf(id)}_…${id.slice(-6)}`;
/** A text cut at its ids: even places are the author's words, odd places are ids. */
export const splitIds = (text: string): string[] => text.split(ID_ANYWHERE);
/** The ids a text mentions, once each. */
export const idsIn = (text: string): string[] => [
  ...new Set(splitIds(text).filter((_, at) => at % 2)),
];

/** A record a page can name, and where reading it continues. */
export interface Named {
  name: string;
  to?: string;
}
export type RecordNames = ReadonlyMap<string, Named>;

/** The two reads that name records: the file list, and the lists `ui.home` composes. */
interface NamedFile {
  id: string;
  title: string;
}
export interface NamedHome {
  actors?: { id: string; name: string }[] | null;
  experiments?: { id: string; name: string }[] | null;
  tasks?: { id: string; title: string }[] | null;
  cycles?: { id: string; name: string }[] | null;
  reflections?: { id: string; title: string }[] | null;
  reviews?: { id: string; subjectId: string }[] | null;
}

/**
 * Names for the ids a text mentions, from lists the app already reads. A review is
 * named by what it judges, so reviews are read after the records they point at; a person
 * is a name and no link. An id no list names is simply absent from the map.
 */
export function recordNames(files?: NamedFile[] | null, home?: NamedHome | null): RecordNames {
  const names = new Map<string, Named>();
  for (const file of files ?? [])
    names.set(file.id, { name: file.title, to: `/artifacts/${file.id}` });
  for (const task of home?.tasks ?? [])
    names.set(task.id, { name: task.title, to: `/tasks/${task.id}` });
  for (const experiment of home?.experiments ?? [])
    names.set(experiment.id, { name: experiment.name, to: `/experiments/${experiment.id}` });
  for (const cycle of home?.cycles ?? [])
    names.set(cycle.id, { name: cycle.name, to: `/research/${cycle.id}` });
  for (const reflection of home?.reflections ?? [])
    names.set(reflection.id, { name: reflection.title, to: `/reflections/${reflection.id}` });
  for (const actor of home?.actors ?? [])
    // A directory name that is itself an identifier names nobody.
    if (!/[0-9a-f]{16,}/.test(actor.name)) names.set(actor.id, { name: actor.name });
  for (const review of home?.reviews ?? []) {
    const subject = names.get(review.subjectId);
    if (subject)
      names.set(review.id, { name: `Review of ${subject.name}`, to: `/reviews/${review.id}` });
  }
  return names;
}

/**
 * The names for one text, read only when the text mentions something to name: the
 * file list for an `art_`, the home read for anything else. Both are questions the
 * page around the text already asks, so this joins their answers instead of adding
 * a read of its own, and a text with no ids in it costs nothing at all.
 */
export function useRecordNames(text: string): RecordNames {
  const ids = useMemo(() => idsIn(text), [text]);
  const files = useTool<NamedFile[]>(
    ids.some((id) => prefixOf(id) === 'art') ? 'artifact.list' : null,
  );
  const home = useTool<NamedHome>(ids.some((id) => prefixOf(id) !== 'art') ? 'ui.home' : null);
  return useMemo(() => recordNames(files.data, home.data), [files.data, home.data]);
}

/**
 * One id, as a person should meet it: the record's name where a list names it, a
 * short form in the mono where none does, a link wherever a route is known, and the
 * id itself only in the hover title. `plain` draws it inside something that is
 * already a link.
 */
export function RecordLink({
  id,
  names,
  plain,
}: {
  id: string;
  names?: RecordNames;
  plain?: boolean;
}) {
  const found = names?.get(id);
  const to = found?.to ?? recordRoute(id);
  const said = found?.name ?? shortId(id);
  const className = found ? 'record-link' : 'record-link record-link--id';
  return to && !plain ? (
    <Link className={className} to={to} title={id}>
      {said}
    </Link>
  ) : (
    <span className={className} title={id}>
      {said}
    </span>
  );
}

/**
 * A plain text with the ids in it named and linked; everything else as it was written.
 * `plain` names them without linking, where the text already stands inside a control.
 */
export function RecordText({
  text,
  names,
  plain,
}: {
  text: string;
  names?: RecordNames;
  plain?: boolean;
}) {
  return (
    <>
      {splitIds(text).map((piece, at) =>
        at % 2 ? <RecordLink key={at} id={piece} names={names} plain={plain} /> : piece,
      )}
    </>
  );
}

/* Links ------------------------------------------------------------------ */

/**
 * The only addresses that become an href: http, https, mailto, and a relative one,
 * which can only stay on this origin. Whitespace and control characters go first,
 * because a browser ignores them inside a scheme and `java\tscript:` must not pass;
 * anything else — javascript:, data:, vbscript:, file: — is refused and its text stays.
 */
export function safeHref(raw: string): { href: string; external: boolean } | null {
  // eslint-disable-next-line no-control-regex
  const href = raw.replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]/g, '');
  if (!href) return null;
  // A browser reads a backslash as a slash, so `/\host` is another origin too.
  if (/^[/\\]{2}/.test(href))
    return { href: `https:${href.replaceAll('\\', '/')}`, external: true };
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)?.[1]?.toLowerCase();
  if (scheme === undefined) return { href, external: false };
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto'
    ? { href, external: true }
    : null;
}

/* Inline ----------------------------------------------------------------- */

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'node'; node: Inline }
  | { kind: 'mark'; char: string; count: number; run: number; opens: boolean; closes: boolean };
type Mark = Extract<Token, { kind: 'mark' }>;

/** Past this the document is treated as text rather than parsed any deeper. */
const MAX_DEPTH = 8;
/** Emphasis is matched by looking back; a line of a thousand asterisks is not worth it. */
const MAX_MARKS = 400;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const URL_AT = /https?:\/\/[^\s<>]+/y;
/** What stands between two angle brackets; whether it is an address is asked of it afterwards. */
const ANGLE_AT = /<([^\s<>]+)>/y;
const wordy = (char: string | undefined) => !!char && /[0-9A-Za-z_]/.test(char);
const spacey = (char: string | undefined) => !char || /\s/.test(char);
const punct = (char: string | undefined) => !!char && /[\p{P}\p{S}]/u.test(char);
const literal = (value: string): Inline => ({ type: 'text', value });

/**
 * What one run of text is searched for, found once. A code span closes at the next
 * run of backticks as long as the one that opened it, and a link's label at the
 * bracket that matches its own. Looking for either by walking to the end of the
 * paragraph, again from every bracket in it, is what let a two-kilobyte post hold
 * the page for seconds; so the runs are listed by their length and the brackets
 * are matched in one pass with a stack, and every question after that is a lookup.
 */
interface Scan {
  source: string;
  /** Where every run of backticks starts, by the length of the run. */
  ticks: Map<number, number[]>;
  /** The bracket that closes each opening one; -1 where none does. */
  closes: Map<number, number>;
  passes: number;
}
/**
 * One pass matches every bracket after it, so a second is needed only where the
 * text was read differently the first time (a bracket the pass took for code).
 */
const MAX_PASSES = 16;
/** No address anyone follows is longer; past it a destination is not looked for. */
const MAX_DEST = 2000;

function scanOf(source: string): Scan {
  const ticks = new Map<number, number[]>();
  for (let at = source.indexOf('`'); at >= 0;) {
    let run = 1;
    while (source[at + run] === '`') run++;
    const starts = ticks.get(run);
    if (starts) starts.push(at);
    else ticks.set(run, [at]);
    at = source.indexOf('`', at + run);
  }
  return { source, ticks, closes: new Map(), passes: 0 };
}

/** Where the code span opening at `at` ends: after the next run of as many backticks. */
function codeEnd({ source, ticks }: Scan, at: number): number {
  let run = 0;
  while (source[at + run] === '`') run++;
  const starts = ticks.get(run) ?? [];
  let low = 0;
  for (let high = starts.length; low < high;) {
    const middle = (low + high) >> 1;
    if (starts[middle]! < at + run) low = middle + 1;
    else high = middle;
  }
  return low < starts.length ? starts[low]! + run : -1;
}

/** The code span opening at `at`, closed by a run of backticks of the same length. */
function codeAt(scan: Scan, at: number): { value: string; end: number } | null {
  const end = codeEnd(scan, at);
  if (end < 0) return null;
  let run = 0;
  while (scan.source[at + run] === '`') run++;
  const value = scan.source.slice(at + run, end - run).replaceAll('\n', ' ');
  const padded = value.length > 2 && value.startsWith(' ') && value.endsWith(' ');
  return { value: padded && value.trim() ? value.slice(1, -1) : value, end };
}

/** The bracket that closes the one at `at`, reading escapes and code as the text does. */
function closeOf(scan: Scan, at: number): number {
  const { source, closes } = scan;
  if (!closes.has(at) && scan.passes < MAX_PASSES) {
    scan.passes++;
    const open: number[] = [];
    for (let to = at; to < source.length; to++) {
      const char = source[to];
      if (char === '\\') to++;
      else if (char === '`') {
        const end = codeEnd(scan, to);
        // A run that opens nothing is text, all of it, as it is to the line around it.
        if (end < 0) while (source[to + 1] === '`') to++;
        else to = end - 1;
      } else if (char === '[') {
        open.push(to);
        closes.set(to, -1);
      } else if (char === ']' && open.length) closes.set(open.pop()!, to);
    }
  }
  return closes.get(at) ?? -1;
}

const white = (char: string) => (char > ' ' && char < '\u0080' ? false : /\s/.test(char));

/** `[label](destination "title")` opening at the bracket at `at`, or nothing. */
function linkAt(
  scan: Scan,
  at: number,
): { label: string; dest: string; title?: string; end: number } | null {
  const { source } = scan;
  const close = closeOf(scan, at);
  if (close < 0 || source[close + 1] !== '(') return null;
  let to = close + 2;
  const skip = () => {
    while (to < source.length && white(source[to]!)) to++;
  };
  skip();
  let dest = '';
  if (source[to] === '<') {
    // Between angle brackets an address holds neither of them and stays on its line,
    // so the way to its end is never longer than to the next of the three.
    let end = to + 1;
    while (end < source.length && !'<>\n'.includes(source[end]!)) end++;
    if (source[end] !== '>') return null;
    dest = source.slice(to + 1, end);
    to = end + 1;
  } else {
    const from = to;
    for (let open = 0; to < source.length; to++) {
      const char = source[to]!;
      if (to - from > MAX_DEST) return null;
      if (char === '\\' && to + 1 < source.length) to++;
      else if (white(char) || (char === ')' && open === 0)) break;
      else if (char === '(') open++;
      else if (char === ')') open--;
    }
    dest = source.slice(from, to).replace(/\\([^])/g, '$1');
  }
  skip();
  let title: string | undefined;
  const quote = source[to];
  if (quote === '"' || quote === "'") {
    const end = source.indexOf(quote, to + 1);
    if (end < 0) return null;
    title = source.slice(to + 1, end);
    to = end + 1;
    skip();
  }
  if (source[to] !== ')') return null;
  return { label: source.slice(at + 1, close), dest, title, end: to + 1 };
}

/** A bare address ends before the punctuation of the sentence it sits in. */
function trimUrl(url: string): string {
  // Nothing taken off the end is an opening bracket, so whether one came before is asked once.
  const bracketed = url.includes('(');
  let end = url.length;
  for (; end > 0; end--) {
    const last = url[end - 1]!;
    if (/[.,;:!?'"*_~]/.test(last)) continue;
    if (last === ')' && !bracketed) continue;
    break;
  }
  return url.slice(0, end);
}

/** `<scheme:address>` or `<name@host.tld>` opening at `at`: what stands between the brackets. */
function angleAt(source: string, at: number): string | null {
  ANGLE_AT.lastIndex = at;
  const inner = ANGLE_AT.exec(source)?.[1];
  if (!inner) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(inner)) return inner;
  const sign = inner.indexOf('@');
  const dot = inner.indexOf('.', sign + 2);
  const mail = sign > 0 && sign === inner.lastIndexOf('@') && dot > 0 && dot < inner.length - 1;
  return mail ? inner : null;
}

/** Adjacent text joined, and any mark that matched nothing returned to the text it was. */
function settle(tokens: Token[]): Inline[] {
  const out: Inline[] = [];
  for (const token of tokens) {
    const node =
      token.kind === 'node'
        ? token.node
        : literal(token.kind === 'text' ? token.value : token.char.repeat(token.count));
    const last = out[out.length - 1];
    if (node.type === 'text' && last?.type === 'text') last.value += node.value;
    else if (node.type !== 'text' || node.value) out.push(node);
  }
  return out;
}

/**
 * Emphasis the way CommonMark pairs it: each closing run looks back for the nearest
 * run of the same character that may open, two of each make strong and one makes em,
 * and what is left of either run stays in play — which is what lets `***both***` and
 * `**bold *and* more**` come out right. A run that pairs with nothing is text.
 */
function emphasise(tokens: Token[]): Inline[] {
  if (tokens.filter((token) => token.kind === 'mark').length > MAX_MARKS) return settle(tokens);
  for (let at = 0; at < tokens.length;) {
    const closer = tokens[at]!;
    if (closer.kind !== 'mark' || !closer.closes) {
      at++;
      continue;
    }
    let found = -1;
    for (let back = at - 1; back >= 0 && found < 0; back--) {
      const opener = tokens[back]!;
      if (opener.kind !== 'mark' || !opener.opens || opener.char !== closer.char) continue;
      // The rule of three: `*a**b*` is one emphasis, not an emphasis and a stray pair.
      const both = opener.closes || closer.opens;
      if (both && (opener.run + closer.run) % 3 === 0 && (opener.run % 3 || closer.run % 3))
        continue;
      found = back;
    }
    if (found < 0) {
      if (!closer.opens) tokens[at] = { kind: 'text', value: closer.char.repeat(closer.count) };
      at++;
      continue;
    }
    const opener = tokens[found] as Mark;
    const use = closer.char === '~' || (opener.count >= 2 && closer.count >= 2) ? 2 : 1;
    const node: Inline = {
      type: closer.char === '~' ? 'del' : use === 2 ? 'strong' : 'em',
      children: settle(tokens.slice(found + 1, at)),
    };
    opener.count -= use;
    closer.count -= use;
    const kept: Token[] = [
      ...(opener.count ? [opener] : []),
      { kind: 'node', node },
      ...(closer.count ? [closer] : []),
    ];
    tokens.splice(found, at - found + 1, ...kept);
    // What is left of the closer closes again; otherwise reading goes on after the node.
    at = found + (opener.count ? 2 : 1);
  }
  return settle(tokens);
}

/**
 * One run of text to its inline tree. Agents write one fact per line, so a single
 * newline is a line break here and not a space; a record id becomes its own node in
 * text and inside a code span alike, so the renderer can name it. A link holds no
 * link: inside a label (`linked`) an address stays text and a link or an image is
 * only the words it reads as, so a badge opens what its link names, not its picture.
 */
export function parseInline(source: string, depth = 0, linked = false): Inline[] {
  const scan = scanOf(source);
  const tokens: Token[] = [];
  let held = '';
  const push = (node: Inline) => {
    if (held) tokens.push({ kind: 'text', value: held });
    held = '';
    tokens.push({ kind: 'node', node });
  };
  for (let at = 0; at < source.length;) {
    const char = source[at]!;
    const before = source[at - 1];
    if (char === '\\') {
      const next = source[at + 1];
      if (next === '\n') {
        at++;
        continue;
      }
      held += next && ESCAPABLE.test(next) ? next : char;
      at += next && ESCAPABLE.test(next) ? 2 : 1;
      continue;
    }
    if (char === '\n') {
      let end = held.length;
      while (end > 0 && (held[end - 1] === ' ' || held[end - 1] === '\t')) end--;
      held = held.slice(0, end);
      push({ type: 'break' });
      at++;
      while (source[at] === ' ' || source[at] === '\t') at++;
      continue;
    }
    if (char === '`') {
      const code = codeAt(scan, at);
      if (code) {
        splitIds(code.value).forEach((piece, index) => {
          if (index % 2) push({ type: 'id', id: piece });
          else if (piece) push({ type: 'code', value: piece });
        });
        at = code.end;
        continue;
      }
      while (source[at] === '`') held += source[at++];
      continue;
    }
    if (char === '[' || (char === '!' && source[at + 1] === '[')) {
      const image = char === '!';
      const link = depth < MAX_DEPTH ? linkAt(scan, image ? at + 1 : at) : null;
      if (link) {
        // An image loads nothing: it is a link that reads as its alt text.
        const children = image
          ? [literal(link.label || link.dest)]
          : parseInline(link.label, depth + 1, true);
        const safe = !linked && safeHref(link.dest);
        if (safe) push({ type: 'link', ...safe, title: link.title, children });
        else for (const child of children) push(child);
        at = link.end;
        continue;
      }
    }
    if (char === '<' && !linked) {
      const address = angleAt(source, at);
      const safe = address && safeHref(address.includes(':') ? address : `mailto:${address}`);
      if (address && safe) {
        push({ type: 'link', ...safe, children: [literal(address)] });
        at += address.length + 2;
        continue;
      }
    }
    if (!wordy(before) && /[a-z]/.test(char)) {
      ID_AT.lastIndex = at;
      const id = ID_AT.exec(source)?.[0];
      if (id) {
        push({ type: 'id', id });
        at += id.length;
        continue;
      }
      URL_AT.lastIndex = at;
      const url = linked ? '' : trimUrl(URL_AT.exec(source)?.[0] ?? '');
      const safe = url && safeHref(url);
      if (safe) {
        push({ type: 'link', ...safe, children: [literal(url)] });
        at += url.length;
        continue;
      }
    }
    if (char === '*' || char === '_' || char === '~') {
      let run = 1;
      while (source[at + run] === char) run++;
      const after = source[at + run];
      const left = !spacey(after) && (!punct(after) || spacey(before) || punct(before));
      const right = !spacey(before) && (!punct(before) || spacey(after) || punct(after));
      // An underscore inside a word is part of the word: snake_case stays as written.
      const opens = char === '_' ? left && (!right || punct(before)) : left;
      const closes = char === '_' ? right && (!left || punct(after)) : right;
      if ((char !== '~' || run === 2) && (opens || closes)) {
        if (held) tokens.push({ kind: 'text', value: held });
        held = '';
        tokens.push({ kind: 'mark', char, count: run, run, opens, closes });
      } else held += char.repeat(run);
      at += run;
      continue;
    }
    held += char;
    at++;
  }
  if (held) tokens.push({ kind: 'text', value: held });
  return emphasise(tokens);
}

/* Blocks ----------------------------------------------------------------- */

/*
 * A line is matched from its start and never searched: no pattern here may try the
 * same stretch of spaces two ways, or a line of eighty thousand of them would be
 * read eighty thousand times. So the rest of a line is `[^]*`, which cannot fail,
 * a heading's closing hashes come off by hand, and a divider is tested trimmed.
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})([^]*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:( +)([^]*))?$/;
const DIVIDER = /^ {0,3}\|?[ \t]*:?-+:?(?:[ \t]*\|[ \t]*:?-+:?)*[ \t]*\|?$/;
const blank = (line: string | undefined) => !line || !line.trim();
const indentOf = (line: string) => line.length - line.trimStart().length;
const gap = (char: string | undefined) => char === ' ' || char === '\t';

/** A heading's words: what follows its hashes, less the closing run of them it may end with. */
function headingText(rest: string): string {
  let end = rest.length;
  while (end > 0 && gap(rest[end - 1])) end--;
  let hashes = end;
  while (hashes > 0 && rest[hashes - 1] === '#') hashes--;
  if (hashes < end && (hashes === 0 || gap(rest[hashes - 1]))) end = hashes;
  while (end > 0 && gap(rest[end - 1])) end--;
  return rest.slice(0, end);
}

/** A table row cut at its pipes; `\|` is a pipe the author meant to keep. */
function cellsOf(line: string): string[] {
  const row = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|'));
}
/** A header row, then a divider row with as many columns: that and nothing less is a table. */
function tableAt(lines: string[], at: number): Align[] | null {
  const head = lines[at]!;
  const divider = lines[at + 1];
  if (!head.includes('|') || !divider?.includes('|') || !DIVIDER.test(divider.trimEnd()))
    return null;
  const marks = cellsOf(divider);
  if (marks.length !== cellsOf(head).length) return null;
  return marks.map((mark) =>
    mark.endsWith(':')
      ? mark.startsWith(':')
        ? 'center'
        : 'right'
      : mark.startsWith(':')
        ? 'left'
        : null,
  );
}
/** Whether this line ends the paragraph above it without a blank line between them. */
function interrupts(lines: string[], at: number): boolean {
  const line = lines[at]!;
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const item = ITEM.exec(line);
  // Only a list that starts at one may cut into a paragraph: "…in\n1986. A year" is prose.
  if (item?.[4]?.trim() && (!/\d/.test(item[2]!) || parseInt(item[2]!, 10) === 1)) return true;
  return !!tableAt(lines, at);
}

/**
 * A list, from its first marker to the first line that is neither one of its items
 * nor indented under one. Indentation is read generously — two spaces under a marker
 * nest, whatever the marker's own width — because that is how agents write them; a
 * line back at the margin ends the list rather than being folded into its last item.
 */
function listAt(lines: string[], from: number, depth: number): { block: Block; next: number } {
  const first = ITEM.exec(lines[from]!)!;
  const ordered = /\d/.test(first[2]!);
  const family = ordered ? first[2]!.slice(-1) : first[2]!;
  const items: ListItem[] = [];
  let loose = false;
  let at = from;
  while (at < lines.length) {
    const found = RULE.test(lines[at]!) ? null : ITEM.exec(lines[at]!);
    if (!found || /\d/.test(found[2]!) !== ordered) break;
    if ((ordered ? found[2]!.slice(-1) : found[2]!) !== family) break;
    const gap = found[3]?.length ?? 1;
    const width = found[1]!.length + found[2]!.length + (gap > 4 ? 1 : gap);
    const under = Math.min(width, found[1]!.length + 2);
    const body = [lines[at]!.slice(width)];
    for (at++; at < lines.length; at++) {
      let next = at;
      while (next < lines.length && blank(lines[next])) next++;
      if (next >= lines.length || indentOf(lines[next]!) < under) break;
      for (; at < next; at++) body.push('');
      body.push(lines[at]!.slice(Math.min(indentOf(lines[at]!), width)));
    }
    const box = /^\[([ xX])\](?:[ \t]+|$)/.exec(body[0]!);
    if (box) body[0] = body[0]!.slice(box[0].length);
    if (body.some((line, index) => index > 0 && blank(line))) loose = true;
    items.push({
      ...(box ? { checked: box[1] !== ' ' } : {}),
      children: parseBlocks(body, depth + 1),
    });
    let next = at;
    while (next < lines.length && blank(lines[next])) next++;
    if (next === at) continue;
    // Blank lines between two items make the list loose; before anything else they end it.
    const sibling = next < lines.length && !RULE.test(lines[next]!) && ITEM.exec(lines[next]!);
    if (!sibling || /\d/.test(sibling[2]!) !== ordered) break;
    loose = true;
    at = next;
  }
  const start = ordered ? parseInt(first[2]!, 10) : 1;
  return { block: { type: 'list', ordered, start, loose, items }, next: at };
}

function parseBlocks(lines: string[], depth: number): Block[] {
  if (depth > MAX_DEPTH) {
    const rest = lines.join('\n').trim();
    return rest ? [{ type: 'paragraph', children: [literal(rest)] }] : [];
  }
  const blocks: Block[] = [];
  for (let at = 0; at < lines.length;) {
    const line = lines[at]!;
    if (blank(line)) {
      at++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence && !(fence[1]!.startsWith('`') && fence[2]!.includes('`'))) {
      const open = fence[1]!;
      const closing = new RegExp(`^ {0,3}${open[0]}{${open.length},}[ \\t]*$`);
      const inset = indentOf(line);
      const body: string[] = [];
      for (at++; at < lines.length && !closing.test(lines[at]!); at++)
        body.push(lines[at]!.slice(Math.min(indentOf(lines[at]!), inset)));
      at++;
      const lang = fence[2]!.trim().split(/\s+/)[0];
      blocks.push({ type: 'code', ...(lang ? { lang } : {}), value: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1]!.length,
        children: parseInline(headingText(line.slice(heading[0].length))),
      });
      at++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      at++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      for (; at < lines.length && QUOTE.test(lines[at]!); at++)
        body.push(lines[at]!.replace(QUOTE, ''));
      blocks.push({ type: 'quote', children: parseBlocks(body, depth + 1) });
      continue;
    }
    if (ITEM.test(line)) {
      const list = listAt(lines, at, depth);
      blocks.push(list.block);
      at = list.next;
      continue;
    }
    if (indentOf(line) >= 4) {
      const body: string[] = [];
      for (; at < lines.length && (blank(lines[at]) || indentOf(lines[at]!) >= 4); at++)
        body.push(lines[at]!.slice(4));
      while (body.length && blank(body[body.length - 1])) body.pop();
      blocks.push({ type: 'code', value: body.join('\n') });
      continue;
    }
    const align = tableAt(lines, at);
    if (align) {
      const row = (source: string) => {
        const cells = cellsOf(source);
        return align.map((_, column) => parseInline(cells[column] ?? ''));
      };
      const head = row(line);
      const rows: Inline[][][] = [];
      for (at += 2; at < lines.length && !blank(lines[at]) && lines[at]!.includes('|'); at++)
        rows.push(row(lines[at]!));
      blocks.push({ type: 'table', align, head, rows });
      continue;
    }
    const body = [line.trim()];
    for (at++; at < lines.length && !blank(lines[at]) && !interrupts(lines, at); at++)
      body.push(lines[at]!.trim());
    blocks.push({ type: 'paragraph', children: parseInline(body.join('\n')) });
  }
  return blocks;
}

/**
 * Markdown source to its tree. Pure, and total: whatever it is given — half a table,
 * an unclosed fence, a thousand nested quotes, no Markdown at all — it answers with
 * blocks, and a text it cannot read as anything else is a paragraph of that text.
 */
export function parseMarkdown(source: string): Block[] {
  try {
    const lines = source
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/^[ \t]+/, (lead) => lead.replaceAll('\t', '    ')));
    return parseBlocks(lines, 0);
  } catch {
    return source.trim() ? [{ type: 'paragraph', children: [literal(source)] }] : [];
  }
}

/* Rendering --------------------------------------------------------------- */

/**
 * An address an author wrote from the root is a page of this app, so it goes through
 * the router: it keeps the base the app is served under whether or not the author
 * wrote that base, and opening it does not reload the page.
 */
function Within({ href, title, children }: { href: string; title?: string; children: ReactNode }) {
  const base = useHref('/').replace(/\/$/, '');
  const to =
    base && (href === base || href.startsWith(`${base}/`)) ? href.slice(base.length) : href;
  return (
    <Link to={to || '/'} title={title}>
      {children}
    </Link>
  );
}

function inlines(nodes: Inline[], names: RecordNames | undefined, linked = false): ReactNode[] {
  return nodes.map((node, key) => {
    switch (node.type) {
      case 'text':
        return node.value;
      case 'code':
        return <code key={key}>{node.value}</code>;
      case 'strong':
        return <strong key={key}>{inlines(node.children, names, linked)}</strong>;
      case 'em':
        return <em key={key}>{inlines(node.children, names, linked)}</em>;
      case 'del':
        return <del key={key}>{inlines(node.children, names, linked)}</del>;
      case 'break':
        return <br key={key} />;
      case 'id':
        return <RecordLink key={key} id={node.id} names={names} plain={linked} />;
      case 'link': {
        const experimentId = /^\/experiments\/([^/?#]+)(?:[?#].*)?$/.exec(node.href)?.[1];
        const label = experimentId ? names?.get(experimentId)?.name : undefined;
        return node.external || !node.href.startsWith('/') ? (
          <a
            key={key}
            href={node.href}
            title={node.title}
            {...(node.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {inlines(node.children, names, true)}
          </a>
        ) : (
          <Within key={key} href={node.href} title={node.title}>
            {label ?? inlines(node.children, names, true)}
          </Within>
        );
      }
    }
  });
}

/**
 * A document's own headings sit under the heading of whatever holds it — the page's
 * h2 unless the host says it stands deeper — and never beside or above that title.
 */
type HeadingTag = 'h3' | 'h4' | 'h5' | 'h6';
const headingTag = (under: number, level: number) => `h${Math.min(6, under + level)}` as HeadingTag;
const aligned = (align: Align) => (align && align !== 'left' ? `md-${align}` : undefined);

function blocks(nodes: Block[], names: RecordNames | undefined, under: number): ReactNode[] {
  return nodes.map((node, key) => {
    switch (node.type) {
      case 'heading': {
        const Tag = headingTag(under, node.level);
        return (
          <Tag key={key} className={`md-h md-h${Math.min(node.level, 4)}`}>
            {inlines(node.children, names)}
          </Tag>
        );
      }
      case 'paragraph':
        return <p key={key}>{inlines(node.children, names)}</p>;
      case 'code':
        return (
          <pre key={key} data-lang={node.lang}>
            <code>{node.value}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={key}>{blocks(node.children, names, under)}</blockquote>;
      case 'rule':
        return <hr key={key} />;
      case 'list': {
        const items = node.items.map((item, index) => {
          // A tight list reads as lines, not as paragraphs with space between them.
          const body = item.children.flatMap((child, at) =>
            child.type === 'paragraph' && !node.loose
              ? [<span key={at}>{inlines(child.children, names)}</span>]
              : [<Fragment key={at}>{blocks([child], names, under)}</Fragment>],
          );
          return item.checked === undefined ? (
            <li key={index}>{body}</li>
          ) : (
            <li key={index} className="md-task">
              <input type="checkbox" checked={item.checked} disabled readOnly />
              <div>{body}</div>
            </li>
          );
        });
        return node.ordered ? (
          <ol key={key} start={node.start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      case 'table':
        return (
          <div key={key} className="md-table">
            <table>
              <thead>
                <tr>
                  {node.head.map((cell, column) => (
                    <th key={column} scope="col" className={aligned(node.align[column]!)}>
                      {inlines(cell, names)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {node.rows.map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, column) => (
                      <td key={column} className={aligned(node.align[column]!)}>
                        {inlines(cell, names)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/**
 * Past this a text is shown as it was typed rather than read: the parser's work is
 * bounded for every line of it, but a page should not spend a second of its one
 * thread drawing a file nobody reads top to bottom.
 */
export const MAX_READ = 200_000;

/**
 * A Markdown text, read. `names` is the map a page already holds (`recordNames`);
 * left out, the document reads the names of what it mentions for itself. `under` is
 * the level of the heading the document stands beneath, where that is not the h2.
 */
export function Markdown({
  source,
  names,
  under = 2,
}: {
  source: string;
  names?: RecordNames;
  under?: number;
}) {
  const long = source.length > MAX_READ;
  const tree = useMemo(() => (long ? [] : parseMarkdown(source)), [source, long]);
  const read = useRecordNames(names || long ? '' : source);
  if (long) return <pre className="doc">{source}</pre>;
  return <div className="md">{blocks(tree, names ?? read, under)}</div>;
}

/**
 * Where a text can be cut so that each piece reads as it does within the whole: at a finished line
 * at the margin after a blank one, outside any fence, that does not continue a list. A line still
 * being written may yet become an item (`2` before `2.`), and a finished one never changes, so a
 * growing text's cuts all stay. Only `source` from `from`, itself such a cut, is read.
 */
function cutsFrom(source: string, from: number): number[] {
  const cuts: number[] = [];
  let fence: RegExp | null = null;
  let after = false;
  for (let at = from; at < source.length;) {
    const end = source.indexOf('\n', at) + 1 || source.length + 1;
    const line = source.slice(at, end - 1);
    if (fence) {
      if (fence.test(line)) fence = null;
    } else {
      if (
        after &&
        at > from &&
        end <= source.length &&
        !blank(line) &&
        !gap(line[0]) &&
        !ITEM.test(line)
      )
        cuts.push(at);
      const open = FENCE.exec(line);
      if (open && !(open[1]!.startsWith('`') && open[2]!.includes('`')))
        fence = new RegExp(`^ {0,3}${open[1]![0]}{${open[1]!.length},}[ \\t]*$`);
    }
    after = blank(line);
    at = end;
  }
  return cuts;
}

const Piece = memo(function Piece({ source, names }: { source: string; names: RecordNames }) {
  const long = source.length > MAX_READ;
  const tree = useMemo(() => (long ? [] : parseMarkdown(source)), [source, long]);
  return long ? <pre>{source}</pre> : <>{blocks(tree, names, 2)}</>;
});

/**
 * `Markdown` for a text that grows while it is read, as a streamed answer does, or one too long to
 * read whole: the same page, drawn in pieces (`cutsFrom`) that are each read once. Only a growing
 * text's last piece is read again, and MAX_READ bounds each piece rather than the text.
 */
export function MarkdownPieces({ source, names }: { source: string; names?: RecordNames }) {
  const read = useRecordNames(names ? '' : source);
  const last = useRef({ source: '', starts: [0], pieces: [] as string[] });
  const pieces = useMemo(() => {
    const before = last.current;
    // A text that only grew keeps its pieces but the last, which is cut again.
    const kept = source.startsWith(before.source) ? before.starts.length - 1 : 0;
    const from = before.starts[kept]!;
    const starts = [...before.starts.slice(0, kept), from, ...cutsFrom(source, from)];
    const next = starts.map((start, index) =>
      index < kept ? before.pieces[index]! : source.slice(start, starts[index + 1]),
    );
    last.current = { source, starts, pieces: next };
    return next;
  }, [source]);
  return (
    <div className="md">
      {pieces.map((piece, index) => (
        <Piece key={index} source={piece} names={names ?? read} />
      ))}
    </div>
  );
}
