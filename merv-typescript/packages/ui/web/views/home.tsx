import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Artifact } from '@merv/contracts/artifact-models';
import type { PaperKind, PaperWorkspace } from '@merv/paper/models';
import { useTool } from '../api';
import { Ago, KindLabel, StatusPill, cx, words } from '../components';
import { ArrowRightIcon } from '../icons';
import { recordNames } from '../markdown';
import { pathOf } from '../navigation';
import { useSession } from '../session';
import type { Row, ShellData } from '../shell-types';
import { newest, type HomeData } from './map-data';
import { NeedsYou, Part, useNow } from './needs-you';
import { labels as paperTitles } from './paper-entries';
import { useActorNames } from './people';
import { Phrase, Reading } from './running-phrase';
import { currentCycle } from './work';
import { useLive } from './work-map';

/**
 * Home: the project's pulse, in the order a person asks it. Where the project stands — its
 * name and the cycle it is on — then what needs the reader, then which agents are working and
 * what each is doing this moment, then what was lately decided, filed or written. Each part
 * reads one answer the app already asks for (the rail's home read, the Work page's board, the
 * file list and the paper), and stands or fails on its own: a read that fails costs its own
 * part one line, never the page.
 */

/** The project's name, and the cycle it is on: its state, and how much of its work is done. */
function Head({ shell, home }: { shell: ShellData; home: HomeData | undefined }) {
  const { project } = useSession();
  const rows = shell.rows;
  const cycle = currentCycle(home?.research ?? undefined, shell.workflows);
  const cycles = pathOf(rows, 'research');
  const work = pathOf(rows, 'work');
  // Research counts its selected work and how much of it ended well.
  const { settled: done, total } = cycle?.progress ?? { settled: 0, total: 0 };
  return (
    <header className="home-head">
      <h1 className="page-title">{project.name}</h1>
      {cycle && (
        <p className="home-cycle">
          <span className="running-kind">Cycle</span>
          {cycles ? (
            <Link to={`${cycles}/${cycle.id}`}>{cycle.name}</Link>
          ) : (
            <span>{cycle.name}</span>
          )}
          <StatusPill value={cycle.workflow.state} />
          {total > 0 && (
            <span className="home-progress" title={`${done} of ${total} done`}>
              <span className="home-meter" aria-hidden="true">
                <span style={{ width: `${(100 * done) / total}%` }} />
              </span>
              {done} of {total} done
            </span>
          )}
          {work && (
            <Link className="home-more" to={work}>
              Open Work <ArrowRightIcon size={14} />
            </Link>
          )}
        </p>
      )}
    </header>
  );
}

/**
 * The agents working now, read from the board the Work map reads: each one's unit of work,
 * its role, and what it is doing at this moment, with how long. Each is the way to its unit's
 * sidebar on the Work page, where its live stream is.
 */
function LiveNow({ rows }: { rows: Row[] }) {
  const { board, now } = useLive();
  const nameOf = useActorNames();
  const work = pathOf(rows, 'work');
  const data = board.data;
  const units = new Map((data?.lanes.work.nodes ?? []).map((node) => [node.key, node]));
  const working = (data?.lanes.sessions.nodes ?? []).filter(
    (node) => node.dot === 'live' || node.dot === 'moving',
  );
  return (
    <Part
      title="Live now"
      count={working.length}
      failed={!data && board.error ? 'Could not read what is running.' : undefined}
      loading={!data && !board.error}
      empty={data && !working.length ? 'No agent is working.' : undefined}
    >
      <Reading.Provider value={{ now, nameOf, open: () => undefined }}>
        {working.map((node) => {
          const unit = node.links?.find((link) => units.has(link.to))?.to ?? node.links?.[0]?.to;
          // Sessions writes the agent's newest action as the node's first line.
          const doing = node.attention?.says ?? node.lines[0] ?? [];
          const face = (
            <>
              <span
                className={cx('live-dot', `live-dot--${now.stale ? 'live' : node.dot}`)}
                aria-hidden="true"
              />
              <span className="home-live-unit">
                {(unit && units.get(unit)?.title) || node.name || node.title}
              </span>
              <span className="home-live-who">{node.title}</span>
              <span className="home-live-doing">
                <Phrase value={doing} />
              </span>
            </>
          );
          return (
            <li key={node.key}>
              {work ? (
                <Link className="home-live" to={`${work}?key=${unit ?? node.key}`}>
                  {face}
                </Link>
              ) : (
                <span className="home-live">{face}</span>
              )}
            </li>
          );
        })}
      </Reading.Provider>
    </Part>
  );
}

/** One thing lately recorded: what kind, its name, what happened, and when. */
interface Recorded {
  key: string;
  kind: string;
  name: string;
  to?: string;
  says: ReactNode;
  at: string;
}

/** How many recorded things Home lists, and how many of each it asks for. */
const LATEST = 8;
const FILES = 5;

/**
 * What was lately recorded, newest first: review verdicts from the home read, the newest
 * files, and the paper's sections as they were last revised. Each is the way to its record.
 */
function Latest({ rows, home, lost }: { rows: Row[]; home?: HomeData; lost: boolean }) {
  const reviewsPath = pathOf(rows, 'reviews');
  const filesPath = pathOf(rows, 'artifacts');
  const paperPath = pathOf(rows, 'paper');
  const files = useTool<Artifact[]>(
    filesPath ? 'artifact.list' : null,
    { limit: FILES },
    { every: 30_000 },
  );
  const paper = useTool<PaperWorkspace>(paperPath ? 'paper.read' : null, {}, { every: 60_000 });
  const nameOf = useActorNames();
  const names = recordNames(undefined, home, rows);
  const items: Recorded[] = [
    ...(reviewsPath ? (home?.reviews ?? []) : [])
      .filter((review) => review.status === 'submitted' && review.verdict)
      .map((review) => ({
        key: review.id,
        kind: 'reviews',
        name: names.get(review.subjectId)?.name ?? 'Review',
        to: `${reviewsPath}/${review.id}`,
        says: (
          <>
            <span className={`crit-word crit-word--${review.verdict}`}>
              {words(review.verdict!)}
            </span>
            {/* The verdict word keeps its own gap. */}
            {nameOf(review.reviewerId ?? undefined) && `· ${nameOf(review.reviewerId!)}`}
          </>
        ),
        at: review.createdAt,
      })),
    ...(files.data ?? []).slice(0, FILES).map((file) => ({
      key: file.id,
      kind: 'artifacts',
      name: file.title,
      to: `${filesPath}/${file.id}`,
      says: 'New file',
      at: file.createdAt,
    })),
    ...Object.entries(paper.data?.documents ?? {}).flatMap(([kind, { current }]) =>
      current.revision > 0 && current.updatedAt
        ? [
            {
              key: `paper:${kind}`,
              kind: 'paper',
              name: paperTitles[kind as PaperKind] ?? words(kind),
              to: paperPath,
              says: `Revision ${current.revision}${nameOf(current.updatedBy ?? '') ? ` · ${nameOf(current.updatedBy!)}` : ''}`,
              at: current.updatedAt,
            },
          ]
        : [],
    ),
  ];
  const failed = [
    files.error && !files.data && 'files',
    paper.error && !paper.data && 'the paper',
    reviewsPath && (lost || home?.reviews === null) && 'reviews',
  ].filter(Boolean);
  const shown = newest(items, (item) => item.at).slice(0, LATEST);
  return (
    <Part
      title="Latest"
      failed={failed.length ? `Could not read ${failed.join(' or ')}.` : undefined}
      loading={!shown.length && (files.loading || paper.loading || (!home && !lost))}
      empty={!shown.length && !failed.length ? 'Nothing recorded yet.' : undefined}
    >
      {shown.map((item) => (
        <li key={item.key} className="home-latest">
          <KindLabel kind={item.kind} />
          {item.to ? (
            <Link className="ov-name" to={item.to}>
              {item.name}
            </Link>
          ) : (
            <span className="ov-name">{item.name}</span>
          )}
          <span className="home-latest-says">{item.says}</span>
          <Ago className="home-latest-at" at={item.at} />
        </li>
      ))}
    </Part>
  );
}

export function HomeView({ shell }: { shell: ShellData }) {
  const { home, lines } = useNow(shell.rows);
  return (
    <div className="page-stage home">
      <Head shell={shell} home={home.data} />
      <div className="home-parts">
        <div className="home-main">
          <NeedsYou rows={shell.rows} lines={lines} load={home} />
        </div>
        <div className="home-side">
          <LiveNow rows={shell.rows} />
          {/* A home read that never answered is said, never loaded for ever. */}
          <Latest rows={shell.rows} home={home.data} lost={!home.data && !!home.error} />
        </div>
      </div>
    </div>
  );
}
