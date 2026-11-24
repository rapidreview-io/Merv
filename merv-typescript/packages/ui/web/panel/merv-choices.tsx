/**
 * What applies to Merv around its reply box, in the same places and type as a main thread's. Inside the box at its
 * left, where a main thread keeps its paperclip, Merv's voice: its orb, which switches it on and off. With the box,
 * the model it thinks with, a press away from the others it may use.
 */
import { useId, useRef, useState } from 'react';
import { useDismiss } from './use-dismiss';
import { OrbCanvas } from './orb';

interface MervModel {
  id: string;
  name: string;
}

/** Merv's voice as a switch: the orb the board's toolbar shows, inside the reply box at its left. Off, it rests dim
 *  and grey; on, it is live, and while Merv hears (listening, speaking, working) it turns and breathes in Merv's colour. */
export function MervVoice({
  on,
  hearing,
  toggle,
  disabled,
}: {
  on: boolean;
  /** On and taking in what is said (or answering): the orb is lit and moves. */
  hearing?: boolean;
  toggle(): void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`merv-voice${on ? ' is-live' : ''}${hearing ? ' is-hearing' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label="Voice"
      title={on ? 'Merv is listening: press to stop' : 'Talk with Merv'}
      disabled={disabled}
      onClick={toggle}
    >
      <OrbCanvas kind={on ? 'live' : 'off'} hearing={!!hearing} muted={false} voice="merv" />
    </button>
  );
}

export function MervChoices({
  models,
  model,
  pick,
  disabled,
}: {
  models: MervModel[];
  model?: string;
  pick(id: string): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const root = useDismiss<HTMLDivElement>(
    open,
    (event) => {
      setOpen(false);
      if (event.type === 'keydown') button.current?.focus();
    },
    { capture: false, prevent: false },
  );
  const id = useId();
  // While the menu is open it keeps what it showed: a conversation reloading for a moment has no models, and the menu
  // must not vanish under the finger choosing from it.
  const kept = useRef(models);
  if (models.length || !open) kept.current = models;
  const list = kept.current;
  const chosen = list.find((item) => item.id === model) ?? list[0];
  if (!chosen) return null;
  return (
    <div className={`session-choices${open ? ' is-chosen' : ''}`} ref={root}>
      <button
        ref={button}
        type="button"
        className="choice-summary"
        disabled={disabled || list.length < 2}
        aria-label={`Merv's model: ${chosen.name}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {chosen.name}
      </button>
      {open && (
        <div className="choice-menu" role="dialog" aria-label="Merv's model">
          <div className="choice-models" role="listbox" id={id} aria-label="Models">
            {list.map((item) => (
              <button
                type="button"
                role="option"
                key={item.id}
                aria-selected={item.id === chosen?.id}
                data-active={item.id === chosen?.id}
                disabled={disabled}
                onClick={() => {
                  setOpen(false);
                  if (item.id !== chosen?.id) pick(item.id);
                }}
              >
                <span>{item.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
