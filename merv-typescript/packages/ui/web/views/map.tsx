import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { GitHubStatus } from '@merv/contracts/types';
import { accountRequest, useScopeVersion } from '../api';
import { useSession } from '../session';
import type { ShellData, WorkflowShape } from '../shell';
import { KV, KindLabel, LoadState, StatusPill, cx, kindOf, kindStyle, words } from '../components';
import { ArrowRightIcon } from '../icons';
import { WORK } from '../navigation';
import { RecordText, useRecordNames, type RecordNames } from '../markdown';
import { RowDiagram } from '../process';
import { bytes } from './artifacts';
import { namesOf } from './people';
import { standingOf, type Lines } from './overview';
import {
  EM,
  graphOf,
  inFlightFirst,
  layoutOf,
  newest,
  plural,
  share,
  tally,
  useHome,
  verdictWord,
  type MapEdge,
  type MapNode,
} from './map-data';

/**
 * The map: the whole project at a glance and deliberately no more. Planes of
 * counts above and below, the records themselves in the middle as an object
 * graph whose every node is a record and every edge a field one record carries
 * about another. Nothing here is written by an agent and nothing is composed by
 * the browser: a relation no field expresses is left out rather than guessed, a
 * number links to the page that shows what it counts or does not link at all,
 * and a record is drawn once — what is in flight leads its column, carrying the
 * workflow it stands in, rather than being listed a second time above the graph.
 */

/** One tile on a plane: what it counts, the count, and the page that shows it. */
interface Tile {
  label: string;
  value: ReactNode;
  /** What the value says, where the value is an element and cannot be compared for itself. */
  said?: string;
  /** Absent where no page lists what the number counts: such a number is not a link. */
  to?: string;
  /** The one small way to change what the tile states, beside the state itself. */
  action?: ReactNode;
}
/** What a column holds beyond the four it draws, and the page that lists the rest. */
interface More {
  col: number;
  count: number;
  noun: string;
  to?: string;
}
const PER_COLUMN = 4;
const tile = (
  label: string,
  value: ReactNode,
  to?: string,
  action?: ReactNode,
  said?: string,
): Tile => ({ label, value, to, action, said });
const tiles = (...items: (Tile | false | undefined)[]) =>
  items.filter((item): item is Tile => !!item);

/** The property card's place in the page, which the card that opened it points at. */
const PROPS = 'map-props';

/**
 * The graph places itself from one measured width, so it needs no canvas and no
 * library. It also places the property card of the record in hand (`card`): under
 * the drawing where there is one, and directly under the chosen record where the
 * records flow as a list — on a phone the end of that list is screens away from
 * the record that was tapped.
 */
export function Graph({
  nodes: given,
  edges,
  more,
  shapes,
  selected,
  pulse,
  card,
  names,
  onSelect,
}: {
  nodes: MapNode[];
  edges: MapEdge[];
  more: More[];
  shapes?: WorkflowShape[];
  selected: string | null;
  pulse?: string;
  card?: ReactNode;
  /** The records a name may mention by id, named from the read the page already made. */
  names?: RecordNames;
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
  // A selection made with the keyboard takes the focus ring with it; one made with
  // the pointer brings the card it opened into view, wherever on the page that is.
  const pointed = useRef(false);
  useEffect(() => {
    if (pointed.current) document.getElementById(PROPS)?.scrollIntoView?.({ block: 'nearest' });
    pointed.current = false;
    if (!selected || !frame.current?.contains(document.activeElement)) return;
    frame.current.querySelector<HTMLElement>(`[data-object="${CSS.escape(selected)}"]`)?.focus();
  }, [selected]);
  // Drawn where the page has the room and the records span columns; otherwise the same
  // cards flow as a list and each says its own relations in words.
  const layout = layoutOf(given, edges, width);
  // The keyboard and the tab order follow what is on screen, not the order it arrived in.
  const nodes = layout?.order ?? given;
  // Hovering or selecting an object is the only thing that dims the rest.
  const focus = hover ?? selected;
  const near = new Set(focus ? [focus] : []);
  for (const edge of edges) {
    if (edge.from === focus) near.add(edge.to);
    if (edge.to === focus) near.add(edge.from);
  }
  const step = (delta: number, across: boolean) => {
    const index = nodes.findIndex((node) => node.id === selected);
    // Only the columns that hold a record are there to step across.
    const columns = [...new Set(nodes.map((node) => node.col))].sort((a, b) => a - b);
    const column = columns[columns.indexOf(nodes[index]?.col ?? columns[0]!) + delta];
    const target = across
      ? nodes.find((node) => node.col === column)
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
    <>
      <div
        className={cx('plane', 'map-graph', !layout && 'map-graph--stacked')}
        ref={frame}
        tabIndex={0}
        role="group"
        aria-label="Records"
        onKeyDown={onKeyDown}
        style={{
          animationDelay: '180ms',
          ...(layout && { height: layout.height + (more.length ? 28 : 0) }),
        }}
      >
        <h2 className="plane-title">Records</h2>
        {layout && (
          <svg className="map-edges" width={width} height={layout.height} aria-hidden="true">
            {layout.lines.map(({ edge, d, x, y, anchor }) => {
              const on = !!focus && (edge.from === focus || edge.to === focus);
              return (
                <g
                  className={cx('map-edge', on && 'on', focus && !on && 'dim')}
                  key={`${edge.from}|${edge.to}|${edge.verb}`}
                >
                  <path className="map-edge-hit" d={d} />
                  <path d={d} />
                  <text x={x} y={y} textAnchor={anchor}>
                    {edge.verb}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
        {nodes.map((node) => (
          <Fragment key={node.id}>
            <button
              type="button"
              className={cx(
                'map-node',
                selected === node.id && 'on',
                node.live && 'live',
                pulse === node.id && 'pulse',
                focus && !near.has(node.id) && 'dim',
              )}
              data-object={node.id}
              aria-pressed={selected === node.id}
              aria-controls={selected === node.id ? PROPS : undefined}
              onClick={() => {
                pointed.current = true;
                onSelect(node.id);
              }}
              onMouseEnter={() => setHover(node.id)}
              onMouseLeave={() => setHover((id) => (id === node.id ? null : id))}
              style={
                layout
                  ? {
                      ...kindStyle(node.kind),
                      position: 'absolute',
                      left: layout.at.get(node.id)!.x,
                      top: layout.at.get(node.id)!.y,
                      width: layout.card,
                    }
                  : kindStyle(node.kind)
              }
            >
              <KindLabel kind={node.kind} />
              {/* A claim is named by its statement, which may mention a record by its id. */}
              <span className="map-node-name">
                <RecordText text={node.name} names={names} plain />
              </span>
              <span className="map-node-foot">
                <StatusPill value={node.state} />
                {node.flow && <RowDiagram shapes={shapes} workflow={node.flow} kind={node.kind} />}
              </span>
              {/* With no room to draw a line, the record says what it points at. */}
              {!layout &&
                edges
                  .filter((edge) => edge.from === node.id)
                  .map((edge) => {
                    const other = nodes.find((item) => item.id === edge.to);
                    return (
                      other && (
                        <span className="map-rel" key={`${edge.to}|${edge.verb}`}>
                          <ArrowRightIcon size={12} />
                          {edge.verb} <KindLabel kind={other.kind} /> {other.name}
                        </span>
                      )
                    );
                  })}
            </button>
            {!layout && selected === node.id && card}
          </Fragment>
        ))}
        {more.map((item) => {
          const x = layout?.columns.find((column) => column.col === item.col)?.x;
          const text = `+${item.count} more ${item.noun}`;
          return (
            <span
              className="map-more"
              key={item.col}
              style={layout ? { position: 'absolute', left: x, top: layout.height } : undefined}
            >
              {item.to ? <Link to={item.to}>{text}</Link> : text}
            </span>
          );
        })}
      </div>
      {layout && card}
    </>
  );
}

/** What one object is, in its own fields and its own relations, and the way out. */
function Properties({
  node,
  pool,
  edges,
  names,
  onSelect,
}: {
  node: MapNode;
  pool: MapNode[];
  edges: MapEdge[];
  names: RecordNames;
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
    // Pressing a record changes this card and nothing else, so the card says so itself.
    <div
      className="record map-props"
      id={PROPS}
      role="region"
      aria-live="polite"
      aria-label={`${kindOf(node.kind).label}: ${node.name}`}
    >
      <KindLabel kind={node.kind} />
      <strong className="map-props-name">
        <RecordText text={node.name} names={names} />
      </strong>
      <StatusPill value={node.state} />
      <KV rows={node.props} />
      {related.map(({ edge, other }) => (
        <button
          type="button"
          className="map-relation"
          key={`${edge.from}|${edge.to}|${edge.verb}`}
          onClick={() => onSelect(other.id)}
        >
          <b>{edge.verb}</b> {edge.from === node.id ? '→' : '←'} <KindLabel kind={other.kind} />{' '}
          {other.name}
        </button>
      ))}
      <Link className="map-open" to={node.to}>
        Open record <ArrowRightIcon size={14} />
      </Link>
    </div>
  );
}

/**
 * A number moves when the record behind it moved, never because a poll happened. A
 * value that is an element is a new object on every render, so it is watched by
 * what it says (`said`) rather than by what it is.
 */
function Metric({ value, said }: { value: ReactNode; said?: string }) {
  const watched = said ?? value;
  const previous = useRef(watched);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (previous.current === watched) return;
    previous.current = watched;
    setChanged(true);
    const timer = setTimeout(() => setChanged(false), 420);
    return () => clearTimeout(timer);
  }, [watched]);
  return <span className={cx('plane-value', changed && 'changed')}>{value}</span>;
}

const singular = (word: string) => word.toLowerCase().replace(/s$/, '');

/** A plane states what the project holds; a plane with no readable source says nothing. */
function Plane({
  title,
  tiles,
  note,
  wide,
  index = 0,
}: {
  title: string;
  tiles: Tile[];
  note?: ReactNode;
  /** The plane that closes a band of two takes the room of the other two columns. */
  wide?: boolean;
  index?: number;
}) {
  if (!tiles.length) return null;
  return (
    <section
      className={cx('plane', wide && 'plane--wide')}
      style={{ animationDelay: `${index * 70}ms` }}
    >
      <h2 className="plane-title">{title}</h2>
      <div className="plane-tiles">
        {tiles.map(({ label, value, to, action, said }) => {
          // The plane's title has already said what a tile of the same name counts, so
          // the word is kept for whoever hears the page and not drawn a second time.
          const repeats = singular(label) === singular(title);
          const face = (
            <>
              <Metric value={value} said={said} />
              <small className={repeats ? 'sr-only' : undefined}>{label}</small>
            </>
          );
          // A tile that carries a control of its own cannot also be one link.
          return to && !action ? (
            <Link className="tile" key={label} to={to}>
              {face}
            </Link>
          ) : (
            <div className={cx('tile', !!action && 'tile--state')} key={label}>
              {face}
              {action}
            </div>
          );
        })}
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
 * An integration is a state, not a number: a pill says how it stands, and where it
 * is not connected whoever may connect it is shown the way to the page that does.
 * Never having been connected is not a failure, so it is not said in a failure's word.
 */
const INTEGRATIONS = '/settings/integrations';
function gitHubTile(github: GitHubStatus | undefined): Tile {
  const label = github?.repository?.fullName ?? 'GitHub';
  if (!github) return tile(label, EM, INTEGRATIONS);
  const state = github.status === 'disconnected' ? 'not connected' : github.status;
  const mends =
    github.configured &&
    github.canManage &&
    (github.status === 'disconnected' || github.status === 'needs_reconnect');
  return tile(
    label,
    <StatusPill value={state} />,
    INTEGRATIONS,
    mends && (
      <Link className="btn btn--sm" to={INTEGRATIONS}>
        {github.status === 'disconnected' ? 'Connect' : 'Reconnect'}
      </Link>
    ),
    state,
  );
}

/** Whose move the open work is, in three numbers; the strip itself is the way to the line. */
function Now({ lines, known }: { lines: Lines; known: boolean }) {
  const { yours, agent, nobody, unknown } = lines;
  const counts: [number, string][] = [
    [yours.length, plural(yours.length, 'needs you', 'need you')],
    [agent.length, plural(agent.length, 'with an agent', 'with agents')],
    [nobody.length + unknown.length, 'waiting'],
  ];
  return (
    <Link
      className="map-now"
      to="/now"
      aria-label={
        known ? `Now: ${counts.map(([count, label]) => `${count} ${label}`).join(', ')}` : 'Now'
      }
    >
      <h2 className="plane-title">Now</h2>
      {counts.map(([count, label]) => (
        <span className="map-now-count" key={label}>
          {/* A count not yet read is the em dash, never a zero. */}
          <b>{known ? count : EM}</b> {label}
        </span>
      ))}
      <ArrowRightIcon className="map-now-go" />
    </Link>
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
  const lines = standingOf(rows, data, session.actor, named);

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
      experiments: data?.experiments ?? [],
      tasks: data?.tasks ?? [],
      reviews: data?.reviews ?? [],
      reflections: data?.reflections ?? [],
      paper: data?.paper ?? undefined,
    },
    named,
  );
  // A statement may mention a record by id; it is named from the lists the app already
  // reads, and only when some name on the map mentions one at all.
  const mentions = useMemo(() => pool.map((item) => item.name).join('\n'), [pool]);
  const names = useRecordNames(mentions);
  // What is in flight leads each column, then the newest; a chosen object takes the last
  // slot rather than reordering the column, so the keyboard keeps stepping in the order
  // on screen. What a column holds beyond its four is one way to the page that lists it.
  const beyond: [string, string | undefined][] = [
    ['paper', rowOf('paper')?.path],
    ['work', WORK.path],
    ['reviews', undefined],
    ['reflections', rowOf('reflections')?.path],
  ];
  const more: More[] = [];
  const shown = [0, 1, 2, 3].flatMap((column) => {
    const all = inFlightFirst(pool.filter((node) => node.col === column));
    const drawn = all.slice(0, PER_COLUMN);
    const chosen = all.find((node) => node.id === selected);
    if (chosen && !drawn.includes(chosen)) drawn.splice(PER_COLUMN - 1, 1, chosen);
    const [noun, to] = beyond[column]!;
    if (all.length > drawn.length)
      more.push({ col: column, count: all.length - drawn.length, noun, to });
    return inFlightFirst(drawn);
  });
  const visible = new Set(shown.map((node) => node.id));
  const node = pool.find((item) => item.id === selected);
  // A registered row always states its own weight: a total not yet known is the
  // em dash the console uses, never a zero and never a tile that quietly vanishes.
  const counted = (kind: string) => {
    const row = rowOf(kind);
    const count = row?.status.count;
    return row && tile(plural(count, kindOf(kind).label, row.label), count ?? EM, row.path);
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
  const files = data?.files?.length;
  const stored = (data?.files ?? []).reduce((sum, file) => sum + file.size, 0);
  // No page lists reviews, so a count of them leads to the one review it counts, or nowhere.
  const reviewsPath = rowOf('reviews')?.path;
  const only = (verdict: string) =>
    (data?.reviews ?? []).filter((review) => review.verdict === verdict)[0]!.id;
  // A failed load says so once; a failed refresh says how old the map still drawn is.
  if (home.error && !data)
    return (
      <div className="page-stage map">
        <h1 className="page-title">{session.project.name}</h1>
        <LoadState {...home} />
      </div>
    );
  return (
    <div className="page-stage map">
      <h1 className="page-title">{session.project.name}</h1>
      {home.error && <LoadState {...home} />}
      <Now lines={lines} known={!!data} />
      <div className="map-band">
        <Plane
          title="Work"
          index={0}
          // The plane says what the rail says: one wave of work, and the reflections on it.
          tiles={tiles(
            (tasksRow || experimentsRow) && tile('Open', openWork, WORK.path),
            counted('reflections'),
          )}
          note={
            cycle && (
              <>
                <KindLabel kind="research" />
                <Link to={`${cyclesRow!.path}/${cycle.id}`}>{cycle.name}</Link>
                <StatusPill value={cycle.workflow.state} />
              </>
            )
          }
        />
        <Plane
          title="Results"
          index={1}
          tiles={tiles(
            ...tally(data?.reviews ?? [], (review) => review.verdict).map(([verdict, count]) =>
              tile(
                `${plural(count, 'Review', 'Reviews')} ${verdictWord(verdict)}`,
                count,
                count === 1 && reviewsPath ? `${reviewsPath}/${only(verdict)}` : undefined,
              ),
            ),
          )}
        />
        <Plane
          title="Integrations"
          index={2}
          tiles={tiles(
            codeRow && gitHubTile(github),
            mountsRow &&
              tile(
                `${plural(mounts?.length, 'Connection', 'Connections')} ready`,
                mounts ? share(ready, mounts.length) : EM,
                mountsRow.path,
              ),
          )}
        />
      </div>
      {/* The records plane exists only when there are records: no placeholder. */}
      {shown.length > 0 && (
        <Graph
          nodes={shown}
          edges={edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to))}
          more={more}
          shapes={shell.workflows}
          selected={selected}
          pulse={lines.yours[0]?.id}
          names={names}
          card={
            node && (
              <Properties
                key={node.id}
                node={node}
                pool={pool}
                edges={edges}
                names={names}
                onSelect={select}
              />
            )
          }
          onSelect={select}
        />
      )}
      <div className="map-band">
        <Plane
          title="Files"
          index={3}
          tiles={tiles(
            // The list carries the newest thousand: at the cap the count is a floor, not a total.
            filesRow &&
              tile(
                plural(files, 'File', 'Files'),
                files === undefined ? EM : `${files}${files >= 1000 ? '+' : ''}`,
                filesRow.path,
              ),
            filesRow &&
              tile(
                'Stored',
                files === undefined ? EM : `${files >= 1000 ? 'at least ' : ''}${bytes(stored)}`,
                filesRow.path,
              ),
            archiveRow &&
              !!archive &&
              tile(plural(archive, 'Earlier record', 'Earlier records'), archive, archiveRow.path),
          )}
        />
        <Plane
          title="Agents"
          index={4}
          wide
          tiles={tiles(
            sessionsRow &&
              tile(plural(agents, 'Agent', 'Agents'), live ? agents : EM, sessionsRow.path),
            sessionsRow && tile('Working now', live ? live.liveSessionCount : EM, sessionsRow.path),
            sessionsRow &&
              tile(
                `${plural(live?.runners.length, 'Machine', 'Machines')} online`,
                live ? share(runners, live.runners.length) : EM,
                sessionsRow.path,
              ),
            sessionsRow && tile('Queued', live?.queueTotal ?? EM, sessionsRow.path),
          )}
        />
      </div>
    </div>
  );
}
