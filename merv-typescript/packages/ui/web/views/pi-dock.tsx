/**
 * The Agent beside any other page. Once a conversation has been opened on the Agent page it stays
 * alive while the person goes elsewhere, and a small window floats over the page they are on, at
 * the lower right until it is dragged by its head: the conversation, how its turn stands, and a
 * composer. Expand goes back to the Agent page, where the conversation is whole; Close puts the
 * window away until that page is opened again. When the person's machine is released for
 * inactivity, by the server's clock, the window closes itself and the conversation ends with it.
 * It is not drawn on a phone.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CloseIcon, ExpandIcon } from '../icons';
import type { PiSnapshot } from '../pi-stream';
import type { Row } from '../shell-types';
import { Composer, Standing, Transcript, useAgent, type Conversation } from './pi';

/** Where the window was last dragged to, for every page this browser opens after. */
const PLACE = 'merv:agent-dock';
const ROOM = window.matchMedia('(min-width: 640px)');
const useRoomy = () =>
  useSyncExternalStore(
    (listener) => {
      ROOM.addEventListener('change', listener);
      return () => ROOM.removeEventListener('change', listener);
    },
    () => ROOM.matches,
  );

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

export function PiDock({ rows }: { rows: Row[] }) {
  const agent = useAgent();
  const { pathname } = useLocation();
  const roomy = useRoomy();
  const row = rows.find((row) => row.view.kind === 'pi');
  const here = !!row && (pathname === row.path || pathname.startsWith(`${row.path}/`));
  const pi = agent?.pi;
  const end = agent?.end;
  const drawn = !!row && !here && roomy && !agent?.hidden && !!pi?.snapshot?.commands.length;
  // Away from its page the conversation ends with the machine, whether or not the window is
  // drawn, once nothing the person began is under way: no turn, no question or call on its way,
  // no machine being started, and no question half written in the window.
  const underway =
    !pi ||
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
  return <Floating pi={pi} to={row.path} hide={agent.hide} />;
}

type Spot = { x: number; y: number };
const kept = (): Spot | null => {
  try {
    const spot = JSON.parse(localStorage.getItem(PLACE) ?? 'null');
    return Number.isFinite(spot?.x) && Number.isFinite(spot?.y) ? spot : null;
  } catch {
    return null;
  }
};
/** The same place, moved only as far as keeps the whole window inside the viewport. */
const inside = (spot: Spot, { width, height }: DOMRect): Spot => {
  const x = Math.min(Math.max(0, spot.x), window.innerWidth - width);
  const y = Math.min(Math.max(0, spot.y), window.innerHeight - height);
  return x === spot.x && y === spot.y ? spot : { x, y };
};

function Floating({ pi, to, hide }: { pi: Conversation; to: string; hide(): void }) {
  const navigate = useNavigate();
  const box = useRef<HTMLElement>(null);
  const [spot, setSpot] = useState(kept);
  const held = useRef(spot);
  held.current = spot;
  // Where the pointer took hold of the head, from the window's corner.
  const grab = useRef<Spot | null>(null);
  // A place kept from a larger window, or a window made smaller, is brought back inside it.
  useLayoutEffect(() => {
    const fit = () =>
      setSpot((spot) =>
        spot && box.current ? inside(spot, box.current.getBoundingClientRect()) : spot,
      );
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  const drop = () => {
    if (!grab.current) return;
    grab.current = null;
    try {
      if (held.current) localStorage.setItem(PLACE, JSON.stringify(held.current));
    } catch {
      /* the window stays where it is for this page only */
    }
  };
  return (
    <aside
      className="pi-dock"
      role="complementary"
      aria-label="Agent"
      ref={box}
      style={spot ? { left: spot.x, top: spot.y, right: 'auto', bottom: 'auto' } : undefined}
    >
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
          <Standing pi={pi} />
        </span>
        <button
          type="button"
          className="btn-icon"
          aria-label="Expand"
          title="Expand"
          onClick={() => navigate(to)}
        >
          <ExpandIcon />
        </button>
        <button type="button" className="btn-icon" aria-label="Close" title="Close" onClick={hide}>
          <CloseIcon />
        </button>
      </div>
      <Transcript pi={pi} />
      {pi.error && (
        <p className="pi-error" role="alert">
          {pi.error}
        </p>
      )}
      {pi.streamError && (
        <p className="muted" role="status">
          {pi.streamError}
        </p>
      )}
      <Composer pi={pi} rows={2} />
    </aside>
  );
}
