import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { UiRowDescription } from '@merv/ui/rows';
import { keyKind, type RunningBoard } from '@merv/contracts/running';
import type { ArtifactListing as Artifact } from '@merv/contracts/artifact-models';
import type { PaperWorkspace } from '@merv/paper/models';
import type { BoardScene, BoardSummary } from '@merv/board/models';
import type { CodeProjectStatus } from '@merv/code-work/models';
import { useTool } from '../api';
import { Ago, StatusPill, cx, words } from '../components';
import { Icon, fileIcon } from '../icons';
import { pathOf } from '../navigation';
import { ended } from '../process';
import { useSession } from '../session';
import type { ShellData } from '../shell-types';
import { newest, type HomeData } from './map-data';
import { NeedsYou, useNow } from './needs-you';
import { chained, currentCycle } from './work';
import { needs, useLive } from './work-map';

/**
 * Home: the home of everything. What needs the reader first, then one card per place, each
 * a doorway with one picture and one number: the cycle's units as a ring, Pi as an orb, the
 * month's compute as bars, the fleet as machines with their agents, Git's main line, the
 * newest files, the paper's outline, the last board and the people. A card stands only where
 * its row is registered, reads what that row's page already reads, and fails alone.
 */

/** A card: its name, the way to its page, its picture and its one line. */
function Card({
  kind,
  title,
  to,
  figure,
  line,
  className,
}: {
  kind: string;
  title: string;
  to: string;
  figure: ReactNode;
  line: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('hub-card', `hub-card--${kind}`, className)} aria-label={title}>
      <h2 className="hub-title">
        {title}
        <Link className="hub-go" to={to} aria-label={`Open ${title}`}>
          <Icon name="arrow-right" size={14} />
        </Link>
      </h2>
      <div className="hub-figure">{figure}</div>
      <p className="hub-line">{line}</p>
    </section>
  );
}
/** The card's one number and its qualifier. */
const Big = ({ n, says }: { n: ReactNode; says: ReactNode }) => (
  <>
    <strong className="hub-big">{n}</strong> {says}
  </>
);

// ─── Work: the cycle's units as one ring, in order, each a way to its record ───────────────

interface Unit {
  id: string;
  kind: 'tasks' | 'experiments';
  name: string;
  to: string;
  state: string;
  at: string;
  standing: 'done' | 'failed' | 'live' | 'stuck' | 'open';
}
const R = 130;
const r = 120;
const C = 180;

function Ring({ units }: { units: Unit[] }) {
  const navigate = useNavigate();
  const [hover, setHover] = useState<number | null>(null);
  const n = units.length;
  const gap = n > 1 ? 0.02 : 0;
  const at = (i: number, edge: 0 | 1) => -Math.PI / 2 + ((i + edge) * 2 * Math.PI) / n;
  const point = (a: number, rr: number) => `${C + rr * Math.cos(a)},${C + rr * Math.sin(a)}`;
  const seg = (i: number) => {
    const [a0, a1] = [at(i, 0) + gap, at(i, 1) - gap];
    return `M${point(a0, R)} A${R},${R} 0 0 1 ${point(a1, R)} L${point(a1, r)} A${r},${r} 0 0 0 ${point(a0, r)} Z`;
  };
  const chevron = -Math.PI / 2 - 0.09;
  const cx0 = C + ((R + r) / 2) * Math.cos(chevron);
  const cy0 = C + ((R + r) / 2) * Math.sin(chevron);
  const held = hover === null ? undefined : units[hover];
  const mid = hover === null ? 0 : at(hover, 0) + Math.PI / n;
  const done = units.filter((u) => u.standing === 'done' || u.standing === 'failed').length;
  return (
    <div className="hub-ring">
      <svg viewBox={`0 0 ${2 * C} ${2 * C}`} role="list" aria-label="Units of the cycle">
        {units.map((unit, i) => (
          <path
            key={unit.id}
            role="link"
            tabIndex={0}
            aria-label={`${unit.name}, ${words(unit.state)}`}
            className={cx('hub-seg', `hub-seg--${unit.standing}`, hover === i && 'on')}
            d={n === 1 ? `M${C},${C - R} a${R},${R} 0 1 1 -0.01,0 Z` : seg(i)}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            onClick={() => navigate(unit.to)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                navigate(unit.to);
              }
            }}
          >
            <title>{unit.name}</title>
          </path>
        ))}
        {n > 0 && (
          <>
            <line className="hub-tick" x1={C} y1={C - R - 10} x2={C} y2={C - R - 2} />
            <path
              className="hub-chevron"
              d={`M${cx0 - 6},${cy0 - 5} L${cx0},${cy0} L${cx0 - 6},${cy0 + 5}`}
            />
          </>
        )}
        <text className="hub-count" x={C} y={C - 4} textAnchor="middle">
          {done}
        </text>
        <text className="hub-of" x={C} y={C + 22} textAnchor="middle">
          of {n} ended
        </text>
      </svg>
      {held && (
        <div
          className="hub-tip"
          style={{
            left: `${50 + 50 * ((R + 8) / C) * Math.cos(mid)}%`,
            top: `${50 + 50 * ((R + 8) / C) * Math.sin(mid)}%`,
          }}
        >
          <strong>{held.name}</strong>
          <span>
            {words(held.kind === 'tasks' ? 'task' : 'experiment')} ·{' '}
            <StatusPill value={held.state} /> · <Ago at={held.at} />
          </span>
        </div>
      )}
    </div>
  );
}

function Work({ shell, home }: { shell: ShellData; home: HomeData | undefined }) {
  const live = useLive();
  const rows = shell.rows;
  const [tasks, experiments] = [pathOf(rows, 'tasks'), pathOf(rows, 'experiments')];
  const work = pathOf(rows, 'work');
  const cycle = currentCycle(home?.research ?? undefined, shell.workflows);
  const nodes = new Map((live.board.data?.lanes.work.nodes ?? []).map((n) => [n.key, n]));
  const stale = live.now.stale;
  const units = useMemo(() => {
    const named = new Set(cycle?.researchDependencies);
    const all = [
      ...(home?.tasks ?? []).map((task) => ({
        id: task.id,
        kind: 'tasks' as const,
        name: task.title,
        to: `${tasks}/${task.id}`,
        flow: task.workflow,
        end: task,
      })),
      ...(home?.experiments ?? []).map((item) => ({
        id: item.id,
        kind: 'experiments' as const,
        name: item.name,
        to: `${experiments}/${item.id}`,
        flow: item.workflow,
        end: item,
      })),
    ]
      .filter((u) => !cycle || named.has(u.id) || !ended(shell.workflows, u.flow, u.end))
      .map((u) => ({ ...u, at: u.flow.updatedAt }));
    // In the order the Work page draws them: what waits on nothing first, then down the chains.
    return chained(all, home?.tasks ?? [])
      .sort((a, b) => a.depth - b.depth || a.at.localeCompare(b.at))
      .map((u): Unit => {
        const node = nodes.get(`work:${u.id}`);
        const over = ended(shell.workflows, u.flow, u.end);
        return {
          id: u.id,
          kind: u.kind,
          name: u.name,
          to: u.to,
          state: u.flow.state,
          at: u.at,
          standing: over
            ? u.end.failed
              ? 'failed'
              : 'done'
            : node && needs(node)
              ? 'stuck'
              : !stale && (node?.dot === 'live' || node?.dot === 'moving')
                ? 'live'
                : 'open',
        };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home, cycle?.id, live.board.data, stale, shell.workflows]);
  if (!work) return null;
  const count = (standing: Unit['standing']) => units.filter((u) => u.standing === standing).length;
  return (
    <Card
      kind="work"
      title={cycle ? cycle.name : 'Work'}
      to={work}
      className="hub-card--wide"
      figure={<Ring units={units} />}
      line={
        <span className="hub-legend">
          <span>
            <i className="hub-dot hub-dot--done" /> {count('done')} done
          </span>
          {count('failed') > 0 && (
            <span>
              <i className="hub-dot hub-dot--failed" /> {count('failed')} failed
            </span>
          )}
          <span>
            <i className="hub-dot hub-dot--live" /> {count('live')} live
          </span>
          <span>
            <i className="hub-dot hub-dot--stuck" /> {count('stuck')} stuck
          </span>
        </span>
      }
    />
  );
}

// ─── Pi: the orb, the whole card the way in ────────────────────────────────────────────────

function Pi({ to }: { to: string }) {
  return (
    <Link className="hub-card hub-card--pi" to={to} aria-label="Pi">
      <h2 className="hub-title">
        Pi
        <span className="hub-go">
          <Icon name="arrow-right" size={14} />
        </span>
      </h2>
      <div className="hub-figure">
        <div className="hub-orb" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      </div>
      <p className="hub-line">Ask anything about this project</p>
    </Link>
  );
}

// ─── Compute: this month's machine dollars, one bar a day ──────────────────────────────────

const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : Math.round(n).toLocaleString()}`;

function Spend({ days, to }: { days: NonNullable<HomeData['fleet']>; to: string }) {
  const total = days.reduce(
    (sum, d) => ({
      usd: sum.usd + d.usd,
      pricedHours: sum.pricedHours + d.pricedHours,
      unpricedHours: sum.unpricedHours + d.unpricedHours,
    }),
    { usd: 0, pricedHours: 0, unpricedHours: 0 },
  );
  const amount = (d: Omit<NonNullable<HomeData['fleet']>[number], 'day'>) =>
    d.unpricedHours > 0
      ? d.pricedHours > 0
        ? `${usd(d.usd)} partial`
        : 'Unavailable'
      : usd(d.usd);
  const today = days[days.length - 1] ?? total;
  const peak = Math.max(1e-9, ...days.map((d) => d.usd));
  const n = Math.max(days.length, 28);
  return (
    <Card
      kind="spend"
      title="Compute spend estimate"
      to={to}
      figure={
        <svg className="hub-bars" viewBox={`0 0 ${n * 10} 100`} preserveAspectRatio="none">
          {days.map((d, i) => (
            <rect
              key={d.day}
              className={cx('hub-bar', i === days.length - 1 && 'on')}
              x={i * 10 + 1}
              y={100 - (100 * d.usd) / peak}
              width={8}
              height={Math.max(1, (100 * d.usd) / peak)}
            >
              <title>
                {d.day} · {amount(d)}
                {d.unpricedHours > 0 ? ' · price missing' : ''}
              </title>
            </rect>
          ))}
        </svg>
      }
      line={
        <Big
          n={amount(total)}
          says={`this month · ${amount(today)} today${total.unpricedHours > 0 ? ' · some machine prices missing' : ''}`}
        />
      }
    />
  );
}

// ─── Agents: every agent at work as a mark, and every machine still being rented as a hollow one ──

function Agents({ board, stale, to }: { board: RunningBoard; stale: boolean; to: string }) {
  const nodes = board.lanes.sessions.nodes;
  // A session that works; a Fleet request is not an agent until a session runs on its machine.
  const working = nodes.filter(
    (n) => keyKind(n.key) === 'session' && (n.dot === 'live' || n.dot === 'moving'),
  );
  const renting = nodes.filter((n) => keyKind(n.key) === 'fleet' && n.dot === 'starting');
  return (
    <Card
      kind="agents"
      title="Agents"
      to={to}
      figure={
        <div className="hub-room-floor">
          {working.map((agent) => (
            <span
              key={agent.key}
              className={cx('hub-agent', stale && 'hub-agent--stale')}
              title={agent.title}
            />
          ))}
          {renting.map((machine) => (
            <span
              key={machine.key}
              className="hub-agent hub-agent--renting"
              title={machine.title}
            />
          ))}
        </div>
      }
      line={
        <Big
          n={working.length}
          says={`working${renting.length ? ` · ${renting.length} machine${renting.length === 1 ? '' : 's'} starting` : ''}`}
        />
      }
    />
  );
}

// ─── Git: main's accepted units as dots on a line, what waits to merge as dashed branches ──

function Git({ row }: { row: UiRowDescription }) {
  const read = useTool<{ status?: CodeProjectStatus }>(
    'ui.read',
    { rowId: row.id },
    { every: 30_000 },
  );
  const units = read.data?.status?.units ?? [];
  const accepted = newest(
    units.filter((u) => u.acceptance),
    (u) => u.acceptance!.acceptedAt,
  );
  const waiting = units.filter((u) => u.publication && u.publication.state !== 'published');
  const week = Date.now() - 7 * 86_400_000;
  const recent = accepted.filter((u) => Date.parse(u.acceptance!.acceptedAt) >= week).length;
  const dots = accepted.slice(0, 7).reverse();
  return (
    <Card
      kind="git"
      title="Git"
      to={row.path}
      figure={
        <svg className="hub-git" viewBox="0 0 320 100">
          <line className="hub-trunk" x1={10} y1={60} x2={290} y2={60} />
          {dots.map((u, i) => (
            <circle
              key={u.unitId}
              className={cx('hub-commit', Date.parse(u.acceptance!.acceptedAt) >= week && 'on')}
              cx={40 + i * 36}
              cy={60}
              r={5}
            >
              <title>{u.branch}</title>
            </circle>
          ))}
          {waiting.slice(0, 2).map((u, i) => {
            const y = i ? 92 : 28;
            return (
              <g key={u.unitId} className="hub-branch">
                <path d={`M250,60 C262,60 262,${y} 274,${y} L300,${y}`} />
                <circle cx={292} cy={y} r={5}>
                  <title>{u.branch}</title>
                </circle>
              </g>
            );
          })}
          <text className="hub-trunk-name" x={296} y={64}>
            main
          </text>
        </svg>
      }
      line={
        <Big
          n={read.data ? recent : '—'}
          says={`accepted this week${waiting.length ? ` · ${waiting.length} waiting to merge` : ''}`}
        />
      }
    />
  );
}

// ─── Files: the newest as a mosaic, images as pictures and the rest by type ────────────────

const RECENT = 16;
function Files({ to }: { to: string }) {
  const files = useTool<Artifact[]>('artifact.read:list', { limit: 200 }, { every: 60_000 });
  const all = files.data ?? [];
  const week = Date.now() - 7 * 86_400_000;
  const fresh = all.filter((f) => Date.parse(f.createdAt) >= week).length;
  return (
    <Card
      kind="files"
      title="Files"
      to={to}
      figure={
        <div className="hub-mosaic">
          {all.slice(0, RECENT).map((file) => (
            <Link
              key={file.id}
              className={cx('hub-tile', Date.parse(file.createdAt) >= week && 'on')}
              to={`${to}/${file.id}`}
              title={file.title}
            >
              <Icon name={fileIcon(file.mediaType, file.title)} size={16} />
            </Link>
          ))}
        </div>
      }
      line={
        <Big
          n={files.data ? `${all.length}${all.length === 200 ? '+' : ''}` : '—'}
          says={fresh ? `· ${fresh} new this week` : ''}
        />
      }
    />
  );
}

// ─── Paper: the outline, written sections solid ────────────────────────────────────────────

function Paper({ to }: { to: string }) {
  const paper = useTool<PaperWorkspace>('paper.read', {}, { every: 60_000 });
  const sections = Object.values(paper.data?.documents ?? {}).flatMap((doc) =>
    doc.current.sections.map((s) => ({ id: s.id, written: s.content.trim().length > 0 })),
  );
  const written = sections.filter((s) => s.written).length;
  return (
    <Card
      kind="paper"
      title="Paper"
      to={to}
      figure={
        <div className="hub-page">
          {(sections.length
            ? sections
            : Array.from({ length: 5 }, (_, i) => ({ id: String(i), written: false }))
          )
            .slice(0, 8)
            .map((s) => (
              <i key={s.id} className={cx('hub-rule', s.written && 'on')} />
            ))}
        </div>
      }
      line={<Big n={paper.data ? written : '—'} says={`of ${sections.length} sections written`} />}
    />
  );
}

// ─── Board: the last board, sketched ───────────────────────────────────────────────────────

function Board({ to }: { to: string }) {
  const boards = useTool<{ boards: BoardSummary[] }>('board.read', {}, { every: 60_000 });
  const live = (boards.data?.boards ?? []).filter((b) => !b.archived);
  const last = newest(live, (b) => b.updatedAt)[0];
  const scene = useTool<BoardScene>(
    last ? 'board.scene' : null,
    { id: last?.id },
    { every: 60_000 },
  );
  const shapes = (scene.data?.elements ?? []).filter((e) => !e.isDeleted).slice(0, 40);
  const box = shapes.reduce(
    (b, e) => ({
      x0: Math.min(b.x0, e.x),
      y0: Math.min(b.y0, e.y),
      x1: Math.max(b.x1, e.x + e.width),
      y1: Math.max(b.y1, e.y + e.height),
    }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
  );
  const view = shapes.length
    ? `${box.x0 - 20} ${box.y0 - 20} ${box.x1 - box.x0 + 40} ${box.y1 - box.y0 + 40}`
    : '0 0 320 120';
  return (
    <Card
      kind="board"
      title="Board"
      to={last ? `${to}/${last.id}` : to}
      figure={
        <svg className="hub-sketch" viewBox={view} preserveAspectRatio="xMidYMid meet">
          {shapes.map((e) =>
            e.type === 'ellipse' ? (
              <ellipse
                key={e.id}
                cx={e.x + e.width / 2}
                cy={e.y + e.height / 2}
                rx={e.width / 2}
                ry={e.height / 2}
              />
            ) : e.type === 'rectangle' || e.type === 'diamond' || e.type === 'text' ? (
              <rect
                key={e.id}
                x={e.x}
                y={e.y}
                width={e.width}
                height={e.height}
                rx={e.type === 'text' ? 0 : 8}
                className={e.type === 'text' ? 'hub-sketch-text' : undefined}
              />
            ) : Array.isArray(e.points) ? (
              <polyline
                key={e.id}
                points={(e.points as [number, number][])
                  .map(([x, y]) => `${e.x + x},${e.y + y}`)
                  .join(' ')}
              />
            ) : null,
          )}
        </svg>
      }
      line={
        <Big
          n={boards.data ? live.length : '—'}
          says={
            <>
              board{live.length === 1 ? '' : 's'}
              {last && (
                <>
                  {' '}
                  · edited <Ago at={last.updatedAt} />
                </>
              )}
            </>
          }
        />
      }
    />
  );
}

// ─── People ────────────────────────────────────────────────────────────────────────────────

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

function People({ home, to }: { home: HomeData | undefined; to: string }) {
  const { actor } = useSession();
  // The people: every active actor that is not an agent's, which a session or a thread owns.
  const people = (home?.actors ?? []).filter(
    (a) => a.active !== false && !a.sessionId && !a.threadId,
  );
  return (
    <Card
      kind="people"
      title="People"
      to={to}
      figure={
        <div className="hub-people">
          {people.slice(0, 8).map((p) => (
            <span key={p.id} className={cx('hub-face', p.id === actor.id && 'on')} title={p.name}>
              {initials(p.name)}
            </span>
          ))}
        </div>
      }
      line={
        <Big n={home?.actors ? people.length : '—'} says={`· you are the ${words(actor.role)}`} />
      }
    />
  );
}

export function HomeView({ shell }: { shell: ShellData }) {
  const rows = shell.rows;
  const { project } = useSession();
  const { home, lines } = useNow(rows);
  const live = useLive();
  const row = (kind: string) => rows.find((r) => r.view.kind === kind);
  const [pi, sessions, code, files, paper, boards, people] = [
    pathOf(rows, 'pi'),
    pathOf(rows, 'sessions'),
    row('code'),
    pathOf(rows, 'artifacts'),
    pathOf(rows, 'paper'),
    pathOf(rows, 'boards'),
    pathOf(rows, 'settings'),
  ];
  const spend = home.data?.fleet;
  return (
    <div className="page-stage hub">
      <h1 className="page-title">{project.name}</h1>
      <div className="hub-needs">
        <NeedsYou rows={rows} lines={lines} load={home} />
      </div>
      <div className="hub-grid">
        <Work shell={shell} home={home.data} />
        {pi && <Pi to={pi} />}
        {spend && <Spend days={spend} to={pathOf(rows, 'sandboxes') ?? sessions ?? '/'} />}
        {sessions && live.board.data && (
          <Agents board={live.board.data} stale={live.now.stale} to={sessions} />
        )}
        {code && <Git row={code} />}
        {files && <Files to={files} />}
        {paper && <Paper to={paper} />}
        {boards && <Board to={boards} />}
        {people && <People home={home.data} to={people} />}
      </div>
    </div>
  );
}
