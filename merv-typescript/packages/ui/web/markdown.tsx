import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Link, useHref } from 'react-router-dom';
import { call, scopeVersion, useTool } from './api';
import { CodeBlock, NUMBERED_FROM } from './code-block';
import { TeX } from './math';
import { Mermaid } from './mermaid';
import { pathOf, rowOf, useRows } from './navigation';
import type { Row } from './shell-types';
import { safeHref, splitIds } from './markdown-links';

export { safeHref, splitIds };

/**
 * Briefs, deliveries and reports are written in Markdown, and they are most of
 * what a person reads here, so they are read as documents rather than as source.
 * It is three parts kept apart on purpose: a pure parser to a small tree
 * (`parseMarkdown` in markdown-parse, micromark's mdast mapped onto it, which never
 * throws and never sees the DOM), the names of the records a text mentions
 * (`recordNames`, `RecordLink`), and one component that draws the tree as React
 * elements. Nothing is ever handed to the browser as
 * HTML: a tag an author wrote is text, an image is a link that loads nothing, and
 * an address the app would not open itself never becomes an href. Code, diagrams
 * and formulas are drawn by components of their own (`CodeBlock`, `Mermaid`, `TeX`),
 * each of which loads what it needs the first time it is shown.
 */

export type Align = 'left' | 'center' | 'right' | null;
export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'math'; value: string }
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
  | { type: 'math'; value: string }
  | { type: 'quote'; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; loose: boolean; items: ListItem[] }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: 'rule' };

/* Record ids ------------------------------------------------------------- */

export const prefixOf = (id: string) => id.slice(0, id.lastIndexOf('_'));
/** What stands for an id nobody could name: its prefix and its last six. */
export const shortId = (id: string) => `${prefixOf(id)}_…${id.slice(-6)}`;
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
type Listed = { id: string; name?: string; title?: string };
/** `ui.home`: the people, and each row's records under the row's id. */
export type NamedHome = object;
type Parts = { actors?: { id: string; name: string }[] | null } & Record<string, Listed[] | null>;
type NamedRow = Pick<Row, 'id' | 'path' | 'view' | 'workflow' | 'holds'>;

/**
 * Names for the ids a text mentions, from lists the app already reads: a record opens at
 * its row's page, and a person is a name and no link. A record with no name of its own, a
 * review, is named by its owner through project.references. An id no list names is simply
 * absent from the map.
 */
export function recordNames(
  files?: NamedFile[] | null,
  home?: NamedHome | null,
  rows: readonly NamedRow[] = [],
): RecordNames {
  const names = new Map<string, Named>();
  const parts = (home ?? {}) as Parts;
  for (const file of files ?? [])
    names.set(file.id, { name: file.title, to: `/artifacts/${file.id}` });
  const listed = rows.flatMap((row) => {
    const records = parts[row.id];
    return Array.isArray(records)
      ? records.map((record) => ({ ...record, to: `${row.path}/${record.id}` }))
      : [];
  });
  for (const { id, name = '', title = '', to } of listed)
    if (name || title) names.set(id, { name: name || title, to });
  for (const actor of parts.actors ?? [])
    // A directory name that is itself an identifier names nobody.
    if (!/[0-9a-f]{16,}/.test(actor.name)) names.set(actor.id, { name: actor.name });
  return names;
}

/** One answer of project.references, which names a record as its owner does. */
interface Reference {
  ref: string;
  status: string;
  kind: string | null;
  id: string | null;
  label?: string;
  /** Where the record stands, in its owner's word: a work item's state, a review's status. */
  state?: string;
}
/** Where a record a reference names opens: a work record on the row that lists its workflow. */
const routeOf = ({ kind, id }: Reference, rows: readonly NamedRow[]) => {
  const path =
    kind === 'artifact'
      ? '/artifacts'
      : kind === 'review'
        ? pathOf(rows, 'reviews')
        : kind
          ? rowOf(rows, kind)?.path
          : undefined;
  return path && `${path}/${id}`;
};

/**
 * What project.references said of each id, for every text in this tab at once: the ids asked
 * within one tick go as one request (of at most 200, the tool's own bound), and each answer, a
 * record or a miss, is kept for the session, so a text that grows or is drawn again asks only for
 * what it newly mentions and keeps every name it had while that is asked. An answer older than
 * a few minutes is asked again where a text next mentions it, and shown until the new one comes;
 * `again` asks even a fresh one, for a page whose states must move as it polls. A failed
 * request leaves its ids to be asked again; another project starts afresh.
 */
const FRESH_MS = 5 * 60_000;
const told = new Map<string, { reference: Reference; at: number }>();
const queued = new Set<string>();
const asking = new Set<string>();
const hearing = new Set<() => void>();
let heard = 0;
let round = 0;
let epoch = scopeVersion();
let timer: ReturnType<typeof setTimeout> | undefined;
function askNames(ids: readonly string[], again = false): void {
  if (epoch !== scopeVersion() || told.size > 20_000) {
    told.clear();
    queued.clear();
    asking.clear();
    round++;
    epoch = scopeVersion();
  }
  const stale = Date.now() - FRESH_MS;
  for (const id of ids)
    if (!asking.has(id) && (again || !((told.get(id)?.at ?? -Infinity) > stale))) queued.add(id);
  if (!queued.size || timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    const ids = [...queued];
    queued.clear();
    const at = round;
    for (let from = 0; from < ids.length; from += 200) {
      const refs = ids.slice(from, from + 200);
      for (const ref of refs) asking.add(ref);
      void call<Reference[]>('project.references', { refs })
        .then(
          (answer) => {
            if (at !== round) return;
            for (const reference of answer) told.set(reference.ref, { reference, at: Date.now() });
            heard++;
            for (const listener of hearing) listener();
          },
          () => undefined,
        )
        .finally(() => {
          if (at === round) for (const ref of refs) asking.delete(ref);
        });
    }
  });
}
/** Ask these ids again now, as a page does when it has just changed what they name. */
export const refreshReferences = (ids: readonly string[]) => askNames(ids, true);
const hear = (listener: () => void) => {
  hearing.add(listener);
  return () => void hearing.delete(listener);
};

/**
 * These records as their owners name them, through project.references: each one's name, where
 * it opens (on the row that lists its workflow, `routeOf`), and the state it stands in. Ids asked
 * alike share the page's one request; an id nobody named is absent. With `every` (ms) they are
 * asked again at that cadence while the tab is shown, so a state moves as the page polls; the
 * names already told stand meanwhile.
 */
export function useReferences(
  ids: readonly string[],
  every?: number,
): ReadonlyMap<string, Named & { state?: string }> {
  const version = useSyncExternalStore(
    hear,
    () => heard,
    () => heard,
  );
  useEffect(() => {
    askNames(ids);
    if (!every) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') askNames(ids, true);
    }, every);
    return () => clearInterval(timer);
  }, [ids, every]);
  // The rows say where each record opens: the ones the shell already holds.
  const rows = useRows();
  return useMemo(() => {
    const names = new Map<string, Named & { state?: string }>();
    // What another project's page was told names nothing here.
    if (epoch === scopeVersion())
      for (const reference of ids.map((id) => told.get(id)?.reference))
        if (reference?.status === 'resolved' && reference.id && reference.label)
          names.set(reference.id, {
            name: reference.label,
            to: routeOf(reference, rows),
            ...(reference.state !== undefined && { state: reference.state }),
          });
    return names;
    // `version` counts the answers heard, which `told` holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, version, rows]);
}

/**
 * The names for one text, read only when the text mentions something to name: what
 * project.references says of each id, over the people and records of the home read the
 * rail already holds. A text with no ids in it costs nothing at all.
 */
export function useRecordNames(text: string): RecordNames {
  const ids = useMemo(() => idsIn(text).slice(0, 200), [text]);
  const referenced = useReferences(ids);
  const home = useTool<NamedHome>(ids.length ? 'ui.home' : null);
  const rows = useRows();
  return useMemo(
    () => new Map([...recordNames(null, home.data, rows), ...referenced]),
    [referenced, home.data, rows],
  );
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
  const to = found?.to;
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
 * `plain` names them without linking, where the text already stands inside a control. A
 * text given no names reads its own.
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
  const own = useRecordNames(names ? '' : text);
  names ??= own;
  return (
    <>
      {splitIds(text).map((piece, at) =>
        at % 2 ? <RecordLink key={at} id={piece} names={names} plain={plain} /> : piece,
      )}
    </>
  );
}

/* Parsing ---------------------------------------------------------------- */

/**
 * The parser (`markdown-parse`: micromark, GFM and math) is not part of the page's first load,
 * and it reads in a worker, so no text holds the page's one thread: micromark is superlinear on
 * a few texts, such as thousands of `*` or of links that never close in one paragraph. A text the
 * worker has not read in READ_MS stands as typed, and a new worker reads the next. That clock runs
 * only once the worker says it has loaded, so a slow download gives up no text. Where no worker
 * starts, as in a test's DOM, the parser loads into the page and reads there.
 */
type Parse = (source: string) => Block[];
let parse: Parse | undefined;
let loading: Promise<void> | undefined;
export const loadParser = () =>
  (loading ??= import('./markdown-parse').then((module) => {
    parse = module.parseMarkdown;
  }));
const READ_MS = 2000;
/** The trees of the texts read last; null for one not read in time. */
const trees = new Map<string, Block[] | null>();
/** The texts to read, oldest first, each with whoever still waits for it. */
const waiting = new Map<string, Set<() => void>>();
/** Undefined until one starts; null once none could. */
let worker: Worker | null | undefined;
/** Whether the worker has said it loaded: until then it is downloading, not reading. */
let loaded = false;
let busy = false;
const inPage = () => worker === null || typeof Worker === 'undefined';

function keep(source: string, tree: Block[] | null): void {
  trees.delete(source);
  trees.set(source, tree);
  if (trees.size > 500) trees.delete(trees.keys().next().value!);
}

/** The oldest text someone still waits for, read in the worker, or in the page where none runs. */
function readNext(): void {
  if (busy) return;
  // A text nobody waits for any more, such as what a growing one was, is not read.
  for (const [text, waiters] of waiting) if (!waiters.size) waiting.delete(text);
  const [next] = waiting;
  if (!next) return;
  const [source, waiters] = next;
  busy = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = (tree: Block[] | null) => {
    clearTimeout(timer);
    busy = false;
    keep(source, tree);
    waiting.delete(source);
    for (const wake of waiters) wake();
    readNext();
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
    loadParser().then(
      () => done(parse!(source)),
      () => done(null),
    );
    return;
  }
  const time = () =>
    (timer = setTimeout(() => {
      worker?.terminate();
      worker = undefined;
      done(null);
    }, READ_MS));
  worker!.onmessage = (event: MessageEvent<Block[] | 'loaded'>) => {
    if (event.data !== 'loaded') return done(event.data);
    loaded = true;
    time();
  };
  // A worker that cannot start leaves every text to the page.
  worker!.onerror = () => {
    worker = null;
    clearTimeout(timer);
    busy = false;
    readNext();
  };
  worker!.postMessage(source);
  if (loaded) time();
}

/**
 * The tree of a text, or null while it is first read or where it is too long or slow to read.
 * While a text that grew is read, the tree of what it was stands, so a streamed one does not flash.
 */
function useTree(source: string): Block[] | null {
  const [, wake] = useReducer((count: number) => count + 1, 0);
  const long = source.length > MAX_READ;
  if (!long && inPage() && parse && !trees.has(source)) keep(source, parse(source));
  const tree = long ? null : trees.get(source);
  useEffect(() => {
    if (tree !== undefined) return;
    const waiters = waiting.get(source) ?? new Set();
    waiting.set(source, waiters.add(wake));
    readNext();
    return () => void waiters.delete(wake);
  }, [source, tree]);
  const last = useRef({ source, tree: null as Block[] | null });
  if (tree !== undefined) {
    last.current = { source, tree };
    return tree;
  }
  return source.startsWith(last.current.source) ? last.current.tree : null;
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
      case 'math':
        return <TeX key={key} tex={node.value} />;
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
        return node.lang?.toLowerCase() === 'mermaid' ? (
          <Mermaid key={key} source={node.value} />
        ) : (
          <CodeBlock
            key={key}
            code={node.value}
            lang={node.lang}
            numbered={node.value.split('\n', NUMBERED_FROM + 2).length > NUMBERED_FROM}
          />
        );
      case 'math':
        return <TeX key={key} tex={node.value} display />;
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
  const tree = useTree(source);
  const read = useRecordNames(names || source.length > MAX_READ ? '' : source);
  if (!tree) return <pre className="doc">{source}</pre>;
  return <div className="md">{blocks(tree, names ?? read, under)}</div>;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})([^]*)$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:( +)([^]*))?$/;
const blank = (line: string | undefined) => !line || !line.trim();
const gap = (char: string | undefined) => char === ' ' || char === '\t';

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
  const tree = useTree(source);
  return tree ? <>{blocks(tree, names, 2)}</> : <pre>{source}</pre>;
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
