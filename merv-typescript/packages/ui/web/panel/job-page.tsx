/**
 * A job's own page, in the main pane: one page, one scroll. The structure is an index into the stream below it.
 *
 * The job's name, its kind, the amber "needs you" when it does, and how long it worked and stood idle are the panel's
 * head line, the chat head every chat has. The page starts with the goal, its full brief folded behind "brief ›" once round 1 has handed work in. Then the
 * rounds at a glance, round 1 first, one line per round with each member's turn under its role's name, each opening to
 * that member's own closing words. Then the changes, one line of sums that opens to its files. Then the thread, what
 * the members said in order like a group chat: each move of the workflow is a heading line, and each turn shows the
 * message it handed on, its work folded under "show work". A thin rail at the right has one tick per round.
 * The foot holds the quiet words the state allows; Stop and Discard each ask once and say what is lost.
 *
 * No boxes, no pills: words, a provider's colour on its mark, and amber only for "needs you".
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useDeskCall, type DeskCall } from './desk-calls';
import { AgentCard } from './agent-cards';
import { ChatHead } from './chat-head';
import { LIVE_EVERY, workWords, type Work } from './agents';
import { blocksOf } from './chat-events';
import { openJob } from './job-rows';
import {
  briefOpen,
  cellWords,
  chapterWords,
  discardLoses,
  finalOf,
  footActs,
  goalOf,
  madeLine,
  memberWords,
  pieces,
  roleWord,
  roundRows,
  roundStarts,
  clock,
  needsWhy,
  stopLoses,
  turnWords,
  type Artifact,
  type JobPage as Page,
  type PageTurn,
  type Piece,
  type RoundMark,
} from './job-model';
import { JobMark, ProviderMark } from './marks';
import { Prose } from './prose';
import { askTitle, type Thread } from './rows';
import { Trail } from './trail';
import type { PaneTarget } from './panes';

const BRIEF_KEY = 'merv.job.brief:';
/** The brief's fold: open until round 1 hands in, then folded, unless the person said otherwise; that is kept on this Mac. */
function useBrief(id: string, byDefault: boolean): [boolean, () => void] {
  const key = BRIEF_KEY + id;
  const kept = () => {
    try {
      const value = localStorage.getItem(key);
      return value === 'open' ? true : value === 'shut' ? false : undefined;
    } catch {
      return;
    }
  };
  const [chosen, setChosen] = useState(kept);
  const open = chosen ?? byDefault;
  const toggle = useCallback(() => {
    const next = !open;
    setChosen(next);
    try {
      localStorage.setItem(key, next ? 'open' : 'shut');
    } catch {
      /* For this look only. */
    }
  }, [open, key]);
  return [open, toggle];
}

/** Where the page reads and acts: this Mac's desk in Merv.app; on runmerv.com the Mac through the account. Absent
 *  `work`, what can be done with ended work is what the page itself carries. `away`: why nothing can be pressed now
 *  ("Mac is away"); the words still show, quietly unavailable. */
export interface JobVia {
  act(id: string, what: 'continue' | 'stop'): Promise<unknown>;
  work?(writer: string): Promise<Work>;
  workAct(writer: string, what: 'merge' | 'pull-request' | 'discard'): Promise<Work | undefined>;
  open?(writer: string, path: string): void;
  away?: string;
}
/** A desk's own way to act on a job: Merv.app's, through the desk the panel asks. */
const deskJobVia = (call: DeskCall): JobVia => ({
  act: (id, what) => call(`jobs/${encodeURIComponent(id)}/${what}`, {}),
  work: (writer) => call<Work>(`threads/${encodeURIComponent(writer)}/work`),
  workAct: (writer, what) => call<Work>(`threads/${encodeURIComponent(writer)}/work/${what}`, {}),
  open: (writer, path) => {
    void call(`threads/${encodeURIComponent(writer)}/open`, { path }).catch(() => undefined);
  },
});

/** The page's own read of the job, again whenever the job moves, and on a slow beat while it is under way. */
function usePage(
  id: string,
  stamp: string | undefined,
): { page?: Page; failed: boolean; read: number } {
  const call = useDeskCall();
  const [page, setPage] = useState<Page>(),
    [failed, setFailed] = useState(false),
    [beat, setBeat] = useState(0),
    [read, setRead] = useState(0);
  useEffect(() => {
    let gone = false;
    void call<Page>(`jobs/${encodeURIComponent(id)}/page`).then(
      (next) => {
        if (!gone) {
          setPage(next);
          setRead(Date.now());
          setFailed(false);
        }
      },
      () => {
        if (!gone) setFailed(true);
      },
    );
    return () => {
      gone = true;
    };
  }, [id, stamp, beat]);
  const live = page?.state === 'running';
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') setBeat((was) => was + 1);
    }, LIVE_EVERY);
    return () => clearInterval(timer);
  }, [live]);
  return { page: page?.id === id ? page : undefined, failed, read };
}

/** A press that asks once before it does: the first press says what is lost, the second does it. Whether it is asking
 *  is the page's, so the head's menu can ask here too. */
function Guarded({
  words,
  loses,
  busy,
  sure,
  onSure,
  onDo,
  className,
  title,
}: {
  words: string;
  loses: string;
  busy: boolean;
  sure: boolean;
  onSure(sure: boolean): void;
  onDo(): void;
  className?: string;
  title?: string;
}) {
  return (
    <span className="job-guard">
      <button
        type="button"
        className={`job-foot-act${className ? ` ${className}` : ''}`}
        disabled={busy}
        title={title}
        aria-expanded={sure}
        onClick={() => (sure ? (onSure(false), onDo()) : onSure(true))}
      >
        {sure ? `${words}, sure` : words}
      </button>
      {sure && (
        <>
          <span className="job-loses" role="alert">
            {loses}
          </span>
          <button type="button" className="job-foot-act is-keep" onClick={() => onSure(false)}>
            keep it
          </button>
        </>
      )}
    </span>
  );
}

/** What can be done with the job's work once it ended, read from the writer's branch as it stands. */
function useWork(via: JobVia, writer: string | undefined, wanted: boolean, stamp: string) {
  const [work, setWork] = useState<Work>();
  useEffect(() => {
    if (!wanted || !writer || !via.work) return;
    let gone = false;
    void via.work(writer).then(
      (read) => {
        if (!gone) setWork(read);
      },
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [writer, wanted, stamp, via.work]);
  return [work, setWork] as const;
}

type Act = {
  what: 'continue' | 'stop' | 'merge' | 'pull-request' | 'discard';
  words: string;
  into?: string;
  loses?: string;
};
/** What the job allows now, once for both places that offer it: the foot and the head's menu. Stop and Discard ask
 *  first, in the foot, wherever they were pressed; nothing presses while one is under way or the Mac is away. */
function useActs(page: Page | undefined, via: JobVia) {
  const ended = page?.state === 'done' || page?.state === 'stopped';
  const [read, setWork] = useWork(via, page?.writer, ended, page?.words ?? '');
  const work = via.work ? read : (read ?? page?.work);
  const [busy, setBusy] = useState(''),
    [reason, setReason] = useState(''),
    [asking, setAsking] = useState<string>();
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(undefined), 8000);
    return () => clearTimeout(timer);
  }, [asking]);
  const said = ended ? workWords(work) : undefined;
  const acts: Act[] = !page
    ? []
    : [
        ...(ended
          ? []
          : footActs(page).map(({ what, words }): Act => ({
              what,
              words,
              ...(what === 'stop' && { loses: stopLoses(page) }),
            }))),
        ...(said?.acts ?? []).map(({ what, words, into }): Act => ({
          what,
          words,
          into,
          ...(what === 'discard' && {
            loses: discardLoses(work?.branch ?? page.branch, page.artifacts.length),
          }),
        })),
      ];
  const run = async (what: Act['what']) => {
    if (!page || busy || via.away) return;
    setBusy(what);
    setReason('');
    try {
      if (what === 'continue' || what === 'stop') await via.act(page.id, what);
      else {
        const next = await via.workAct(page.writer!, what);
        if (next) setWork(next);
      }
    } catch (failed) {
      setReason((failed as Error).message);
    } finally {
      setBusy('');
    }
  };
  return { acts, fact: said?.fact, busy, reason, away: via.away, asking, setAsking, run };
}
type Acts = ReturnType<typeof useActs>;

function Foot({
  acts: { acts, fact, busy, reason, away, asking, setAsking, run },
}: {
  acts: Acts;
}) {
  const off = !!busy || !!away;
  const shown: ReactNode[] = acts.map(({ what, words, into, loses }) =>
    loses ? (
      <Guarded
        key={what}
        words={words}
        loses={loses}
        busy={off}
        title={away}
        sure={asking === what}
        onSure={(sure) => setAsking(sure ? what : undefined)}
        onDo={() => void run(what)}
      />
    ) : (
      <button
        key={what}
        type="button"
        className={`job-foot-act${what === 'continue' ? ' is-first' : ''}`}
        disabled={off}
        title={away}
        onClick={() => void run(what)}
      >
        {words}
        {into && (
          <>
            {' '}
            <span className="job-into">{into}</span>
          </>
        )}
        {busy === what && what !== 'continue' ? '…' : ''}
      </button>
    ),
  );
  // Said only of ended work, which has no Continue or Stop before it.
  if (fact)
    shown.unshift(
      <span key="fact" className="job-fact">
        {fact}
      </span>,
    );
  if (!shown.length && !reason) return null;
  return (
    <footer className="job-foot" aria-label="What can be done">
      <p className="job-foot-line">
        {shown.map((act, at) => (
          <span key={at} className="job-foot-each">
            {at > 0 && (
              <span className="job-sep" aria-hidden="true">
                ·
              </span>
            )}
            {act}
          </span>
        ))}
      </p>
      {away && acts.length > 0 && (
        <p className="soft job-away" role="status">
          {away}
        </p>
      )}
      {reason && (
        <p className="soft job-reason" role="alert">
          {reason}
        </p>
      )}
    </footer>
  );
}

/** The files the writer changed, by what they are for. A group with nothing in it has no heading. */
function Artifacts({
  files,
  writer,
  open: opens,
}: {
  files: Artifact[];
  writer?: string;
  open?: JobVia['open'];
}) {
  const [shown, setShown] = useState(false);
  if (!files.length) return null;
  const made = madeLine(files);
  const groups = [
    ['files', 'Changed files'],
    ['tests', 'Tests'],
    ['renders', 'Renders'],
  ] as const;
  const open = (path: string) => {
    if (writer) opens?.(writer, path);
  };
  return (
    <section className="job-section job-artifacts" aria-label="Changes">
      <h3 className="job-heading">Changes</h3>
      <button
        type="button"
        className="job-made"
        aria-expanded={shown}
        onClick={() => setShown(!shown)}
      >
        <span>{made.files}</span>
        <span className="job-sep" aria-hidden="true">
          ·
        </span>
        <span className="agent-add">{made.added}</span>{' '}
        <span className="agent-del">{made.removed}</span>
        <span className="job-sep" aria-hidden="true">
          ·
        </span>
        <span className="job-made-by">{made.by}</span>
        <span className="job-fold-word">{shown ? 'hide ‹' : 'show ›'}</span>
      </button>
      {shown &&
        groups.map(([group, heading]) => {
          const mine = files.filter((file) => file.group === group);
          if (!mine.length) return null;
          return (
            <div key={group} className="job-group">
              <h3 className="job-heading">{heading}</h3>
              <ul className="job-files">
                {mine.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      className="job-file"
                      onClick={() => open(file.path)}
                      title={`Open ${file.path}`}
                    >
                      <span className="job-path">{file.path}</span>
                      <span className="job-file-meta">
                        {(file.added > 0 || !file.removed) && (
                          <span className="agent-add"> +{file.added}</span>
                        )}
                        {file.removed > 0 && <span className="agent-del"> −{file.removed}</span>} ·
                        round {file.round} · {file.role === 'author' ? 'writer' : file.role}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
    </section>
  );
}

/** The rounds at a glance: one line per round, round 1 first, each member's turn in its role's column under the
 *  role's name as the workflow says it. Pressing a turn
 *  opens that member's own closing words under its line; pressing it again folds them. */
function Rounds({
  page,
  title,
  onOpen,
}: {
  page: Page;
  title: string;
  onOpen(target: PaneTarget): void;
}) {
  const { columns, rows } = useMemo(
    () => roundRows(page.turns, page.flow),
    [page.turns, page.flow],
  );
  const [shown, setShown] = useState<number>();
  const width = Math.max(1, ...rows.map((row) => row.cells.length));
  const cell = (turn: PageTurn | undefined, at: number) => {
    if (!turn) return <span key={at} className="job-cell is-none" />;
    const { did, rest, took } = cellWords(turn);
    return (
      <button
        key={at}
        type="button"
        className={`job-cell is-${turn.state}`}
        data-agent={turn.provider}
        aria-expanded={shown === turn.n}
        aria-label={turnWords(turn)}
        title={turnWords(turn)}
        onClick={() => setShown(shown === turn.n ? undefined : turn.n)}
      >
        <ProviderMark provider={turn.provider} size={12} />
        <span className={`job-cell-did${rest ? ' has-rest' : ''}`}>{did}</span>
        {rest && <span className="job-cell-rest">{rest}</span>}
        {took && <span className="job-cell-took">{took}</span>}
      </button>
    );
  };
  const opened = page.turns.find((turn) => turn.n === shown);
  return (
    <section className="job-section job-rounds" aria-label="Rounds">
      <h3 className="job-heading">Rounds</h3>
      {!rows.length && <p className="soft">Nobody has taken a turn in it yet.</p>}
      <div className="job-round-list" style={{ ['--job-cells' as string]: width }}>
        {rows.length > 0 && (
          <div className="job-round-head" aria-hidden="true">
            <span />
            {columns.map((role) => (
              <span key={role} className="job-round-role">
                {roleWord(role, page.flow)}
              </span>
            ))}
          </div>
        )}
        {rows.map((row) => (
          <div key={row.round} className="job-round">
            <div className="job-round-line">
              <span className="job-round-n">{row.round}</span>
              {row.cells.map(cell)}
            </div>
            {opened && opened.round === row.round && (
              <div className="job-turns">
                <AgentCard
                  key={opened.n}
                  id={opened.thread}
                  title=""
                  provider={opened.provider}
                  says={turnWords(opened).replace(/^Round \d+ · /, '')}
                  round={opened.round}
                  files={opened.files}
                  state={opened.state}
                  at={opened.completion ? { completion: opened.completion } : undefined}
                  stamp={opened.completion ? undefined : `${page.words}:${opened.ms ?? ''}`}
                  review={opened.role === 'reviewer' ? { title } : undefined}
                  opened
                  onOpen={onOpen}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** "Done means": one row per check, with each member's word on it. Hidden until the job engine keeps them. */
function DoneMeans({ checks }: { checks?: Page['checks'] }) {
  if (!checks?.length) return null;
  return (
    <section className="job-section job-checks" aria-label="Done means">
      <h3 className="job-heading">Done means</h3>
      <ol>
        {checks.map((check) => (
          <li key={check.n}>{check.text}</li>
        ))}
      </ol>
    </section>
  );
}

/** One member's run in the stream: who it is, then what it said and did, as its session shows them. */
function MemberRun({
  piece,
  live,
  flow,
}: {
  piece: Extract<Piece, { kind: 'member' }>;
  live: boolean;
  flow?: Page['flow'];
}) {
  const blocks = useMemo(() => blocksOf(piece.rows), [piece.rows]);
  const { final, work } = useMemo(() => finalOf(blocks), [blocks]);
  // The turn at work now has no final word yet: its work shows as it happens, and folds once it hands on.
  const [chosen, setChosen] = useState<boolean>();
  const open = chosen ?? (live && !final);
  const first = piece.rows[0]?.at;
  const failures = work.filter((block) => block.type === 'error');
  const shown = open ? blocks : [...failures, ...(final ? [final] : [])];
  return (
    <div className="job-run" data-agent={piece.provider} data-thread={piece.thread}>
      <p className="job-who" title={first ? new Date(first).toLocaleString() : undefined}>
        <ProviderMark provider={piece.provider} size={14} />
        <span>{memberWords(piece, flow)}</span>
        {work.length > 0 && (
          <button
            type="button"
            className="job-work-word"
            aria-expanded={open}
            onClick={() => setChosen(!open)}
          >
            {open ? 'hide work ‹' : 'show work ›'}
          </button>
        )}
      </p>
      {!final && !open && (
        <p className="soft job-no-final">
          {live ? 'At work, nothing handed on yet.' : 'Ended without a closing message.'}
        </p>
      )}
      {shown.map((block) =>
        block.type === 'trail' ? (
          <Trail
            key={block.key}
            blockId={block.key}
            provider={piece.provider}
            steps={block.steps}
            live={live && block === blocks.at(-1)}
          />
        ) : block.type === 'user' ? (
          <div key={block.key} className="said user job-sent">
            {block.text}
            {block.by && block.by !== 'person' && (
              <span className="said-from">
                {block.by === 'job'
                  ? 'from the job'
                  : block.by === 'main'
                    ? 'from the main thread'
                    : `from ${block.by}`}
              </span>
            )}
          </div>
        ) : block.type === 'assistant' ? (
          <div key={block.key} className="said assistant">
            <div className="assistant-text">
              <Prose text={block.text} />
            </div>
          </div>
        ) : block.type === 'error' ? (
          <p key={block.key} className="said error-line">
            {block.text}
          </p>
        ) : null,
      )}
    </div>
  );
}

/** The stream, with its chapter headings: each move of the workflow, then each member's run. */
function Stream({ page, all }: { page: Page; all: Piece[] }) {
  const lastRun = all.findLast((piece) => piece.kind === 'member');
  return (
    <section className="job-section job-stream" aria-label="Thread">
      <h3 className="job-heading">Thread</h3>
      {!all.length && <p className="soft">Nothing said or done in it yet.</p>}
      {page.cut && (
        <p className="soft job-cut">
          Earlier steps are left out here. Each member's session has them whole.
        </p>
      )}
      {all.map((piece) =>
        piece.kind === 'chapter' ? (
          <h4
            key={piece.key}
            className={`job-chapter${piece.chapter.end ? ' is-end' : ''}`}
            data-chapter={piece.index}
            title={new Date(piece.chapter.at).toLocaleString()}
          >
            <span>{chapterWords(piece.chapter, page)}</span>
          </h4>
        ) : (
          <MemberRun
            key={piece.key}
            piece={piece}
            flow={page.flow}
            live={page.state === 'running' && piece === lastRun}
          />
        ),
      )}
    </section>
  );
}

/** How far apart two short labels on the rail stand, at the least, in pixels. */
const RAIL_LINE = 14;

/** A thin rail at the pane's right edge: one tick per round, standing where that round begins in the whole page. Its
 *  label, "Round 13", shows under the pointer; where the pane has room the round's number stands beside each tick that
 *  does not crowd the one above. A press brings the round's first heading to the top. */
function Rail({
  chapters,
  marks,
  current,
  scroller,
  onJump,
}: {
  chapters: number[];
  marks: RoundMark[];
  current?: number;
  scroller: React.RefObject<HTMLDivElement | null>;
  onJump(index: number): void;
}) {
  const [ticks, setTicks] = useState<number[]>([]);
  const rail = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const outer = scroller.current;
      if (!outer) return;
      const height = Math.max(1, outer.scrollHeight);
      setTicks(
        chapters.map((index) => {
          const line = outer.querySelector<HTMLElement>(`[data-chapter="${index}"]`);
          return line ? Math.min(1, Math.max(0, line.offsetTop / height)) : 0;
        }),
      );
    };
    measure();
    const outer = scroller.current;
    if (typeof ResizeObserver === 'undefined' || !outer?.firstElementChild) return;
    const watch = new ResizeObserver(measure);
    for (const child of Array.from(outer.children)) watch.observe(child);
    return () => watch.disconnect();
  }, [chapters.join(), scroller]);
  if (chapters.length < 2) return null;
  // Its short label stands beside a tick where there is room: never closer than a line to the label above it.
  const tall = rail.current?.clientHeight ?? 0,
    named = new Set<number>();
  let last = -Infinity;
  for (const [at, place] of chapters.map(
    (_, at) => [at, (ticks[at] ?? at / chapters.length) * tall] as const,
  ))
    if (tall && place - last >= RAIL_LINE) {
      named.add(at);
      last = place;
    }
  return (
    <nav ref={rail} className="job-rail" aria-label="Chapters">
      {chapters.map((index, at) => (
        <button
          key={index}
          type="button"
          className={`job-tick${named.has(at) ? ' is-named' : ''}${index === current ? ' is-current' : ''}`}
          style={{ top: `${(ticks[at] ?? at / chapters.length) * 100}%` }}
          aria-label={marks[at]?.label}
          aria-current={index === current || undefined}
          onClick={() => onJump(index)}
        >
          <span className="job-tick-short" aria-hidden="true">
            {marks[at]?.short}
          </span>
          <span className="job-tick-full" aria-hidden="true">
            {marks[at]?.label}
          </span>
        </button>
      ))}
    </nav>
  );
}

/** The chapter the page is reading: the last heading at or above the top of what shows. */
function currentChapter(outer: HTMLElement, chapters: number[]): number | undefined {
  let found: number | undefined;
  const head = (outer.querySelector<HTMLElement>('.job-jump')?.offsetHeight ?? 0) + 64;
  for (const index of chapters) {
    const line = outer.querySelector<HTMLElement>(`[data-chapter="${index}"]`);
    if (line && line.offsetTop <= outer.scrollTop + head) found = index;
  }
  return found;
}

/** A narrow pane's way to the chapters, in place of the rail: one sticky line of their short labels at the top, the newest in
 *  sight, the one being read in the page's ink. A press brings that heading to the top. */
function ChapterJump({
  chapters,
  marks,
  current,
  onJump,
}: {
  chapters: number[];
  marks: RoundMark[];
  current?: number;
  onJump(index: number): void;
}) {
  const line = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = line.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [chapters.length]);
  // The word being read stays in sight. Moved by hand: scrolling it into view would also stop the page's own glide.
  useEffect(() => {
    const node = line.current,
      word = node?.querySelector<HTMLElement>('.is-current');
    if (!node || !word) return;
    if (word.offsetLeft < node.scrollLeft) node.scrollLeft = word.offsetLeft;
    else if (word.offsetLeft + word.offsetWidth > node.scrollLeft + node.clientWidth)
      node.scrollLeft = word.offsetLeft + word.offsetWidth - node.clientWidth;
  }, [current]);
  if (chapters.length < 2) return null;
  return (
    <nav ref={line} className="job-jump" aria-label="Chapters">
      {chapters.map((index, at) => (
        <button
          key={index}
          type="button"
          className={`job-jump-word${index === current ? ' is-current' : ''}`}
          aria-label={marks[at]?.label}
          aria-current={index === current || undefined}
          onClick={() => onJump(index)}
        >
          {marks[at]?.short}
        </button>
      ))}
    </nav>
  );
}

/** A job's page. The way back to its main thread is the panel's own back arrow, in the head above it. */
export function JobPageView({
  job,
  threads,
  onOpen,
}: {
  job: string;
  threads?: Thread[];
  onOpen(target: PaneTarget): void;
}) {
  // The main thread's own read of the job moves whenever the job does: the page reads itself again then.
  const view = threads
    ?.flatMap((thread) => [...(thread.jobs ?? []), ...(thread.jobsEnded ?? [])])
    .find((each) => each.id === job);
  const stamp =
    view &&
    `${view.words}:${view.lines.length}:${view.lines.map((line) => line.state).join()}:${view.since ?? ''}`;
  const { page, failed, read } = usePage(job, stamp);
  const call = useDeskCall(),
    via = useMemo(() => deskJobVia(call), [call]);
  return <JobPage job={job} page={page} failed={failed} read={read} via={via} onOpen={onOpen} />;
}

/** The page itself, from a read made elsewhere: Merv.app's own (above), or runmerv.com's through the account. `read`:
 *  when the page was read, by this window's clock, from which its clock moves on. */
export function JobPage({
  job,
  page,
  failed,
  read,
  via,
  onOpen,
}: {
  job: string;
  page?: Page;
  failed: boolean;
  read: number;
  via: JobVia;
  onOpen(target: PaneTarget): void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (page && (page.state === 'done' || page.state === 'stopped')) openJob(page.id);
  }, [page?.id, page?.state]);
  const [brief, toggleBrief] = useBrief(job, page ? briefOpen(page) : true);
  const all = useMemo(() => (page ? pieces(page) : []), [page]);
  const [current, setCurrent] = useState<number>();
  const acts = useActs(page, via);
  if (!page)
    return (
      <div className="job-pane">
        <div className="job-page" ref={scroller}>
          <p className="soft job-reading">
            {failed ? 'This job cannot be read right now.' : 'Reading…'}
          </p>
        </div>
      </div>
    );
  const headings = all.filter(
    (piece): piece is Extract<Piece, { kind: 'chapter' }> => piece.kind === 'chapter',
  );
  // The rail marks rounds only: one tick where each round begins.
  const marks = roundStarts(headings.map((piece) => piece.chapter)),
    chapters = marks.map((mark) => headings[mark.at]!.index);
  const jump = (index: number) =>
    scroller.current
      ?.querySelector<HTMLElement>(`[data-chapter="${index}"]`)
      ?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  // The clock is the desk's as it answered, moving on from there: a Mac whose clock differs says the same times.
  const time = clock(page, Date.parse(page.now) + Math.max(0, now - read)),
    why = needsWhy(page),
    goal =
      page.summary && goalOf(page.summary, askTitle(page.title)).first
        ? { first: page.summary, more: page.task !== page.summary }
        : goalOf(page.task, askTitle(page.title)),
    title = askTitle(page.title) || 'Job';
  const working =
    page.state === 'running'
      ? page.turns.find((turn) => turn.state === 'working')?.provider
      : undefined;
  return (
    <div className={`job-pane is-${page.state}`} data-job={page.id} data-agent={working}>
      <div
        className="job-page"
        ref={scroller}
        onScroll={(event) => setCurrent(currentChapter(event.currentTarget, chapters))}
      >
        {/* The job's name, kind and clock are the panel's own head line, as a chat's are: the page starts with its goal. */}
        {/* The head's menu offers what the foot does; Stop and Discard ask there, in the foot, before anything is lost. */}
        <ChatHead
          plain
          mark={<JobMark />}
          title={title}
          kind={
            <>
              {page.kind}
              {why !== undefined && (
                <>
                  {' '}
                  ·{' '}
                  <span className="job-accent" aria-live="polite">
                    needs you{why}
                  </span>
                </>
              )}
              {time.words && ` · ${time.words}`}
            </>
          }
          more={acts.acts.map(({ what, words, into, loses }) => ({
            label: into ? `${words} ${into}` : words,
            disabled: !!acts.busy || !!acts.away,
            title: acts.away,
            press: () => {
              if (!loses) return void acts.run(what);
              acts.setAsking(what);
              scroller.current
                ?.querySelector('.job-foot')
                ?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
            },
          }))}
        />
        <ChapterJump chapters={chapters} marks={marks} current={current} onJump={jump} />
        {(goal.first || goal.more) && (
          <section className="job-section job-goal" aria-label="Goal">
            <p className="job-goal-line job-summary">
              {goal.first}
              {goal.more && ' '}
              {goal.more && (
                <button
                  type="button"
                  className="job-brief-word"
                  aria-expanded={brief}
                  onClick={toggleBrief}
                >
                  {brief ? 'brief ‹' : 'brief ›'}
                </button>
              )}
            </p>
            {goal.more && brief && (
              <div className="job-brief">
                <Prose text={page.task} />
              </div>
            )}
          </section>
        )}
        <DoneMeans checks={page.checks} />
        <Rounds page={page} title={title} onOpen={onOpen} />
        <Artifacts files={page.artifacts} writer={page.writer} open={via.open} />
        <Stream page={page} all={all} />
        <Foot acts={acts} />
      </div>
      <Rail chapters={chapters} marks={marks} current={current} scroller={scroller} onJump={jump} />
    </div>
  );
}
