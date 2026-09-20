import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTool } from './api';
import { KindLabel, StatusPill, cx, kindOf, words } from './components';
import { CheckIcon, CloseIcon } from './icons';
import { matches } from './list-filters';
import { RecordLink } from './markdown';

/**
 * A field that holds records rather than characters. Nobody types an identifier:
 * what is chosen stands in the field as chips named the way the rest of the app
 * names them, the cursor after the chips searches what may still be chosen, and
 * the form that owns the field is handed ids, which is what its tool asks for.
 *
 * It is the ARIA combobox with a multi-selectable listbox: arrows move through
 * the list, Enter takes or lets go of the option in hand, Backspace on an empty
 * search lets go of the last chip, and Escape closes the list — and only the list,
 * so the form around it keeps its own Escape for when the list is already shut.
 * What was taken or let go is said once, quietly, to whoever cannot see the chips.
 */

/** One record that may be chosen: its id for the tool, the rest for the person. */
export interface Pickable {
  id: string;
  name: string;
  /** The view kind it belongs to, printed only while the options mix kinds. */
  kind?: string;
  state?: string | null;
}

/** The options a search keeps: by name, kind or state word, or by a pasted id. */
export const narrowed = (options: Pickable[], query: string): Pickable[] => {
  const search = query.trim().toLowerCase();
  return options.filter((option) =>
    matches(
      search,
      [option.name, option.kind && kindOf(option.kind).label, option.state && words(option.state)],
      [option.id],
    ),
  );
};

/** Where the cursor lands after a key, in a list of `count`; -1 is nowhere. */
export const stepped = (at: number, count: number, key: string): number =>
  !count
    ? -1
    : key === 'ArrowDown'
      ? (at + 1) % count
      : key === 'ArrowUp'
        ? (at <= 0 ? count : at) - 1
        : key === 'Home'
          ? 0
          : key === 'End'
            ? count - 1
            : at;

export function RecordPicker({
  label,
  options,
  value,
  onChange,
  loading,
  none = 'Nothing to choose yet',
}: {
  label: string;
  options: Pickable[];
  /** The chosen ids, in the order they were chosen. */
  value: string[];
  onChange(ids: string[]): void;
  /** True while the lists the options come from are still being read. */
  loading?: boolean;
  /** What the list says while there is nothing to choose from at all. */
  none?: string;
}) {
  const uid = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const shown = narrowed(options, query);
  const active = open ? shown[Math.min(at, shown.length - 1)] : undefined;
  const mixed = new Set(options.map((option) => option.kind)).size > 1;
  const named = new Map(options.map((option) => [option.id, option]));
  const [said, setSaid] = useState('');
  // A form locks its fields by disabling the fieldset around them. That reaches the
  // search, but neither the padding that leads to it nor the options under it, so
  // each of them asks the search: a command in flight, or kept for a retry, is sent
  // exactly as it was submitted, and the chips on screen must still be that command.
  const locked = () => !!input.current?.matches(':disabled');
  const change = (ids: string[], id: string) => {
    if (locked()) return;
    const name = named.get(id)?.name ?? 'Record';
    setSaid(`${name} ${ids.includes(id) ? 'added' : 'removed'}, ${ids.length} chosen`);
    onChange(ids);
  };
  const toggle = (id: string) =>
    change(value.includes(id) ? value.filter((other) => other !== id) : [...value, id], id);
  const close = () => {
    setOpen(false);
    setQuery('');
  };

  // Escape shuts the list and nothing else. The form this field stands in listens for
  // the same key on the document, so the list answers first, from the window, and marks
  // the key as taken; with the list already shut the key is the form's again.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      setQuery('');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  // The option in hand stays in view as the arrows carry it past the edge of the list.
  useEffect(() => {
    if (active)
      document.getElementById(`${uid}-${active.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [uid, active]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      // Home and End belong to the text until a list is open to take them.
      if (!open && event.key.startsWith('Arrow')) setOpen(true);
      else if (!open) return;
      else setAt(stepped(Math.min(at, shown.length - 1), shown.length, event.key));
      event.preventDefault();
    } else if (event.key === 'Enter' && open) {
      // Enter chooses; it never submits the form from inside an open list.
      event.preventDefault();
      if (!active) return;
      toggle(active.id);
      setQuery('');
    } else if (event.key === 'Backspace' && !query && value.length) {
      change(value.slice(0, -1), value.at(-1)!);
    }
  };

  return (
    <div
      className="picker"
      ref={box}
      onBlur={(event) => !box.current?.contains(event.relatedTarget) && close()}
    >
      <label htmlFor={`${uid}-input`} id={`${uid}-label`}>
        {label}
      </label>
      <div
        className="picker-field"
        // The whole field is the way to its cursor, as a text field's padding is.
        onMouseDown={(event) => {
          if (locked() || (event.target as HTMLElement).closest('button')) return;
          if (event.target !== input.current) event.preventDefault();
          input.current?.focus();
          setOpen(true);
        }}
      >
        {value.map((id) => {
          const option = named.get(id);
          return (
            <span className="picker-chip" key={id}>
              {mixed && option?.kind && <KindLabel kind={option.kind} />}
              <span className="picker-chip-name" title={option?.name}>
                {option?.name ?? <RecordLink id={id} plain />}
              </span>
              <button
                type="button"
                className="picker-remove"
                aria-label={`Remove ${option?.name ?? 'this record'}`}
                title="Remove"
                onClick={() => {
                  toggle(id);
                  input.current?.focus();
                }}
              >
                <CloseIcon size={12} />
              </button>
            </span>
          );
        })}
        <input
          ref={input}
          id={`${uid}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${uid}-list`}
          aria-autocomplete="list"
          aria-activedescendant={active ? `${uid}-${active.id}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={value.length ? undefined : 'Search'}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setAt(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && (
        <ul
          className="picker-list"
          id={`${uid}-list`}
          role="listbox"
          aria-labelledby={`${uid}-label`}
          aria-multiselectable="true"
        >
          {shown.map((option, index) => {
            const chosen = value.includes(option.id);
            return (
              <li
                key={option.id}
                id={`${uid}-${option.id}`}
                role="option"
                aria-selected={chosen}
                className={cx('picker-option', option === active && 'picker-option--active')}
                // The cursor stays in the search while the pointer chooses.
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setAt(index)}
                onClick={() => {
                  toggle(option.id);
                  setQuery('');
                }}
              >
                {chosen ? <CheckIcon size={14} /> : <span />}
                <span className="picker-option-name">
                  {mixed && <KindLabel kind={option.kind} />}
                  <span>{option.name}</span>
                </span>
                <StatusPill value={option.state} />
              </li>
            );
          })}
          {/* Nothing to choose from and nothing a search kept are two causes, said apart. */}
          {!shown.length && (
            <li className="picker-none" role="presentation">
              {loading ? 'Loading…' : options.length ? 'No matches' : none}
            </li>
          )}
        </ul>
      )}
      <span className="sr-only" role="status">
        {said}
      </span>
    </div>
  );
}

/** A retained file as something to choose: its title is its name. */
export const filePick = (file: { id: string; title: string }): Pickable => ({
  id: file.id,
  name: file.title,
  kind: 'artifacts',
});

interface Listed {
  id: string;
  workflow: { state: string };
}
/** Work that ended without succeeding can never be satisfied, so it is never offered. */
const LOST = ['failed', 'abandoned'];

/**
 * The work a new record may wait on: every task and experiment of the project that
 * has succeeded or still can. The server takes any workflow of the project as a
 * prerequisite; these two lists are the ones the Work page is made of, and the
 * same two reads it has already made.
 */
export function useWorkPicks(): { options: Pickable[]; loading: boolean } {
  const tasks = useTool<(Listed & { title: string })[]>('task.list');
  const experiments = useTool<(Listed & { name: string })[]>('experiment.list');
  const pick = (kind: string, item: Listed, name: string): Pickable => ({
    id: item.id,
    name,
    kind,
    state: item.workflow.state,
  });
  return {
    options: [
      ...(tasks.data ?? []).map((item) => pick('tasks', item, item.title)),
      ...(experiments.data ?? []).map((item) => pick('experiments', item, item.name)),
    ].filter((option) => !LOST.includes(option.state ?? '')),
    loading: tasks.loading || experiments.loading,
  };
}
