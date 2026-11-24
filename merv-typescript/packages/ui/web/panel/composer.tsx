import { modelName } from './model-name';
export { modelName } from './model-name';
/** Session choices and pictures live beside the person's words, in the panel. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RuntimeCommand, RuntimeModel, SessionOptions } from '@merv/protocol/runtime';
import type { DiffReference, SessionSource } from '@merv/protocol/diff';
import { useDeskCall, useMacDesk } from './desk-calls';
import { completion } from './completion';
import { useDismiss } from './use-dismiss';
import type { AttachmentInfo } from './chat-events';

import { providerName, type Provider } from '@merv/protocol/runtime';
export type ChoicesValue = SessionOptions & { place?: string; ownBranch?: boolean };
import { agentDefaults, syncCreationDefaults } from './agent-defaults';
/** Until Settings or a folder says otherwise, a new session with either agent starts with full access. */
export const defaults: ChoicesValue = { model: '', mode: 'act', access: 'full' };

/** Suggestions last only as long as the person is typing that word. */
/** A reply box as tall as its words up to its cap, then scrolling inside, with the line being written kept in view. The
 *  cap is the box's CSS max-height where it has one (on a phone: a share of what is seen above the keyboard), else
 *  `cap`. Shared by every reply box, here and on the web. */
function fitBox(el: HTMLTextAreaElement, cap = 160) {
  const kept = el.scrollTop;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el),
    max = parseFloat(style?.maxHeight ?? '');
  const limit = Number.isFinite(max) && max > 0 ? max : cap;
  // Measure without a scrollbar narrowing the text while the height is reset.
  el.style.overflowY = 'hidden';
  el.style.height = 'auto';
  const full = el.scrollHeight;
  el.style.height = `${Math.min(full, limit)}px`;
  el.style.overflowY = full > limit ? 'auto' : 'hidden';
  // Resetting the height threw away where the box was scrolled: put it back, and where the caret is at the end (as it
  // is while writing) show the end, so the line being typed is never under the box's edge.
  el.scrollTop = el.selectionEnd >= el.value.length ? el.scrollHeight : kept;
}

export function Grow(props: {
  value: string;
  onChange(text: string): void;
  onEnter(form: HTMLFormElement | null): void;
  placeholder: string;
  autoFocus?: boolean;
  disabled?: boolean;
  cwd?: string;
  provider?: Provider;
  onQueue?(): void;
  cursor?: [number, number];
  onCursor?(cursor: [number, number]): void;
  onExpandQueue?(): void;
  prompts?: string[];
}) {
  const call = useDeskCall();
  const ref = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(false);
  const composing = useRef(false);
  const reported = useRef<{ text: string; cursor: [number, number] }>();
  const reportCursor = (el: HTMLTextAreaElement) => {
    reported.current = { text: el.value, cursor: [el.selectionStart, el.selectionEnd] };
    props.onCursor?.(reported.current.cursor);
  };
  const menu = useRef<HTMLDivElement>(null);
  const recall = useRef<{ at: number; text: string }>();
  const id = useId();
  const [word, setWord] = useState<ReturnType<typeof completion>>();
  const [found, setFound] = useState<{ key: string; items: RuntimeCommand[] }>();
  const [selected, setSelected] = useState(0);
  const key =
    word && props.cwd && props.provider
      ? `${props.provider}:${props.cwd}:${word.kind}:${word.q}`
      : '';
  const items = key && found?.key === key && !props.disabled ? found.items : [];
  useEffect(() => {
    setWord(undefined);
  }, [props.cwd, props.provider, props.disabled]);
  useEffect(() => {
    if (!props.value) setWord(undefined);
    if (recall.current?.text !== props.value) recall.current = undefined;
  }, [props.value]);
  useEffect(() => {
    setSelected(0);
    if (!key || !word) return;
    let stopped = false;
    const timer = setTimeout(() => {
      const route = word.kind === 'file' ? 'files' : `commands/${props.provider}`;
      void call<(string | RuntimeCommand)[]>(
        `${route}?cwd=${encodeURIComponent(props.cwd!)}&q=${encodeURIComponent(word.q)}`,
      ).then(
        (items) => {
          if (!stopped)
            setFound({
              key,
              items: items.map((item) => (typeof item === 'string' ? { name: item } : item)),
            });
        },
        () => {
          if (!stopped) setFound({ key, items: [] });
        },
      );
    }, 100);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [key]);
  const resize = () => {
    if (ref.current) fitBox(ref.current);
  };
  useLayoutEffect(resize, [props.value]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            if (el.clientWidth === width) return;
            width = el.clientWidth;
            resize();
          });
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    const own = props.cursor === reported.current?.cursor;
    if (reported.current?.text !== props.value) reported.current = undefined;
    // The browser may have moved again before React hears the selection. Only apply outside carets.
    if (
      own ||
      (props.cursor &&
        reported.current?.cursor[0] === props.cursor[0] &&
        reported.current.cursor[1] === props.cursor[1])
    )
      return;
    if (
      el &&
      props.cursor &&
      !composing.current &&
      (el.selectionStart !== props.cursor[0] || el.selectionEnd !== props.cursor[1])
    )
      el.setSelectionRange(...props.cursor);
  }, [props.value, props.cursor?.[0], props.cursor?.[1]]);
  useEffect(() => {
    if (props.autoFocus && !props.disabled && !focused.current) {
      focused.current = true;
      ref.current?.focus();
    }
  }, [props.autoFocus, props.disabled]);
  useEffect(() => {
    menu.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const pick = (item: RuntimeCommand) => {
    if (!word) return;
    const insert = `${word.kind === 'file' ? '@' : ''}${item.name} `;
    props.onChange(props.value.slice(0, word.start) + insert + props.value.slice(word.end));
    const caret = word.start + insert.length;
    setWord(undefined);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(caret, caret);
    });
  };
  return (
    <div className="composer-input">
      {!!items.length && (
        <div
          className="completion-menu"
          role="listbox"
          id={id}
          ref={menu}
          aria-label={word?.kind === 'file' ? 'Files' : 'Commands'}
        >
          {items.map((item, i) => (
            <button
              type="button"
              role="option"
              id={`${id}-${i}`}
              aria-selected={i === selected}
              key={item.name}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(item)}
              title={item.description ?? item.name}
            >
              {item.name}
              {item.description && <span className="soft"> {item.description}</span>}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        aria-autocomplete={props.provider ? 'list' : undefined}
        aria-controls={items.length ? id : undefined}
        aria-expanded={props.provider ? !!items.length : undefined}
        aria-activedescendant={items.length ? `${id}-${selected}` : undefined}
        onBlur={() => setWord(undefined)}
        onClick={() => setWord(undefined)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onSelect={(e) => reportCursor(e.currentTarget)}
        onChange={(e) => {
          recall.current = undefined;
          reportCursor(e.currentTarget);
          props.onChange(e.target.value);
          setWord(
            (e.nativeEvent as InputEvent).isComposing
              ? undefined
              : completion(e.target.value, e.target.selectionStart, props.provider === 'codex'),
          );
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229) return;
          if (e.altKey && e.key === 'ArrowUp' && props.onExpandQueue) {
            e.preventDefault();
            props.onExpandQueue();
            return;
          }
          if (e.key === 'Escape' && word) {
            e.preventDefault();
            e.stopPropagation();
            setWord(undefined);
            return;
          }
          if (items.length && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected(
                (at) => (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length,
              );
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              pick(items[selected] ?? items[0]);
              return;
            }
          }
          if (
            !e.altKey &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.shiftKey &&
            ['ArrowUp', 'ArrowDown'].includes(e.key) &&
            props.prompts?.length &&
            (!props.value || recall.current)
          ) {
            const at = recall.current?.at ?? props.prompts.length;
            const next = Math.max(
              0,
              Math.min(props.prompts.length, at + (e.key === 'ArrowUp' ? -1 : 1)),
            );
            if (next !== at) {
              e.preventDefault();
              const text = props.prompts[next] ?? '';
              recall.current = next === props.prompts.length ? undefined : { at: next, text };
              props.onChange(text);
              props.onCursor?.([text.length, text.length]);
              return;
            }
          }
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key))
            setWord(undefined);
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            setWord(undefined);
            if (!e.metaKey && props.onQueue) props.onQueue();
            else props.onEnter(e.currentTarget.form);
          }
        }}
      />
    </div>
  );
}

export interface Draft {
  text: string;
  pictures: Picture[];
  references?: DiffReference[];
  source?: SessionSource;
  sources?: SessionSource[];
  cursor: [number, number];
  choices: ChoicesValue;
}
export const hasContent = (draft: Pick<Draft, 'text'> & Partial<Draft>) =>
  !!(
    draft.text.trim() ||
    draft.pictures?.some((picture) => !picture.unavailable) ||
    draft.references?.length ||
    draft.source ||
    draft.sources?.length
  );

export interface NextMessage
  extends SessionOptions, Pick<Draft, 'text' | 'references' | 'source' | 'sources'> {
  /** Its own id, so the desk takes it once however often it is sent. */
  id?: string;
  attachments?: Picture[];
  redacted?: boolean;
}

export function Queued({
  items,
  open,
  toggle,
  edit,
  remove,
  move,
  send,
  running,
  disabled,
}: {
  send(message: NextMessage): void;
  running?: boolean;
  disabled?: boolean;
  items: NextMessage[];
  open: boolean;
  toggle(): void;
  edit(message: NextMessage): void;
  remove(message: NextMessage): void;
  move(message: NextMessage, direction: number): void;
}) {
  const [shown, setShown] = useState(items.map((message) => ({ message, leaving: false })));
  useEffect(() => {
    setShown((previous) => {
      const next = items.map((message) => ({ message, leaving: false }));
      previous.forEach((item, at) => {
        if (!items.some((message) => message.id === item.message.id))
          next.splice(at, 0, { ...item, leaving: true });
      });
      return next;
    });
    const timer = setTimeout(
      () => setShown(items.map((message) => ({ message, leaving: false }))),
      220,
    );
    return () => clearTimeout(timer);
  }, [items]);
  if (!shown.length) return null;
  return (
    <div className="queued">
      <button
        type="button"
        hidden={!items.length}
        className="queued-head"
        aria-expanded={open}
        onClick={toggle}
      >
        {items.length} queued<span aria-hidden="true">›</span>
      </button>
      <div className={`queued-body ${open ? 'is-open' : ''}`}>
        <div>
          {shown.map(({ message, leaving }) => (
            <div className={`queued-item ${leaving ? 'is-leaving' : ''}`} key={message.id}>
              <div
                className="queued-row"
                tabIndex={leaving ? -1 : 0}
                onKeyDown={(e) => {
                  if (
                    !disabled &&
                    !leaving &&
                    e.altKey &&
                    ['ArrowUp', 'ArrowDown'].includes(e.key)
                  ) {
                    e.preventDefault();
                    move(message, e.key === 'ArrowUp' ? -1 : 1);
                  }
                }}
              >
                <span className="queued-text" title={message.text}>
                  {message.text ||
                    message.references?.[0]?.path.split('/').at(-1) ||
                    message.sources?.[0]?.label ||
                    message.source?.label ||
                    'Source'}
                  {!!message.attachments?.length && (
                    <span className="soft"> · {message.attachments.length} files</span>
                  )}
                </span>
                {running && (
                  <button
                    type="button"
                    className="queued-send"
                    disabled={disabled || leaving}
                    aria-label="Steer with queued message"
                    onClick={() => send(message)}
                  >
                    Steer
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Edit queued message"
                  disabled={disabled || leaving || message.redacted}
                  title={message.redacted ? 'Edit this message on your Mac' : undefined}
                  onClick={() => edit(message)}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  >
                    <path d="m3 10 7-7 3 3-7 7H3zM9 4l3 3" />
                  </svg>
                </button>
                <button
                  type="button"
                  aria-label="Remove queued message"
                  disabled={disabled || leaving}
                  onClick={() => remove(message)}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function remembered(key: string, cwd: string, provider: Provider): ChoicesValue {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}');
    // What Settings says this agent starts on stands wherever the folder has chosen nothing itself.
    const own = agentDefaults(provider),
      text = (field: unknown, or?: string) => (typeof field === 'string' && field) || or || '';
    return {
      model: text(value.model, own.model),
      mode: value.mode === 'plan' ? 'plan' : 'act',
      access:
        value.access === 'full' || value.access === 'edit' || value.access === 'ask'
          ? value.access
          : (own.access ?? defaults.access),
      effort: text(value.effort, own.effort),
      speed: text(value.speed, own.speed),
      place:
        localStorage.getItem(`merv:place:${cwd}`) ??
        (typeof value.place === 'string'
          ? value.place
          : value.ownBranch === true
            ? 'new'
            : value.ownBranch === false
              ? 'here'
              : undefined),
    };
  } catch {
    return {
      ...defaults,
      ...Object.fromEntries(Object.entries(agentDefaults(provider)).filter(([, value]) => value)),
    };
  }
}

/** Whether these choices are anything but what Settings starts this agent on: a model, an effort, a speed, Plan, or another access.
 *  A main thread keeps the line that names them out of sight until it says something the person chose. */
function choicesChosen(value: ChoicesValue, provider: Provider): boolean {
  const own = agentDefaults(provider),
    same = (chosen: string | undefined, usual: string | undefined) =>
      !chosen || chosen === (usual ?? '');
  return !(
    same(value.model, own.model) &&
    same(value.effort, own.effort) &&
    same(value.speed, own.speed) &&
    value.mode !== 'plan' &&
    (value.access ?? own.access ?? defaults.access) === (own.access ?? defaults.access)
  );
}

/** Remember the folder's next session without changing its other open sessions. */
export function useChoices(cwd: string, provider: Provider, initial?: ChoicesValue) {
  const call = useMacDesk();
  const key = `merv:session:${provider}:${cwd}`;
  const [saved, setSaved] = useState(() => ({
    key,
    value: initial ?? remembered(key, cwd, provider),
  }));
  const session = initial === undefined ? undefined : JSON.stringify(initial);
  useEffect(() => {
    if (initial !== undefined) return;
    const reload = () => setSaved({ key, value: remembered(key, cwd, provider) });
    window.addEventListener('creation-defaults-changed', reload);
    return () => window.removeEventListener('creation-defaults-changed', reload);
  }, [key, initial, cwd, provider]);
  useEffect(() => {
    if (session !== undefined) setSaved({ key, value: JSON.parse(session) });
  }, [key, session]);
  const value = saved.key === key ? saved.value : (initial ?? remembered(key, cwd, provider));
  const change = (next: ChoicesValue) => {
    const before = value;
    setSaved({ key, value: next });
    try {
      // Only what the person changed is the folder's own; the rest keeps following Settings.
      const own = JSON.parse(localStorage.getItem(key) ?? '{}');
      const changed = Object.fromEntries(
        Object.entries(next).filter(
          ([field, chosen]) => (before as Record<string, unknown>)[field] !== chosen,
        ),
      );
      localStorage.setItem(
        key,
        JSON.stringify({ ...(own && typeof own === 'object' ? own : {}), ...changed }),
      );
      void syncCreationDefaults(call).catch((error) =>
        window.dispatchEvent(new CustomEvent('creation-defaults-error', { detail: String(error) })),
      );
      if (next.place !== undefined) localStorage.setItem(`merv:place:${cwd}`, next.place);
    } catch {
      /* A private window can still work. */
    }
  };
  return { value, change };
}

const effortName = (effort: string) =>
  effort === 'xhigh'
    ? 'Extra high'
    : effort
      ? effort[0]!.toUpperCase() + effort.slice(1)
      : 'Default';

/** One picker holds every choice: the agent first (a main thread's, which a switch changes), then model, effort and access.
    Without onChange (a Mac that does not share its catalog) it holds the agent alone and is named by it. */
export function Choices({
  cwd,
  provider,
  value = { access: 'ask' },
  onChange,
  disabled,
  current,
  onProvider,
  running,
  away,
}: {
  cwd: string;
  provider: Provider;
  value?: ChoicesValue;
  onChange?(value: ChoicesValue): void;
  disabled?: boolean;
  /** The model the session last answered with, when none was chosen. */
  current?: string;
  onProvider?(provider: Provider): void;
  running?: boolean;
  away?: boolean;
}) {
  const call = useDeskCall(),
    set = onChange ?? (() => undefined);
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<RuntimeModel[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [older, setOlder] = useState(false);
  const [active, setActive] = useState<string>();
  const id = useId();
  const root = useDismiss<HTMLDivElement>(
    open,
    (event) => {
      setOpen(false);
      if (event.type === 'keydown') button.current?.focus();
    },
    { capture: false, prevent: false },
  );
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setModels([]);
    setOpen(false);
    setQuery('');
  }, [cwd, provider]);
  useEffect(() => {
    setOlder(false);
  }, [open]);
  useEffect(() => {
    if (!open || !onChange) return;
    let stopped = false;
    setLoading(true);
    setError(false);
    void call<RuntimeModel[]>(`models/${provider}?cwd=${encodeURIComponent(cwd)}`)
      .then(
        (models) => {
          if (stopped) return;
          // Older catalogs expose Plan directly; an explicit capabilities report takes precedence.
          setModels(
            models.map((model) => ({
              ...model,
              capabilities: model.capabilities ?? {
                efforts: [''],
                plan: provider === 'claude' || model.plan,
              },
            })),
          );
          setActive(value.model || current);
        },
        () => {
          if (!stopped) setError(true);
        },
      )
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [open, cwd, provider]);
  useEffect(() => {
    list.current?.querySelector('[data-active=true]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  const model =
    models.find((model) => model.id === (value.model || current)) ??
    (!value.model ? models[0] : undefined);
  const canPlan = model?.capabilities.plan ?? (provider === 'claude' && !models.length);
  const filtered = models.filter((model) =>
    `${model.name} ${model.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  // The runtime lists newest first: the first few are offered, the rest wait behind one quiet line.
  const shown =
    query || older ? filtered : filtered.filter((item, i) => i < 4 || item.id === model?.id);
  const hidden = filtered.length - shown.length;
  // The active row is one of the shown models, or the "older" line that reveals the rest.
  const rows = hidden > 0 ? shown.length + 1 : shown.length;
  const selected =
    active === 'older'
      ? shown.length
      : Math.max(
          0,
          shown.findIndex((item) => item.id === active),
        );
  const reveal = () => {
    setOlder(true);
    setActive(filtered.find((item) => !shown.includes(item))?.id);
  };
  const pick = (model: RuntimeModel) =>
    set({
      ...value,
      model: model.id,
      effort: model.capabilities.efforts.includes(value.effort ?? '') ? value.effort : '',
      speed: model.capabilities.speeds?.some((speed) => speed.id === value.speed)
        ? value.speed
        : '',
      mode: model.capabilities.plan ? value.mode : 'act',
    });
  const efforts = model?.capabilities.efforts ?? [];
  const level = Math.max(0, efforts.indexOf(value.effort ?? ''));
  // Until the person moves it, the speed dial rests on the agent's own setting.
  const speeds = model?.capabilities.speeds ?? [];
  const pace = Math.max(
    0,
    speeds.findIndex((speed) => speed.id === (value.speed || model?.capabilities.speed)),
  );
  const mode = value.mode === 'plan' ? 'Plan' : 'Act';
  const accessName = (access: ChoicesValue['access']) =>
    access === 'full' ? 'Full access' : access === 'edit' ? 'Edit freely' : 'Ask first';
  // The model by its name when it is known, chosen here or the one the session last answered with, and the access always;
  // effort and Plan only when chosen, speed only when faster than standard. A model nobody can name is not mentioned.
  const chosen = !onChange
    ? `${providerName(provider)}${away ? ' · Mac is away' : ''}`
    : [
        value.model
          ? (model?.name ?? modelName(value.model)).replace(/^Claude /, '')
          : current
            ? modelName(current)
            : undefined,
        value.effort && effortName(value.effort),
        pace > 0 && speeds[pace]!.name,
        mode === 'Plan' && mode,
        accessName(value.access),
      ]
        .filter(Boolean)
        .join(' · ');
  const words = <T extends string>(
    label: string,
    options: readonly T[],
    chosen: T,
    name: (option: T) => string,
    set: (option: T) => void,
  ) => (
    <div className="choice-row">
      <span>{label}</span>
      <span className="segment" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            type="button"
            key={option}
            disabled={disabled}
            aria-pressed={chosen === option}
            onClick={() => set(option)}
          >
            {name(option)}
          </button>
        ))}
      </span>
    </div>
  );
  return (
    <div
      className={`session-choices${!onChange || choicesChosen(value, provider) || open ? ' is-chosen' : ''}`}
      ref={root}
    >
      <button
        ref={button}
        type="button"
        className="choice-summary"
        disabled={disabled}
        aria-label={
          !onChange
            ? 'Agent'
            : onProvider
              ? 'Agent, model, mode and access'
              : 'Model, mode and access'
        }
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          setQuery('');
          setOpen(!open);
        }}
      >
        <span>{chosen}</span>
      </button>
      {open && (
        <div className="choice-menu" role="dialog" aria-label="Session choices">
          {onProvider && (
            <div className="choice-row">
              <span>{away ? 'Mac is away' : running ? 'Stop and switch' : 'Agent'}</span>
              <span className="segment" role="group" aria-label="Agent">
                {(['claude', 'codex'] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    disabled={disabled || away}
                    aria-pressed={provider === item}
                    onClick={() => {
                      if (item === provider) return;
                      setOpen(false);
                      onProvider(item);
                    }}
                  >
                    {providerName(item)}
                  </button>
                ))}
              </span>
            </div>
          )}
          {onChange && (
            <>
              <div className="choice-search">
                <input
                  placeholder="Model"
                  aria-label="Model"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded="true"
                  aria-controls={id}
                  aria-activedescendant={rows ? `${id}-${selected}` : undefined}
                  autoFocus
                  disabled={disabled}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(undefined);
                  }}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === 'Enter') e.preventDefault();
                    if (!rows) return;
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const next = (selected + (e.key === 'ArrowDown' ? 1 : -1) + rows) % rows;
                      setActive(next === shown.length ? 'older' : shown[next]!.id);
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      if (selected === shown.length) reveal();
                      else pick(shown[selected]!);
                    }
                  }}
                />
                {loading && (
                  <svg
                    className="spin"
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    aria-label="Loading models"
                  >
                    <path
                      d="M7 1a6 6 0 0 1 6 6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                    />
                  </svg>
                )}
              </div>
              <div className="choice-models" role="listbox" aria-label="Models" id={id} ref={list}>
                {shown.map((item, i) => (
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    id={`${id}-${i}`}
                    key={item.id}
                    aria-selected={item.id === model?.id}
                    data-active={selected === i}
                    disabled={disabled}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(item.id)}
                    onClick={() => pick(item)}
                  >
                    <span>{item.name}</span>
                    {item.capabilities.contextWindow && (
                      <span className="row-age">
                        {Math.round(item.capabilities.contextWindow / 1000)}k
                      </span>
                    )}
                  </button>
                ))}
                {hidden > 0 && (
                  <button
                    type="button"
                    role="option"
                    className="choice-more"
                    tabIndex={-1}
                    id={`${id}-${shown.length}`}
                    aria-selected={false}
                    data-active={selected === shown.length}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive('older')}
                    onClick={reveal}
                  >
                    {hidden} older
                  </button>
                )}
              </div>
              {error && (
                <span className="soft" role="status">
                  Couldn’t read models. Open again to retry.
                </span>
              )}
              {efforts.length > 1 && (
                <div className="choice-row">
                  <span>Effort</span>
                  <span
                    className="dial"
                    role="radiogroup"
                    aria-label="Effort"
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                      e.preventDefault();
                      set({
                        ...value,
                        effort:
                          efforts[
                            Math.max(
                              0,
                              Math.min(
                                efforts.length - 1,
                                level + (e.key === 'ArrowRight' ? 1 : -1),
                              ),
                            )
                          ],
                      });
                    }}
                  >
                    {efforts.map((effort, i) => (
                      <button
                        type="button"
                        key={effort}
                        role="radio"
                        disabled={disabled}
                        aria-checked={i === level}
                        aria-label={effortName(effort)}
                        data-lit={i <= level}
                        tabIndex={i === level ? 0 : -1}
                        onClick={() => set({ ...value, effort })}
                      />
                    ))}
                    <span className="dial-name">{effortName(efforts[level]!)}</span>
                  </span>
                </div>
              )}
              {speeds.length > 1 && (
                <div className="choice-row">
                  <span>Speed</span>
                  <span
                    className="dial"
                    role="radiogroup"
                    aria-label="Speed"
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                      e.preventDefault();
                      set({
                        ...value,
                        speed:
                          speeds[
                            Math.max(
                              0,
                              Math.min(speeds.length - 1, pace + (e.key === 'ArrowRight' ? 1 : -1)),
                            )
                          ]!.id,
                      });
                    }}
                  >
                    {speeds.map((speed, i) => (
                      <button
                        type="button"
                        key={speed.id}
                        role="radio"
                        disabled={disabled}
                        aria-checked={i === pace}
                        aria-label={speed.name}
                        title={speed.description}
                        data-lit={i <= pace}
                        tabIndex={i === pace ? 0 : -1}
                        onClick={() => set({ ...value, speed: speed.id })}
                      />
                    ))}
                    <span className="dial-name">{speeds[pace]!.name}</span>
                  </span>
                </div>
              )}
              {canPlan &&
                words(
                  'Mode',
                  ['act', 'plan'] as const,
                  value.mode ?? 'act',
                  (mode) => (mode === 'plan' ? 'Plan' : 'Act'),
                  (mode) => set({ ...value, mode }),
                )}
              {words(
                'Access',
                ['ask', 'edit', 'full'] as const,
                value.access ?? 'ask',
                accessName,
                (access) => set({ ...value, access }),
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export interface Picture extends Pick<AttachmentInfo, 'id' | 'name' | 'mediaType'> {
  bytes?: number;
  data?: string;
  url?: string;
  unavailable?: boolean;
}

export function Pictures({
  pictures,
  remove,
  disabled,
}: {
  pictures: Picture[];
  remove(id: string): void;
  disabled: boolean;
}) {
  if (!pictures.length) return null;
  return (
    <div className="composer-pictures">
      {pictures.map((picture) =>
        picture.unavailable ? (
          <button
            key={picture.id}
            type="button"
            disabled={disabled}
            onClick={() => remove(picture.id)}
            className="file-chip is-missing"
            title="Not on this Mac any more"
          >
            {picture.name}
          </button>
        ) : /^image\/(png|jpeg|gif|webp)$/.test(picture.mediaType) ? (
          <button
            key={picture.id}
            type="button"
            disabled={disabled}
            onClick={() => remove(picture.id)}
            className="picture"
            title={`Remove ${picture.name}`}
            aria-label={`Remove ${picture.name}`}
          >
            <img src={picture.url} alt={picture.name} />
            <span aria-hidden="true">×</span>
          </button>
        ) : (
          <button
            key={picture.id}
            type="button"
            disabled={disabled}
            onClick={() => remove(picture.id)}
            className="file-chip"
            title={`Remove ${picture.name}`}
            aria-label={`Remove ${picture.name}`}
          >
            {picture.name}
            <span aria-hidden="true"> ×</span>
          </button>
        ),
      )}
    </div>
  );
}

/** A paperclip: any file, the way pasting or dropping one works. */
export function Attach({
  add,
  disabled,
  accept,
}: {
  add(files: File[]): void;
  disabled?: boolean;
  accept?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span style={{ position: 'relative' }}>
      <button
        type="button"
        className="attach quiet"
        aria-label="Attach files"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M13 7.5 8.2 12.3a3 3 0 0 1-4.3-4.3l5.3-5.3a2 2 0 0 1 2.9 2.9L6.8 10.9a1 1 0 0 1-1.4-1.4l4.6-4.6" />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={accept}
        onChange={(e) => {
          add(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </span>
  );
}
