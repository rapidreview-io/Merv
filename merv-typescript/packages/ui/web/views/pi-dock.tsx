/**
 * The Agent beside any other page. Once a conversation has been opened on the Agent page it stays
 * alive while the person goes elsewhere, and a small window floats over the page they are on, at
 * the lower right until it is dragged by its head: the conversation, how its turn stands, and a
 * composer. Expand goes back to the Agent page, where the conversation is whole; Close puts the
 * window away until that page is opened again. When the person's machine is released for
 * inactivity, by the server's clock, the window closes itself and the conversation ends with it.
 * It is not drawn on a phone.
 */
import type { UiRowDescription } from '@merv/ui/rows';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { safely } from '../api';
import { Icon } from '../icons';
import { useRoomy } from '../theme';
import type { PiSnapshot } from '@merv/pi/models';
import { Speak, Standing, Transcript, useAgent } from './pi';
import type { Conversation } from './pi-conversation';
import type { Voice } from './pi-voice';

/** Where the window was last dragged to, for every page this browser opens after. */
const PLACE = 'merv:agent-dock';
/** How long what the agent opened is named in the window. */
const SHOWN_MS = 8_000;

/**
 * When the person's machine is released for inactivity, on this clock: the server's moment less
 * how far its clock runs ahead (`skew`). A machine already gone was released now; null where
 * nothing says when.
 */
function releasedAt({ host }: PiSnapshot, skew: number): number | null {
  if (host.state === 'none') return 0;
  const at = Date.parse(host.idleEndsAt ?? '');
  return Number.isNaN(at) ? null : at - skew;
}

export function PiDock({ rows }: { rows: UiRowDescription[] }) {
  const agent = useAgent();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const roomy = useRoomy();
  const row = rows.find((row) => row.view.kind === 'pi');
  const here = !!row && (pathname === row.path || pathname.startsWith(`${row.path}/`));
  const pi = agent?.pi;
  const end = agent?.end;
  const speaking = agent?.voice.state !== undefined && agent.voice.state !== 'off';
  const drawn =
    !!row && !here && roomy && (speaking || (!agent?.hidden && !!pi?.snapshot?.commands.length));
  // Away from its page the conversation ends with the machine, whether or not the window is
  // drawn, once nothing the person began is under way: no turn, no question or call on its way,
  // no machine being started, and no question half written in the window.
  const underway =
    !pi ||
    speaking ||
    pi.active ||
    pi.busy ||
    !!pi.running ||
    pi.warming.current ||
    (drawn && !!pi.draft.trim());
  const at = !here && pi?.snapshot && !underway ? releasedAt(pi.snapshot, pi.skew.current) : null;
  useEffect(() => {
    if (at === null || !end) return;
    const timer = setTimeout(end, Math.max(0, at - Date.now()));
    return () => clearTimeout(timer);
  }, [at, end]);
  if (!drawn || !pi || !row || !agent) return null;
  return (
    <Floating pi={pi} expand={() => navigate(row.path)} hide={agent.hide}>
      {agent.shown && <Opened key={agent.shown.at} {...agent.shown} />}
    </Floating>
  );
}

/** What the agent just put on the screen, for a few seconds, with the way back from it. */
function Opened({ title, at }: { title: string; at: number }) {
  const navigate = useNavigate();
  const [fresh, setFresh] = useState(() => Date.now() - at < SHOWN_MS);
  useEffect(() => {
    const timer = setTimeout(() => setFresh(false), SHOWN_MS - (Date.now() - at));
    return () => clearTimeout(timer);
  }, [at]);
  if (!fresh) return null;
  return (
    <p className="pi-dock-shown" role="status">
      <span>
        Opened <strong>{title}</strong>
      </span>
      <button type="button" className="btn-text" onClick={() => navigate(-1)}>
        Back
      </button>
    </p>
  );
}

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
