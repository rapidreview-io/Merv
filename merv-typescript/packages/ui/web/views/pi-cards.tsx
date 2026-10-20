import { useEffect, useRef, useState } from 'react';
import { call } from '../api';
import { useNow } from '../components';
import { Icon } from '../icons';
import type { PiCommand, PiHostView, PiMachine, PiModel, PiPrompt } from '@merv/pi/models';
import { useMenu } from '../record-picker';

/** ½ vCPU · 4 GiB, with the disk where a machine is chosen. */
const specs = ({ vcpu, memoryGiB, diskGB }: PiMachine, disk = false) =>
  `${vcpu % 1 === 0.5 ? `${Math.floor(vcpu) || ''}½` : vcpu} vCPU · ${memoryGiB} GiB${disk ? ` · ${diskGB} GB` : ''}`;
const label = (host: PiHostView | undefined, key: string) =>
  host?.catalog.find((machine) => machine.key === key)?.label ?? key;
/** How long the current wait has lasted by the server's clock, `skew` ms ahead of this one; a
 * screen reader hears only what is waited on. */
export function Seconds({ since, skew }: { since: string; skew: number }) {
  // Ticks each second; the clock is read as it draws, so a snapshot read between ticks (and
  // with it a new skew) never counts back a second.
  useNow(1000);
  return (
    <span className="tabular" aria-hidden="true">
      {` · ${Math.max(0, Math.floor((Date.now() + skew - Date.parse(since)) / 1000)) || 0} s`}
    </span>
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
        <Icon name="chevrons" />
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
        <Icon name="chevrons" />
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
            <>
              <ul>
                {prompt.turn.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
              <h3>Tools offered ({prompt.turn.tools.length})</h3>
              <p className="pi-context-tools">{prompt.turn.tools.join(', ')}</p>
            </>
          ) : (
            <p className="muted">No turn has been given to the agent yet.</p>
          )}
        </>
      )}
    </section>
  );
}

export function changed(all: PiCommand[], at: number, host?: PiHostView, models?: PiModel[]) {
  const since = (key: 'machine' | 'model') => {
    let before: string | undefined;
    for (let i = at - 1; i >= 0 && !before; i--) before = all[i][key];
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
