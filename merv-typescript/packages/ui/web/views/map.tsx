import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { GitHubStatus } from '@merv/contracts/types';
import { accountRequest, useScopeVersion } from '../api';
import { useSession } from '../session';
import type { ShellData } from '../shell';
import { KindLabel, LoadState, StatusPill, cx, kindOf } from '../components';
import { ArrowRightIcon } from '../icons';
import { WORK } from '../navigation';
import { bytes } from './artifacts';
import { namesOf } from './people';
import { needsYou } from './overview';
import { EM, newest, plural, share, tally, useHome, verdictWord } from './map-data';

/**
 * Home: the whole project at a glance and deliberately no more. What needs the reader,
 * then planes of counts. Nothing here is written by an agent and nothing is composed by
 * the browser: a number links to the page that shows what it counts or does not link at
 * all. The records themselves, and what waits on what, are the Work page's map.
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
const tile = (
  label: string,
  value: ReactNode,
  to?: string,
  action?: ReactNode,
  said?: string,
): Tile => ({ label, value, to, action, said });
const tiles = (...items: (Tile | false | undefined)[]) =>
  items.filter((item): item is Tile => !!item);

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

/** How much of the open work is the reader's move; the strip itself is the way to it. */
function Now({ count }: { count?: number }) {
  const label = plural(count, 'needs you', 'need you');
  return (
    <Link className="map-now" to="/now" aria-label={`Now: ${count ?? ''} ${label}`}>
      <h2 className="plane-title">Now</h2>
      <span className="map-now-count">
        {/* A count not yet read is the em dash, never a zero. */}
        <b>{count ?? EM}</b> {label}
      </span>
      <ArrowRightIcon className="map-now-go" />
    </Link>
  );
}

export function MapView({ shell }: { shell: ShellData }) {
  const session = useSession();
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
  const github = useGitHub(!!codeRow);
  const yours = needsYou(rows, data, session.actor, namesOf(data?.actors));
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
      <Now count={data ? yours.length : undefined} />
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
            // Who is working on what, and what waits for an agent, are on the Work page's map.
            sessionsRow && tile('Working now', live ? live.liveSessionCount : EM, WORK.path),
            sessionsRow &&
              tile(
                `${plural(live?.runners.length, 'Machine', 'Machines')} online`,
                live ? share(runners, live.runners.length) : EM,
                sessionsRow.path,
              ),
            sessionsRow && tile('Queued', live?.queueTotal ?? EM, WORK.path),
          )}
        />
      </div>
    </div>
  );
}
