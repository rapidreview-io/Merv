/**
 * The customer page's Agent window: a small window over the page, at the lower right until it is
 * dragged by its head, holding the conversation (drawn with Merv's chat parts, views/pi.tsx), how
 * its turn stands and a composer. Expand goes back to the page's chat; Close puts it away. Inside
 * Merv itself the Agent stands in the side panel (board-app/merv-panel.tsx) instead.
 */
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { safely } from '../api';
import { Icon } from '../icons';
import { Speak, Standing, Transcript, useAgent } from '../views/pi';
import type { Conversation } from '../views/pi-conversation';
import type { Voice } from '../views/pi-voice';

/** Where the window was last dragged to, for every page this browser opens after. */
const PLACE = 'merv:agent-dock';

type Spot = { x: number; y: number };
const kept = (): Spot | null =>
  safely(() => {
    const spot = JSON.parse(localStorage.getItem(PLACE) ?? 'null');
    return Number.isFinite(spot?.x) && Number.isFinite(spot?.y) ? spot : null;
  }, null);
/** The same place, moved only as far as keeps the whole window inside the viewport. */
const inside = (spot: Spot, { width, height }: DOMRect, inset = 0): Spot => {
  const x = Math.min(Math.max(inset, spot.x), Math.max(inset, window.innerWidth - width - inset));
  const y = Math.min(Math.max(inset, spot.y), Math.max(inset, window.innerHeight - height - inset));
  return x === spot.x && y === spot.y ? spot : { x, y };
};

export function Floating({
  pi,
  expand,
  voice,
  hide,
  children,
}: {
  pi: Conversation;
  expand(): void;
  voice?: Voice;
  hide(): void;
  children?: ReactNode;
}) {
  const agent = useAgent();
  const activeVoice = voice ?? agent?.voice;
  const compact = !!activeVoice?.compact && activeVoice.state !== 'off';
  const box = useRef<HTMLElement>(null);
  const [spot, setSpot] = useState(kept);
  const held = useRef(spot);
  held.current = spot;
  // Where the pointer took hold of the head, from the window's corner.
  const grab = useRef<Spot | null>(null);
  const origin = useRef<Spot | null>(null);
  const dragged = useRef(false);
  // A place kept from a larger window, or a window made smaller, is brought back inside it.
  useLayoutEffect(() => {
    const fit = () =>
      setSpot((spot) =>
        spot && box.current
          ? inside(spot, box.current.getBoundingClientRect(), compact ? 64 : 0)
          : spot,
      );
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [compact]);
  const drop = () => {
    if (!grab.current) return;
    grab.current = null;
    safely(() => held.current && localStorage.setItem(PLACE, JSON.stringify(held.current)));
  };
  return (
    <aside
      className={`pi-dock${compact ? ' pi-dock--voice' : ''}`}
      role="complementary"
      aria-label="Agent"
      ref={box}
      onPointerDownCapture={(event) => {
        if (
          !compact ||
          event.button ||
          (event.target as Element).closest('.voice-hover-controls') ||
          !box.current
        )
          return;
        const { left, top } = box.current.getBoundingClientRect();
        grab.current = { x: event.clientX - left, y: event.clientY - top };
        origin.current = { x: event.clientX, y: event.clientY };
        dragged.current = false;
      }}
      onPointerMove={(event) => {
        if (!compact || !grab.current || !origin.current || !box.current) return;
        if (
          Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) < 5 &&
          !dragged.current
        )
          return;
        dragged.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setSpot(
          inside(
            { x: event.clientX - grab.current.x, y: event.clientY - grab.current.y },
            box.current.getBoundingClientRect(),
            64,
          ),
        );
      }}
      onPointerUp={() => {
        if (compact) {
          drop();
          origin.current = null;
        }
      }}
      onPointerCancel={() => {
        if (compact) {
          drop();
          origin.current = null;
        }
      }}
      onClickCapture={(event) => {
        if (compact && dragged.current) {
          event.preventDefault();
          event.stopPropagation();
          dragged.current = false;
        }
      }}
      style={spot ? { left: spot.x, top: spot.y, right: 'auto', bottom: 'auto' } : undefined}
    >
      {!compact && (
        <div
          className="pi-dock-head"
          onPointerDown={(event) => {
            if (event.button || (event.target as Element).closest('button') || !box.current) return;
            const { left, top } = box.current.getBoundingClientRect();
            grab.current = { x: event.clientX - left, y: event.clientY - top };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!grab.current || !box.current) return;
            const to = { x: event.clientX - grab.current.x, y: event.clientY - grab.current.y };
            setSpot(inside(to, box.current.getBoundingClientRect()));
          }}
          onPointerUp={drop}
          onPointerCancel={drop}
        >
          <span className="pi-dock-title" title={pi.title}>
            {pi.title}
          </span>
          <span className="pi-state" role="status">
            <Standing pi={pi} dot />
          </span>
          <button
            type="button"
            className="btn-icon"
            aria-label="Expand"
            title="Expand"
            onClick={() => {
              activeVoice?.setCompact(false);
              expand();
            }}
          >
            <Icon name="expand" />
          </button>
          {!compact && (
            <button
              type="button"
              className="btn-icon"
              aria-label="Close"
              title="Close"
              onClick={hide}
            >
              <Icon name="close" />
            </button>
          )}
        </div>
      )}
      {!compact && children}
      {!compact && <Transcript pi={pi} />}
      {!compact && pi.error && (
        <p className="pi-error" role="alert">
          {pi.error}
        </p>
      )}
      {!compact && pi.streamError && (
        <p className="muted" role="status">
          {pi.streamError}
        </p>
      )}
      <Speak pi={pi} rows={2} voice={voice} />
    </aside>
  );
}
