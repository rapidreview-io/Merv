import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { GitHubStatus } from '@merv/contracts/types';
import { accountRequest, useScopeVersion } from '../api';
import { useSession } from '../session';
import type { ShellData, WorkflowShape } from '../shell';
import { KV, KindLabel, StatusPill, cx, kindStyle, words } from '../components';
import { WORK } from '../navigation';
import { RowDiagram } from '../process';
import { bytes } from './artifacts';
import { namesOf } from './people';
import { standingOf, type Lines } from './overview';
import {
  EM,
  graphOf,
  newest,
  running,
  tally,
  useHome,
  type MapEdge,
  type MapNode,
} from './map-data';

/**
 * The map: the whole project at a glance and deliberately no more. Planes of
 * counts above and below, the record itself in the middle as an object graph
 * whose every node is a record and every edge a field one record carries about
 * another. Nothing here is written by an agent and nothing is composed by the
 * browser: a relation no field expresses is left out rather than guessed, every
 * number links to the page that can act on it, and the one accent on the page
 * is the way out of the map into the record.
 */

/** One tile on a plane: a metric, its value and the page that owns it. */
interface Tile {
  label: string;
  value: ReactNode;
  to: string;
}
const PER_COLUMN = 4;
const CARD_H = 90;
const ROW_H = 108;
const HEAD_H = 30;
const GAP = 14;
const tile = (label: string, value: ReactNode, to: string): Tile => ({ label, value, to });
const tiles = (...items: (Tile | false | undefined)[]) =>
  items.filter((item): item is Tile => !!item);

/** The graph places itself from one measured width, so it needs no canvas and no library. */
function Graph({
  nodes,
  edges,
  selected,
  pulse,
  onSelect,
}: {
  nodes: MapNode[];
  edges: MapEdge[];
  selected: string | null;
  pulse?: string;
  onSelect(id: string): void;
}) {
  const navigate = useNavigate();
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]!.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A selection made with the keyboard takes the focus ring with it.
  useEffect(() => {
    if (!selected || !frame.current?.contains(document.activeElement)) return;
    frame.current.querySelector<HTMLElement>(`[data-object="${CSS.escape(selected)}"]`)?.focus();
  }, [selected]);
  const wide = width >= 720;
  const column = width / 4;
  // The columns leave four gaps of room between cards so a verb never hides under one.
  const card = Math.max(140, column - GAP * 4);
  const used = [0, 0, 0, 0];
  const at = new Map<string, { x: number; y: number }>();
  for (const node of nodes)
    at.set(node.id, { x: node.col * column + GAP, y: HEAD_H + used[node.col]!++ * ROW_H });
  const height = HEAD_H + Math.max(...used, 1) * ROW_H;
  /** One curve between two placed cards, with room for its verb at the middle. */
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const [sy, ey] = [a.y + CARD_H / 2, b.y + CARD_H / 2];
    if (a.x === b.x) {
      const x = a.x + card;
      return {
        d: `M ${x} ${sy} C ${x + 34} ${sy} ${x + 34} ${ey} ${x} ${ey}`,
        x: x + 26,
        y: (sy + ey) / 2,
      };
    }
    const [sx, ex] = a.x < b.x ? [a.x + card, b.x] : [a.x, b.x + card];
    const mx = (sx + ex) / 2;
    return {
      d: `M ${sx} ${sy} C ${mx} ${sy} ${mx} ${ey} ${ex} ${ey}`,
      x: mx,
      y: (sy + ey) / 2 - 7,
    };
  };
  // Hovering or selecting an object is the only thing that dims the rest.
  const focus = hover ?? selected;
  const near = new Set(focus ? [focus] : []);
  for (const edge of edges) {
    if (edge.from === focus) near.add(edge.to);
    if (edge.to === focus) near.add(edge.from);
  }
  const step = (delta: number, across: boolean) => {
    const index = nodes.findIndex((node) => node.id === selected);
    const target = across
      ? nodes.find((node) => node.col === (nodes[index]?.col ?? 0) + delta)
      : nodes[Math.min(nodes.length - 1, Math.max(0, index + delta))];
    if (target && target.id !== selected) onSelect(target.id);
  };
  const MOVES: Record<string, [number, boolean]> = {
    ArrowDown: [1, false],
    j: [1, false],
    ArrowUp: [-1, false],
    k: [-1, false],
    ArrowRight: [1, true],
    ArrowLeft: [-1, true],
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const node = nodes.find((item) => item.id === selected);
    if (event.key === 'Escape' && selected) onSelect(selected);
    else if (event.key === 'Enter' && node) navigate(node.to);
    else if (MOVES[event.key]) step(...MOVES[event.key]!);
    else return;
    event.preventDefault();
  };
  return (
    <div
      className={cx('plane', 'map-graph', !wide && 'map-graph--stacked')}
      ref={frame}
      tabIndex={0}
      role="group"
      aria-label="The record"
      onKeyDown={onKeyDown}
      style={wide ? { height, animationDelay: '180ms' } : { animationDelay: '180ms' }}
    >
      <h2 className="plane-title">The record</h2>
      {wide && (
        <svg className="map-edges" width={width} height={height} aria-hidden="true">
          {edges.map((edge) => {
            const line = curve(at.get(edge.from)!, at.get(edge.to)!);
            const on = !!focus && (edge.from === focus || edge.to === focus);
            return (
              <g
                className={cx('map-edge', on && 'on', focus && !on && 'dim')}
                key={`${edge.from}|${edge.to}|${edge.verb}`}
              >
                <path className="map-edge-hit" d={line.d} />
                <path d={line.d} />
                <text x={line.x} y={line.y}>
                  {edge.verb}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {nodes.map((node) => (
        <button
          type="button"
          key={node.id}
          className={cx(
            'record',
            'map-node',
            selected === node.id && 'on',
            node.live && 'live',
            pulse === node.id && 'pulse',
            focus && !near.has(node.id) && 'dim',
          )}
          data-object={node.id}
          aria-pressed={selected === node.id}
          onClick={() => onSelect(node.id)}
          onMouseEnter={() => setHover(node.id)}
          onMouseLeave={() => setHover((id) => (id === node.id ? null : id))}
          style={
            wide
              ? {
                  ...kindStyle(node.kind),
                  position: 'absolute',
                  left: at.get(node.id)!.x,
                  top: at.get(node.id)!.y,
                  width: card,
                }
              : kindStyle(node.kind)
          }
        >
          <KindLabel kind={node.kind} />
          <span className="map-node-name">{node.name}</span>
          <StatusPill value={node.state} />
        </button>
      ))}
    </div>
  );
}

/** What one object is, in its own fields and its own relations, and the way out. */
function Properties({
  node,
  pool,
  edges,
  onSelect,
}: {
  node: MapNode;
  pool: MapNode[];
  edges: MapEdge[];
  onSelect(id: string): void;
}) {
  const related = edges
    .filter((edge) => edge.from === node.id || edge.to === node.id)
    .map((edge) => ({
      edge,
      other: pool.find((item) => item.id === (edge.from === node.id ? edge.to : edge.from)),
    }))
    .filter((item): item is { edge: MapEdge; other: MapNode } => !!item.other);
  return (
    <div className="record map-props">
      <KindLabel kind={node.kind} />
      <strong className="map-props-name">{node.name}</strong>
      <StatusPill value={node.state} />
      <KV rows={node.props} />
      {related.map(({ edge, other }) => (
        <button
          type="button"
          className="map-relation"
          key={`${edge.from}|${edge.to}|${edge.verb}`}
          onClick={() => onSelect(other.id)}
        >
          <b>{edge.verb}</b> {edge.from === node.id ? '→' : '←'} {other.name}
        </button>
      ))}
      <Link className="map-open" to={node.to}>
        Open record →
      </Link>
    </div>
  );
}

/** A number moves when the record behind it moved, never because a poll happened. */
function Metric({ value }: { value: ReactNode }) {
  const previous = useRef(value);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setChanged(true);
    const timer = setTimeout(() => setChanged(false), 420);
    return () => clearTimeout(timer);
  }, [value]);
  return <span className={cx('plane-value', changed && 'changed')}>{value}</span>;
}

/** A plane states what the project holds; a plane with no readable source says nothing. */
function Plane({
  title,
  tiles,
  note,
  index = 0,
}: {
  title: string;
  tiles: Tile[];
  note?: ReactNode;
  index?: number;
}) {
  if (!tiles.length) return null;
  return (
    <section className="plane" style={{ animationDelay: `${index * 70}ms` }}>
      <h2 className="plane-title">{title}</h2>
      <div className="plane-tiles">
        {tiles.map(({ label, value, to }) => (
          <Link className="tile" key={label} to={to}>
            <Metric value={value} />
            <small>{label}</small>
          </Link>
        ))}
      </div>
      {note && <p className="plane-note">{note}</p>}
    </section>
  );
}

/** The GitHub connection is read where views/github.tsx reads it, once per account scope. */
function useGitHub(enabled: boolean) {
  const epoch = useScopeVersion();
  const [status, setStatus] = useState<GitHubStatus>();
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void accountRequest<GitHubStatus>('/code/github', { scoped: true, credentials: 'same-origin' })
      .then((value) => current && setStatus(value))
      .catch(() => current && setStatus(undefined));
    return () => {
      current = false;
    };
  }, [enabled, epoch]);
  return status;
}

/**
 * Everything in flight, first: one line per live record and the gate it stands
 * at, which is the rung its own ladder marks. The record's state and nothing else.
 */
function Running({ nodes, shapes }: { nodes: MapNode[]; shapes?: WorkflowShape[] }) {
  if (!nodes.length) return null;
  return (
    <ul className="rows map-running">
      {nodes.map((node) => (
        <li className="row" key={node.id}>
          <Link className="row-link" to={node.to}>
            <span className="row-name">
              <KindLabel kind={node.kind} />
              <strong>{node.name}</strong>
            </span>
            <span className="cluster">
              <StatusPill value={node.state} />
              {node.flow && <RowDiagram shapes={shapes} workflow={node.flow} kind={node.kind} />}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Whose move the open work is, in three numbers, one click from the line itself. */
function Now({ lines }: { lines: Lines }) {
  const { yours, agent, nobody, unknown } = lines;
  return (
    <div className="map-now">
      <h2 className="plane-title">Now</h2>
      {Object.entries({
        'need you': yours,
        'with an agent': agent,
        waiting: [...nobody, ...unknown],
      }).map(([label, lines]) => (
        <Link className="map-now-count" key={label} to="/now">
          <b>{lines.length}</b> {label}
        </Link>
      ))}
      <Link className="map-now-all" to="/now">
        The standing line →
      </Link>
    </div>
  );
}

export function MapView({ shell }: { shell: ShellData }) {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const rows = shell.rows;
  const rowOf = (kind: string) => rows.find((row) => row.view.kind === kind);
  const experimentsRow = rowOf('experiments');
  const tasksRow = rowOf('tasks');
  const cyclesRow = rowOf('research');
  const sessionsRow = rowOf('sessions');
  const mountsRow = rowOf('connections');
  const filesRow = rowOf('artifacts');
  const archiveRow = rowOf('legacy-history');
  const codeRow = rowOf('code');
  // The whole page in one answer; the rail asks for the same one and joins this request.
  const home = useHome();
  const data = home.data;
  const named = namesOf(data?.actors);
  const github = useGitHub(!!codeRow);
  const lines = standingOf(rows, data, session.actor.id, named);

  const selected = params.get('object');
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    if (id === selected) next.delete('object');
    else next.set('object', id);
    setParams(next, { replace: true });
  };
  const { pool, edges } = graphOf(
    rows,
    {
      claims: data?.claims ?? [],
      experiments: data?.experiments ?? [],
      tasks: data?.tasks ?? [],
      reviews: data?.reviews ?? [],
      reflections: data?.reflections ?? [],
      paper: data?.paper ?? undefined,
    },
    named,
  );
  // Newest first in each column; a chosen object takes the oldest slot rather than
  // reordering the column, so the keyboard keeps stepping in the order on screen.
  const shown = [0, 1, 2, 3].flatMap((column) => {
    const all = newest(
      pool.filter((node) => node.col === column),
      (node) => node.at,
    );
    const drawn = all.slice(0, PER_COLUMN);
    const chosen = all.find((node) => node.id === selected);
    if (chosen && !drawn.includes(chosen)) drawn.splice(PER_COLUMN - 1, 1, chosen);
    return newest(drawn, (node) => node.at);
  });
  const visible = new Set(shown.map((node) => node.id));
  const node = pool.find((item) => item.id === selected);
  // A registered row always states its own weight: a total not yet known is the
  // em dash the console uses, never a zero and never a tile that quietly vanishes.
  const counted = (kind: string) => {
    const row = rowOf(kind);
    return row && tile(row.label, row.status.count ?? EM, row.path);
  };
  const cycle = newest(data?.cycles ?? [], (item) => item.workflow.updatedAt)[0];
  // One number for the wave: the two rows' own open counts, and the dash if either is silent.
  const counts = [tasksRow, experimentsRow].flatMap((row) => (row ? [row.status.count] : []));
  const openWork = counts.some((count) => count === undefined)
    ? EM
    : counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
  const live = data?.sessions;
  const mounts = data?.connections;
  const ready = (mounts ?? []).filter((mount) => mount.state === 'ready').length;
  const agents = (live?.agents ?? []).filter((agent) => agent.status !== 'retired').length;
  const runners = (live?.runners ?? []).filter((runner) => runner.live).length;
  const archive = Object.values(data?.archive?.counts ?? {}).reduce((sum, n) => sum + n, 0);
  const retained = (data?.files ?? []).reduce((sum, file) => sum + file.size, 0);
  return (
    <div className="page-stage map">
      <h1 className="page-title">
        {session.project.name} <span className="muted">· the map</span>
      </h1>
      {home.error && (
        <p className="map-stale" role="alert" title={home.error.message}>
          {data ? 'Could not refresh' : 'Could not load'}{' '}
          <span className="mono">({home.error.code})</span>
        </p>
      )}
      <Running nodes={newest(pool.filter(running), (node) => node.at)} shapes={shell.workflows} />
      <Now lines={lines} />
      <div className="map-band">
        <Plane
          title="Workflows"
          index={0}
          // The plane says what the rail says: one wave of work, and the reflections on it.
          tiles={tiles(
            (tasksRow || experimentsRow) && tile('Work', openWork, WORK.path),
            counted('reflections'),
          )}
          note={
            cycle && (
              <>
                Cycle <Link to={`${cyclesRow!.path}/${cycle.id}`}>{cycle.name}</Link> ·{' '}
                {words(cycle.workflow.state)}
              </>
            )
          }
        />
        <Plane
          title="Analytics"
          index={1}
          tiles={tiles(
            ...tally(data?.claims ?? [], (claim) => claim.status).map(([label, count]) =>
              tile(`claims ${words(label)}`, count, rowOf('claims')!.path),
            ),
            ...tally(data?.reviews ?? [], (review) => review.verdict).map(([label, count]) =>
              tile(`verdicts ${words(label)}`, count, rowOf('reviews')!.path),
            ),
          )}
        />
        <Plane
          title="Integrations"
          index={2}
          tiles={tiles(
            codeRow &&
              tile(
                github?.repository?.fullName ?? 'GitHub',
                github?.status ?? EM,
                '/settings/integrations',
              ),
            mountsRow &&
              tile('connections ready', mounts ? `${ready}/${mounts.length}` : EM, mountsRow.path),
          )}
        />
      </div>
      {/* The record plane exists only when there are records: no placeholder. */}
      {shown.length > 0 && (
        <Graph
          nodes={shown}
          edges={edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to))}
          selected={selected}
          pulse={lines.yours[0]?.id}
          onSelect={select}
        />
      )}
      {node && <Properties key={node.id} node={node} pool={pool} edges={edges} onSelect={select} />}
      <div className="map-band">
        <Plane
          title="Data"
          index={3}
          tiles={tiles(
            filesRow && tile('files', data?.files?.length ?? EM, filesRow.path),
            filesRow && tile('retained', data?.files ? bytes(retained) : EM, filesRow.path),
            archiveRow && !!archive && tile('earlier records', archive, archiveRow.path),
          )}
        />
        <Plane
          title="Agents & compute"
          index={4}
          tiles={tiles(
            sessionsRow && tile('agents', live ? agents : EM, sessionsRow.path),
            sessionsRow &&
              tile(
                'leases live',
                live ? `${live.liveSessionCount}/${live.sessionTotal}` : EM,
                sessionsRow.path,
              ),
            sessionsRow &&
              tile(
                'runners connected',
                live ? `${runners}/${live.runners.length}` : EM,
                sessionsRow.path,
              ),
            sessionsRow && tile('queued', live?.queueTotal ?? EM, sessionsRow.path),
          )}
        />
      </div>
    </div>
  );
}
