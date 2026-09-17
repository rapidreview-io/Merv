import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTool } from './api';
import { KindLabel, cx, words } from './components';
import { matches } from './list-filters';
import { buildNavigation } from './navigation';
import type { Row } from './shell-types';
import { at, records, str, type Json } from './views/remote-fields';

/**
 * One answer to "what can I do here", on every page. The palette is a second
 * door, never a new room: it goes where the rail goes, names records the way
 * their own lists name them, and offers exactly the controls the page in front
 * of you is rendering — by clicking them where they stand.
 */
export const FIND_KB = /Mac|iP/.test(navigator.platform || '') ? '⌘K' : 'Ctrl+K';
/** What a section shows before it says how many more it kept. */
const MAX = 8;

type Slot = 'act' | 'create';
const here: Partial<Record<Slot, HTMLElement>> = {};

/** A record's Act slot and a list's creation control register themselves as they mount. */
export function useHere<T extends HTMLElement>(slot: Slot) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (node) here[slot] = node;
    return () => {
      if (here[slot] === node) delete here[slot];
    };
  });
  return ref;
}

/** The vocabulary of wave 4; a control outside it navigates or explains, and is not an action. */
const VERB = /^(New|Start|Claim|Submit|Halt|Edit|Extend|Release|Download)\b/;
const said = (node: HTMLElement) => (node.textContent ?? '').replace(/\s+/g, ' ').trim();

/** What the open page offers right now, in the words its own controls carry. */
function offered(): Item[] {
  const seen = new Set<string>();
  return Object.values(here)
    .flatMap((slot) => [slot, ...slot.querySelectorAll<HTMLElement>('button, a[href]')])
    .filter((node) => node.matches('button, a[href]') && node.isConnected)
    .filter((node) => !node.hasAttribute('disabled') && VERB.test(said(node)))
    .filter((node) => !seen.has(said(node)) && !!seen.add(said(node)))
    .map((node) => ({ key: said(node), name: said(node), run: () => node.click() }));
}

/** One line: a place, a record or a move, and the quiet word that qualifies it. */
type Item = { key: string; name: string; kind?: string; note?: string; run(): void };

/** Where a collection's list lives, and the fields that name and place a record in it. */
type Source = { key: string; kind: string; path: string; tool: string; input: Json } & Fields;
type Fields = { id: string; name?: string; subject?: string; state?: string; opens?: boolean };

/** The list each collection's page already reads, and how a record in it is named. */
const LISTS: Record<string, Omit<Fields, 'id'> & { tool: string }> = {
  experiments: { tool: 'experiment.list', name: 'name', state: 'workflow.state', opens: true },
  tasks: { tool: 'task.list', name: 'title', state: 'workflow.state', opens: true },
  // A review has no name of its own: it is named by the work it judges.
  reviews: { tool: 'review.list', subject: 'subjectId', state: 'status', opens: true },
  claims: { tool: 'claim.list', name: 'statement', state: 'status' },
  research: { tool: 'research.list', name: 'name', state: 'workflow.state', opens: true },
  artifacts: { tool: 'artifact.list', name: 'title', opens: true },
  reflections: { tool: 'reflection.list', name: 'title', state: 'workflow.state', opens: true },
  consolidation: { tool: 'consolidation.list', name: 'name', state: 'workflow.state', opens: true },
};

/** Every collection the shell lists that can name its records from a list it already reads. */
function sourcesOf(rows: Row[]): Source[] {
  return rows.flatMap((row): Source[] => {
    const place = { key: row.id, path: row.path };
    const known = LISTS[row.view.kind];
    if (known) return [{ ...place, kind: row.view.kind, input: {}, id: 'id', ...known }];
    // A row a service outside this process published says all of that in its manifest.
    const spec = row.view.spec as Json | undefined;
    const of = (field: string) => str(at(spec, field));
    if (row.view.kind !== 'collection' || !of('key')) return [];
    return [
      {
        ...place,
        kind: of('noun.singular') || row.label,
        tool: 'ui.read',
        input: { rowId: row.id },
        id: of('key'),
        name: of('title'),
        state: of('states.field'),
        opens: !!row.view.record,
      },
    ];
  });
}

/** One collection's list, read only while the palette is looking for records. */
function Source({ source, onRead }: { source: Source; onRead(key: string, items: Json[]): void }) {
  const { data } = useTool<unknown>(source.tool, source.input);
  useEffect(() => {
    onRead(source.key, records(data));
  }, [source.key, data, onRead]);
  return null;
}

export function Palette({ rows, open, onClose }: { rows: Row[]; open: boolean; onClose(): void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [read, setRead] = useState<Record<string, Json[]>>({});
  const [acts, setActs] = useState<Item[]>([]);
  const frame = useRef<HTMLDivElement>(null);
  const onRead = useCallback(
    (key: string, items: Json[]) => setRead((old) => ({ ...old, [key]: items })),
    [],
  );
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    setActs(offered());
  }, [open]);
  useEffect(() => frame.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' }));
  const sources = sourcesOf(rows);
  const search = query.trim().toLowerCase();
  const keep = (item: Item) => item.name.toLowerCase().includes(search);
  /** Every place the rail lists, in the rail's order and with the rail's glyphs. */
  const place = (row: Row, note?: string): Item => ({
    key: row.id,
    name: row.label,
    note,
    run: () => navigate(row.path),
  });
  const places = (): Item[] => [
    { key: 'home', name: 'Home', run: () => navigate('/') },
    { key: 'now', name: 'Now', run: () => navigate('/now') },
    ...buildNavigation(rows).flatMap((part) => part.rows.map((row) => place(row, part.label))),
    ...rows.filter((row) => row.group === 'settings').map((row) => place(row)),
  ];
  /** The records those lists hold, each by its own name; an id is matched, never shown. */
  const found = (): Item[] => {
    const named = new Map<string, string>();
    for (const source of sources)
      if (source.name)
        for (const item of read[source.key] ?? [])
          named.set(str(at(item, source.id)), str(at(item, source.name)));
    return sources.flatMap((source) =>
      (read[source.key] ?? []).flatMap((item): Item[] => {
        const id = str(at(item, source.id));
        const name = source.name
          ? str(at(item, source.name))
          : named.get(str(at(item, source.subject)));
        if (!name || !matches(search, [name], [id])) return [];
        const to = source.opens ? `${source.path}/${id}` : source.path;
        return [
          {
            key: `${source.key}:${id}`,
            kind: source.kind,
            name,
            note: words(str(at(item, source.state))) || undefined,
            run: () => navigate(to),
          },
        ];
      }),
    );
  };
  // A record costs a read, so nothing is asked for until the search is one.
  const looking = search.length >= 2;
  const sections = [
    { id: 'go', title: 'Go to', items: places().filter(keep) },
    { id: 'rec', title: 'Records', items: looking ? found() : [] },
    { id: 'act', title: 'Actions here', items: acts.filter(keep) },
  ].filter((section) => section.items.length > 0);
  const shown = sections.map((section) => section.items.slice(0, MAX));
  const flat = shown.flat();
  const on = flat[Math.min(cursor, flat.length - 1)];
  const choose = (item: Item) => {
    onClose();
    item.run();
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // Arrows always move; j and k move until they are being typed into the search.
    const letter = !query && (event.key === 'j' ? 1 : event.key === 'k' ? -1 : 0);
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : letter;
    const act = step
      ? () => setCursor((value) => Math.max(0, Math.min(flat.length - 1, value + step)))
      : event.key === 'Enter' && on
        ? () => choose(on)
        : event.key === 'Escape'
          ? onClose
          : undefined;
    if (!act) return;
    event.preventDefault();
    act();
  };
  if (!open) return null;
  return (
    <div className="pal-over" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pal" role="dialog" aria-modal="true" ref={frame} onKeyDown={onKey}>
        <input
          className="pal-input"
          autoFocus
          aria-label="Search places, records and this page"
          placeholder="Search places, records and this page"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
        />
        <div className="pal-list">
          {sections.map((section, index) => (
            <div key={section.id}>
              <h2 className="ev-role pal-head">{section.title}</h2>
              {shown[index]!.map((item) => (
                <button
                  type="button"
                  key={item.key}
                  className={cx('rail-row pal-row', item === on && 'active')}
                  onClick={() => choose(item)}
                  onMouseMove={() => setCursor(flat.indexOf(item))}
                >
                  {item.kind && <KindLabel kind={item.kind} />}
                  <span className="rail-row-label">{item.name}</span>
                  {item.note && <span className="rail-count">{item.note}</span>}
                </button>
              ))}
              {section.items.length > MAX && (
                <p className="pal-more">and {section.items.length - MAX} more</p>
              )}
            </div>
          ))}
          {!flat.length && <p className="pal-more">Nothing here matches.</p>}
        </div>
        {looking && sources.map((s) => <Source key={s.key} source={s} onRead={onRead} />)}
      </div>
    </div>
  );
}
