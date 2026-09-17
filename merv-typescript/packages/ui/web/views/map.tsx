import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { GitHubStatus } from '@merv/contracts/github-models';
import { accountRequest, useScopeVersion, useTool } from '../api';
import { useSession } from '../session';
import type { Row, ShellData } from '../shell';
import { KV, KindLabel, StatusPill, cx, kindStyle } from '../components';
import { WORK } from '../navigation';
import { bytes } from './artifacts';
import { useActorNames } from './people';
import { useStanding, type Standing, type Work } from './overview';
import {
  EM,
  graphOf,
  newest,
  tally,
  type Live,
  type MapClaim,
  type MapCycle,
  type MapEdge,
  type MapExperiment,
  type MapNode,
  type MapPaper,
  type MapReflection,
  type MapReview,
  type MapTask,
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
/** The cadence of everything live on the map; useTool stops it while the tab is hidden. */
const LIVE = { every: 10_000 };
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

/** Whose move the open work is, in three numbers, one click from the line itself. */
function Now({ standing }: { standing: Standing }) {
  const { yours, agent, nobody } = standing.lines;
  return (
    <div className="map-now">
      <h2 className="plane-title">Now</h2>
      {Object.entries({
        'need you': yours,
        'with an agent': agent,
        'waiting on a dependency': nobody,
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
  const named = useActorNames();
  const [params, setParams] = useSearchParams();
  const rows = shell.rows;
  const rowOf = (kind: string) => rows.find((row) => row.view.kind === kind);
  const read = (kind: string) => {
    const row = rowOf(kind);
    return row?.readable ? row : undefined;
  };
  const rowId = (row?: Row) => ({ rowId: row?.id ?? '' });
  const experimentsRow = rowOf('experiments');
  const tasksRow = rowOf('tasks');
  const cyclesRow = rowOf('research');
  const reflectionsRow = read('reflections');
  const paperRow = read('paper');
  const sessionsRow = read('sessions');
  const mountsRow = read('connections');
  const filesRow = rowOf('artifacts');
  const feedRow = rowOf('feed');
  const archiveRow = read('legacy-history');
  const codeRow = rowOf('code');
  const experiments = useTool<MapExperiment[]>(experimentsRow ? 'experiment.list' : null, {}, LIVE);
  const tasks = useTool<MapTask[]>(tasksRow ? 'task.list' : null, {}, LIVE);
  const cycles = useTool<MapCycle[]>(cyclesRow ? 'research.list' : null, {}, LIVE);
  const claims = useTool<MapClaim[]>(rowOf('claims') ? 'claim.list' : null, {}, LIVE);
  const reviews = useTool<MapReview[]>(rowOf('reviews') ? 'review.list' : null, {}, LIVE);
  const reflections = useTool<MapReflection[]>(
    reflectionsRow ? 'ui.read' : null,
    rowId(reflectionsRow),
    LIVE,
  );
  const paper = useTool<MapPaper>(paperRow ? 'ui.read' : null, rowId(paperRow));
  const live = useTool<Live>(sessionsRow ? 'ui.read' : null, rowId(sessionsRow), LIVE);
  const mounts = useTool<{ state: string }[]>(mountsRow ? 'ui.read' : null, rowId(mountsRow), LIVE);
  const files = useTool<{ size: number }[]>(filesRow ? 'artifact.list' : null);
  const posts = useTool<unknown[]>(feedRow ? 'feed.list' : null);
  const earlier = useTool<{ counts: Record<string, number> }>(archiveRow ? 'ui.read' : null, {
    ...rowId(archiveRow),
    params: { action: 'summary' },
  });
  const github = useGitHub(!!codeRow);
  const work: Work = {
    experiments: { row: experimentsRow, load: experiments },
    tasks: { row: tasksRow, load: tasks },
    cycles: { row: cyclesRow, load: cycles },
  };
  const standing = useStanding(rows, work, session.actor.id, named);

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
      claims: claims.data ?? [],
      experiments: experiments.data ?? [],
      tasks: tasks.data ?? [],
      reviews: reviews.data ?? [],
      reflections: reflections.data ?? [],
      paper: paper.data,
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
  // One line at the top says a read failed, whichever read it was.
  const record = [experiments, tasks, cycles, claims, reviews, reflections, paper];
  const broken = [...record, live, mounts, files, posts, earlier].find((load) => load.error);
  // A registered row always states its own weight: a total not yet known is the
  // em dash the console uses, never a zero and never a tile that quietly vanishes.
  const counted = (kind: string) => {
    const row = rowOf(kind);
    return row && tile(row.label, row.status.count ?? EM, row.path);
  };
  const cycle = newest(cycles.data ?? [], (item) => item.workflow.updatedAt)[0];
  // One number for the wave: the two rows' own open counts, and the dash if either is silent.
  const counts = [tasksRow, experimentsRow].flatMap((row) => (row ? [row.status.count] : []));
  const openWork = counts.some((count) => count === undefined)
    ? EM
    : counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
  const ready = (mounts.data ?? []).filter((mount) => mount.state === 'ready').length;
  const agents = (live.data?.agents ?? []).filter((agent) => agent.status !== 'retired').length;
  const runners = (live.data?.runners ?? []).filter((runner) => runner.live).length;
  const archive = Object.values(earlier.data?.counts ?? {}).reduce((sum, n) => sum + n, 0);
  const retained = (files.data ?? []).reduce((sum, file) => sum + file.size, 0);
  return (
    <div className="page-stage map">
      <h1 className="page-title">
        {session.project.name} <span className="muted">· the map</span>
      </h1>
      {broken?.error && (
        <p className="map-stale" role="alert" title={broken.error.message}>
          {broken.data
            ? 'Some of this could not refresh — showing the last loaded state'
            : 'Some of this could not load'}{' '}
          <span className="mono">({broken.error.code})</span>
        </p>
      )}
      <Now standing={standing} />
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
                {cycle.workflow.state}
              </>
            )
          }
        />
        <Plane
          title="Analytics"
          index={1}
          tiles={tiles(
            ...tally(claims.data ?? [], (claim) => claim.status).map(([label, count]) =>
              tile(`claims ${label}`, count, rowOf('claims')!.path),
            ),
            ...tally(reviews.data ?? [], (review) => review.verdict).map(([label, count]) =>
              tile(`verdicts ${label}`, count, rowOf('reviews')!.path),
            ),
          )}
        />
        <Plane
          title="Integrations"
          index={2}
          tiles={tiles(
            codeRow &&
              tile(github?.repository?.fullName ?? 'GitHub', github?.status ?? EM, codeRow.path),
            mountsRow &&
              tile(
                'connections ready',
                mounts.data ? `${ready}/${mounts.data.length}` : EM,
                mountsRow.path,
              ),
          )}
        />
      </div>
      {/* The record plane exists only when there are records: no placeholder. */}
      {shown.length > 0 && (
        <Graph
          nodes={shown}
          edges={edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to))}
          selected={selected}
          pulse={standing.lines.yours[0]?.id}
          onSelect={select}
        />
      )}
      {node && <Properties key={node.id} node={node} pool={pool} edges={edges} onSelect={select} />}
      <div className="map-band">
        <Plane
          title="Data"
          index={3}
          tiles={tiles(
            filesRow && tile('files', files.data?.length ?? EM, filesRow.path),
            filesRow && tile('retained', files.data ? bytes(retained) : EM, filesRow.path),
            feedRow && tile('posts', posts.data?.length ?? EM, feedRow.path),
            archiveRow && !!archive && tile('earlier records', archive, archiveRow.path),
          )}
        />
        <Plane
          title="Agents & compute"
          index={4}
          tiles={tiles(
            sessionsRow && tile('agents', live.data ? agents : EM, sessionsRow.path),
            sessionsRow &&
              tile(
                'leases live',
                live.data ? `${live.data.liveSessionCount}/${live.data.sessionTotal}` : EM,
                sessionsRow.path,
              ),
            sessionsRow &&
              tile(
                'runners connected',
                live.data ? `${runners}/${live.data.runners.length}` : EM,
                sessionsRow.path,
              ),
            sessionsRow && tile('queued', live.data?.queueTotal ?? EM, sessionsRow.path),
          )}
        />
      </div>
    </div>
  );
}
