import { Fragment, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { call } from '../api';
import { cx, KV, Summary, useNow, type KVRow } from '../components';
import { ChevronsIcon } from '../icons';
import { hasAnsi } from '../ansi';
import { AnsiText } from '../code-block';
import { JsonView, readJson } from '../json-view';
import { RecordText, useRecordNames, type RecordNames } from '../markdown';
import type {
  PiCommand,
  PiHostView,
  PiMachine,
  PiModel,
  PiPrompt,
  PiProposal,
} from '@merv/pi/models';
import { stepped } from '../record-picker';
import { actOf, factsOf, type Fact } from './pi-proposal';

/** ½ vCPU · 4 GiB, with the disk where a machine is chosen. */
const specs = ({ vcpu, memoryGiB, diskGB }: PiMachine, disk = false) =>
  `${vcpu % 1 === 0.5 ? `${Math.floor(vcpu) || ''}½` : vcpu} vCPU · ${memoryGiB} GiB${disk ? ` · ${diskGB} GB` : ''}`;
const label = (host: PiHostView | undefined, key: string) =>
  host?.catalog.find((machine) => machine.key === key)?.label ?? key;
/** How long the current wait has lasted by the server's clock, `skew` ms ahead of this one; a
 * screen reader hears only what is waited on. */
export function Seconds({ since, skew }: { since: string; skew: number }) {
  const now = useNow(1000);
  return (
    <span className="tabular" aria-hidden="true">
      {` · ${Math.max(0, Math.floor((now + skew - Date.parse(since)) / 1000)) || 0} s`}
    </span>
  );
}
/** Operated as the account menu is: the cursor goes to its first item, the arrows, Home and End
 * move it, Escape hands it back to the button, and Tab or a click elsewhere shuts it. A menu that
 * turns into its guard is a new `open`, so the cursor starts again at its first item. */
export function useMenu(box: RefObject<HTMLElement>, open: unknown, shut: () => void) {
  useEffect(() => {
    if (!open) return;
    const items = () => [
      ...(box.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []),
    ];
    items()[0]?.focus();
    const click = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) shut();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        shut();
        box.current?.querySelector('button')?.focus();
      } else if (event.key === 'Tab') shut();
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const all = items();
        all[
          stepped(all.indexOf(document.activeElement as HTMLElement), all.length, event.key)
        ]?.focus();
        event.preventDefault();
      }
    };
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', click);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
}

/** A result as text, its links live. */
const linked = (text: string) =>
  text.split(/(https?:\/\/[^\s"]+)/).map((part, index) =>
    index % 2 ? (
      <a key={index} href={part} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      part
    ),
  );
/**
 * What came back for a call: a tree where it is JSON, a terminal's colours where a command
 * printed them, and otherwise text with its links live.
 */
function Returned({ text }: { text: string }) {
  const names = useRecordNames(text);
  const json = useMemo(() => readJson(text), [text]);
  return json ? (
    <JsonView value={json.value} names={names} />
  ) : (
    <p className="pi-returned">{hasAnsi(text) ? <AnsiText text={text} /> : linked(text)}</p>
  );
}

/** Past this many characters a fact is folded to its first lines. */
const LONG = 160;
/** One fact's words, as one piece of text, so names and links stay inside its sentence. */
function FactValue({ fact, names }: { fact: Fact; names: RecordNames }) {
  const items = 'list' in fact ? fact.list : 'text' in fact ? [fact.text] : [];
  // A long one is its own fold: shut, its first lines; open, all of it.
  if (items.length === 1 && items[0]!.length > LONG)
    return (
      <details className="pi-fact-long">
        <Summary>
          <span>
            <RecordText text={items[0]!} names={names} plain />
          </span>
        </Summary>
      </details>
    );
  return (
    <span>
      {items.map((item, at) => (
        <Fragment key={at}>
          {at > 0 && ', '}
          <RecordText text={item} names={names} />
        </Fragment>
      ))}
    </span>
  );
}
/** Something nested in a call's input: a fold named by its key, read as a tree once opened. */
function Nested({ label, tree, names }: { label: string; tree: object; names: RecordNames }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="pi-fact-tree" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <Summary>{label}</Summary>
      {open && <JsonView value={tree} names={names} />}
    </details>
  );
}

/**
 * How a call the person ran came out, said once: the word, why it was refused, and what came back
 * in a fold. It stands in the call's card while the card is drawn, and otherwise on a quiet line of
 * its own where the agent was told, named by the act: never as a message of the person's. A
 * result this page holds for the person alone stands open.
 */
export function Outcome({
  proposal,
  result,
  named,
}: {
  proposal: PiProposal;
  result?: string;
  named?: boolean;
}) {
  const [open, setOpen] = useState(!!proposal.secret);
  const { ran } = proposal;
  const failed = ran?.ok === false;
  const refused = failed ? ran?.said : undefined;
  const shown = result ?? (failed ? undefined : ran?.said);
  // Pi keeps no outcome while the call runs; one a restart cut off may have run.
  const word =
    ran && ran.ok === undefined && result === undefined
      ? 'Running'
      : ran?.code === 'interrupted'
        ? 'Interrupted'
        : failed
          ? 'Refused'
          : 'Ran';
  return (
    <div className="pi-receipt" title={named ? proposal.name : undefined}>
      <div className="pi-receipt-line">
        <span className={cx('pi-receipt-word', failed && 'pi-refused')}>{word}</span>
        {named && <span className="pi-receipt-act">{actOf(proposal)}</span>}
        {refused && (
          <>
            <span className="ghost" aria-hidden="true">
              ·
            </span>
            <span>{refused}</span>
          </>
        )}
        {shown !== undefined && (
          <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
            <Summary>Result</Summary>
          </details>
        )}
      </div>
      {open && shown !== undefined && <Returned text={shown} />}
    </div>
  );
}

/**
 * A call the agent proposed, in the product's words: the act it performs, its input as facts, and
 * Run, which runs it once as the person and is heard by the act and described by the facts. The
 * tool's own name is only the card's hover title. Once it ran, how it came out stands where Run did.
 */
export function Proposal({
  proposal,
  result,
  disabled,
  run,
}: {
  proposal: PiProposal;
  result?: string;
  disabled: boolean;
  run(): void;
}) {
  const id = useId();
  const facts = factsOf(proposal);
  const names = useRecordNames(JSON.stringify(proposal.input) ?? '');
  return (
    <article className="pi-proposal" title={proposal.name}>
      <p className="pi-proposal-act" id={`${id}act`}>
        {actOf(proposal)}
      </p>
      {facts.length > 0 && (
        <div className="pi-proposal-facts" id={`${id}facts`}>
          <KV
            rows={facts.map(
              (fact): KVRow =>
                !('tree' in fact) && [fact.label, <FactValue fact={fact} names={names} />],
            )}
          />
          {facts.map(
            (fact) =>
              'tree' in fact && (
                <Nested key={fact.key} label={fact.label} tree={fact.tree} names={names} />
              ),
          )}
        </div>
      )}
      {proposal.ran || result !== undefined ? (
        <Outcome proposal={proposal} result={result} />
      ) : (
        <button
          className="btn btn--sm"
          type="button"
          id={`${id}run`}
          aria-labelledby={`${id}run ${id}act`}
          aria-describedby={facts.length ? `${id}facts` : undefined}
          disabled={disabled}
          onClick={run}
        >
          Run as me
        </button>
      )}
    </article>
  );
}

/** The person's machine in this project, which all their conversations here share: what it is, a
 * move under way or one that failed, and the picker. Releasing it asks first. */
export function Machine({
  host,
  skew,
  choose,
  stop,
}: {
  host: PiHostView;
  skew: number;
  choose(key: string): void;
  stop(): void;
}) {
  const [menu, setMenu] = useState<false | 'pick' | 'stop'>(false);
  const box = useRef<HTMLDivElement>(null);
  useMenu(box, menu, () => setMenu(false));
  // A deadline's rollover onto the same machine is no news to the person.
  const moving = host.moving?.by === 'deadline' ? null : host.moving;
  const move = host.lastMove?.by === 'deadline' ? null : host.lastMove;
  // A move that failed, while a machine still serves, is news for as long as its idle wait.
  const failed =
    !!host.machine &&
    move?.outcome === 'failed' &&
    Date.now() + skew - Date.parse(move.at) < host.idleSeconds * 1000;
  useNow(failed ? 1000 : 0);
  const on = host.machine ?? host.catalog.find((machine) => machine.key === host.preferred);
  if (!on) return null;
  const chosen = moving?.to ?? on.key;
  const close = (then = () => {}) => {
    setMenu(false);
    box.current?.querySelector('button')?.focus();
    then();
  };
  const actions: [string, () => void, string?][] =
    menu === 'stop'
      ? [
          ['Release machine', () => close(stop), ' pi-menu-item--danger'],
          ['Cancel', () => setMenu('pick')],
        ]
      : host.state === 'none' && !host.moving
        ? []
        : [['Release machine', () => setMenu('stop')]];
  return (
    <div className="pi-switch pi-machine" ref={box}>
      <button
        type="button"
        className="pi-switch-button pi-machine-button"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={() => setMenu((value) => (value ? false : 'pick'))}
      >
        <span aria-live="polite">
          {moving ? (
            <>
              Moving to a {label(host, moving.to)} machine
              <Seconds since={moving.since} skew={skew} />
            </>
          ) : failed ? (
            `Couldn’t start ${label(host, move.to)}${move.reason ? `: ${move.reason}` : ''}. Still on ${on.label}.`
          ) : (
            <>
              {on.label}
              <span className="pi-machine-specs"> · {specs(on)}</span>
            </>
          )}
        </span>
        <ChevronsIcon />
      </button>
      {menu && (
        <div
          className="pi-menu"
          role="menu"
          aria-label="Machine"
          aria-describedby={menu === 'stop' ? 'pi-machine-stop' : undefined}
        >
          {menu === 'stop' && (
            <p className="pi-menu-note" id="pi-machine-stop" role="none">
              Answers still running here stop too.
            </p>
          )}
          {menu === 'pick' &&
            host.catalog.map((machine) => (
              <button
                key={machine.key}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                className="pi-menu-item"
                aria-checked={machine.key === chosen}
                aria-disabled={!machine.available || undefined}
                onClick={() => {
                  if (!machine.available) return;
                  close();
                  // The machine it runs on, picked during a move, calls the move off.
                  if (machine.key !== chosen) choose(machine.key);
                }}
              >
                <span>{machine.label}</span>
                <small>{machine.available ? specs(machine, true) : machine.reason}</small>
              </button>
            ))}
          {actions.map(([words, act, tone = '']) => (
            <button
              key={words}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`pi-menu-item${tone}`}
              onClick={act}
            >
              {words}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The model this conversation's next answer uses, and its picker: labels alone. Only the person
 * changes it; an answer under way keeps its own. */
export function Model({
  models,
  model,
  busy,
  pick,
}: {
  models: PiModel[];
  model?: string;
  busy: boolean;
  pick(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useMenu(box, open, () => setOpen(false));
  return (
    <div className="pi-switch pi-model" ref={box}>
      <button
        type="button"
        className="pi-switch-button pi-model-button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-live="polite">
          <span className="sr-only">Model: </span>
          {models.find(({ id }) => id === model)?.label ?? model}
        </span>
        <ChevronsIcon />
      </button>
      {open && (
        <div className="pi-menu" role="menu" aria-label="Model">
          {models.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              className="pi-menu-item"
              aria-checked={id === model}
              onClick={() => {
                setOpen(false);
                box.current?.querySelector('button')?.focus();
                if (id !== model) pick(id);
              }}
            >
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** What the agent is given: the instructions every turn shares, then the latest turn's notes and
 * the tools it was offered, exactly as that turn was served. Read again when a turn begins. */
export function Context({ id, turns }: { id: string; turns: number }) {
  const [prompt, setPrompt] = useState<PiPrompt | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    call<PiPrompt>('pi.prompt', { id }).then(
      (value) => live && (setPrompt(value), setFailed(false)),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [id, turns]);
  return (
    <section className="pi-context" aria-label="What the agent is given">
      <p className="muted">
        The agent's system prompt is these instructions with the turn's notes after them; the tools
        are offered beside it.
      </p>
      {failed && <p role="alert">Couldn't read what the agent is given.</p>}
      {!prompt && !failed && <p role="status">Reading…</p>}
      {prompt && (
        <>
          <h3>Instructions</h3>
          <pre className="pi-context-text">{prompt.instructions}</pre>
          <h3>Latest turn's notes</h3>
          {prompt.turn ? (
            <ul>
              {prompt.turn.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">No turn has been given to the agent yet.</p>
          )}
          {prompt.turn && (
            <>
              <h3>Tools offered ({prompt.turn.tools.length})</h3>
              <p className="pi-context-tools">{prompt.turn.tools.join(', ')}</p>
            </>
          )}
        </>
      )}
    </section>
  );
}

export function changed(all: PiCommand[], at: number, host?: PiHostView, models?: PiModel[]) {
  const since = (key: 'machine' | 'model') => {
    const before = all
      .slice(0, at)
      .reverse()
      .find((turn) => turn[key])?.[key];
    return before && all[at][key] !== before ? all[at][key] : undefined;
  };
  const [machine, model] = [since('machine'), since('model')];
  const words = [
    machine && `Moved to ${label(host, machine)}`,
    model && `Switched to ${models?.find(({ id }) => id === model)?.label ?? model}`,
  ].filter(Boolean);
  return (
    words.length > 0 && (
      <p className="pi-divider" key={`${all[at].id}-changed`}>
        {words.join(' · ')}
      </p>
    )
  );
}
