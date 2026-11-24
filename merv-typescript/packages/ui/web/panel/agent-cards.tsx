/**
 * The project's agents inside its main thread. An agent whose turn ended speaks in the thread, where it
 * happened, as a member of the conversation: its name, then its own closing words as it wrote them, then
 * the files it changed in one quiet line. Nobody retells it and nothing is pressed to read it. An agent at
 * work or asking for the person is one line at the thread's foot. Nothing here is a box.
 * The person stays in the main thread; the whole session is a press on the agent's name.
 */
import { providerName } from '@merv/protocol/runtime';
import { modelName } from './model-name';
import { goalOf } from './job-model';
import {
  ChangesLine,
  Counts,
  EntryLine,
  Hunks,
  PAUSED_WORDS,
  UNSHOWN,
  Words,
  useFolded,
} from './entry-parts';
export { FOLD_KEY, PAUSED_WORDS } from './entry-parts';
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useMacDesk } from './desk-calls';
import { useEntrySource } from './entry-source';
import { JobMark, ProviderMark, StateMark, ToolGlyph, toolKind } from './marks';
import { groupLabel } from './tool-words';
import type { PaneTarget } from './panes';
import { Prose } from './prose';
import {
  FILES_NAMED,
  LIVE_EVERY,
  STATE_WORDS,
  continueWords,
  jobActions,
  jobWords,
  mainThread,
  needsWords,
  outsideJobs,
  readsAgain,
  reveals,
  reviewEnd,
  shownAgents,
  threadAgents,
  toggleWords,
  whereWords,
  withoutVerdict,
  workWords,
  type CardState,
  type Reveals,
  type ReviewEnd,
  type Work,
} from './agents';
import { jobAct, jobKey, moveLine } from './live-lines';
import { openJobPage } from './panes';
import type { EntryFile, Review, Spoken } from './chat-events';
import {
  askTitle,
  folderName,
  sessionTitle,
  type JobLine,
  type JobView,
  type Provider,
  type Thread,
} from './rows';

export interface AgentResult {
  said: string;
  cut: boolean;
  turn?: number;
  state: 'working' | 'finished' | 'failed' | 'stopped';
  settled?: boolean;
  mixed?: boolean;
  unmeasured?: boolean;
  unreachable?: boolean;
  more?: boolean;
  /** In a kept record: everything the turn changed, counted whole, however much of it is listed. */
  total?: { files: number; added: number; removed: number };
  files: {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    added: number;
    removed: number;
    state?: 'binary' | 'too_large' | 'unavailable' | 'omitted';
    hunks: { id: string; diff: string }[];
  }[];
  review?: Review & { completion?: string };
  /** While the turn is under way: its last few steps, oldest first. */
  activity?: {
    item: string;
    kind: string;
    title: string;
    done: boolean;
    failed?: boolean;
    at: string;
  }[];
}
/** A turn of a worker as the main thread's transcript keeps it. */
export interface AgentEntryBlock extends Spoken {
  /** Where the stream told it, in Merv's thread. */ seq?: number;
  agent: string;
  title: string;
  provider: Provider;
  branch?: string;
  turn?: number;
  through?: number;
  outcome: 'finished' | 'failed' | 'stopped';
  completion?: string;
  review?: Review;
  /** How many files it changed, where that was measured. */
  files?: number;
  at?: string;
  /** It ended while work it started in the background still ran: the worker is still at it, and this entry becomes its result. */
  paused?: true;
}
/** A job's end as the transcript keeps it. */
export interface JobEntryBlock extends Spoken {
  /** Where the stream told it, in Merv's thread. */ seq?: number;
  job: string;
  title: string;
  state: 'done' | 'stopped';
  words: string;
  files?: number;
  author?: { thread: string; provider: Provider; completion?: string };
  at?: string;
}

const totals = (files: AgentResult['files']) =>
  files.reduce(
    (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }),
    { added: 0, removed: 0 },
  );
/** An opened card lists this many files; a turn that changed more says so in one line that shows them all. */
const FILES_SHOWN = 10;
/** A turn that ended does not change: read once, it is kept for the next time its card is opened. */
const ended = new Map<string, AgentResult>();
const keep = (key: string, result: AgentResult) => {
  ended.set(key, result);
  if (ended.size > 200) ended.delete(ended.keys().next().value!);
};

/** Whether a worker's ended work is certainly not in the default branch, asked each time its entry is opened and for
 *  nothing that is closed: it can change between two looks, so it is never kept. Unread or unreadable, it is not said. */
function useUnmerged(thread: string | undefined, asked: boolean): boolean {
  const [found, setFound] = useState<{ thread: string; unmerged: boolean }>();
  const source = useEntrySource();
  useEffect(() => {
    if (!asked || !thread || !source.unmerged) return setFound(undefined);
    let gone = false;
    void source.unmerged(thread).then(
      (read) => {
        if (!gone) setFound({ thread, unmerged: read.unmerged === true });
      },
      () => {
        if (!gone) setFound(undefined);
      },
    );
    return () => {
      gone = true;
    };
  }, [thread, asked]);
  return asked && !!found && found.thread === thread && found.unmerged;
}

/** A review's mark: only one that asks for something has any. The same shapes and colours as an agent's state. */
function ReviewMark({ end }: { end: ReviewEnd }) {
  if (end === 'changed files' || end === 'failed') return <StateMark state="failed" />;
  // The shape of something waiting, without its name: the words beside it say what this is.
  if (end === 'needs changes')
    return (
      <svg
        className="state-mark is-waiting"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
      >
        <path d="M7 1.5 12.5 7 7 12.5 1.5 7Z" fill="currentColor" />
      </svg>
    );
  return null;
}

/** The last words of every line that opens in place: what a press reveals, or that it closes. Part of the line, which is
 *  the press target; a screen reader hears the same from the line's own expanded state. */
function Toggle({ open, what }: { open: boolean; what: Reveals }) {
  return (
    <span className="agent-toggle" aria-hidden="true">
      {toggleWords(open, what)}
    </span>
  );
}

function Mark({ state }: { state: CardState }) {
  if (state === 'working') return <StateMark state="running" />;
  if (state === 'waiting') return <StateMark state="waiting" />;
  if (state === 'failed' || state === 'unreadable') return <StateMark state="failed" />;
  return null;
}

/** What an agent at work is doing now: its last few steps, oldest first, each as the session says it, the one under way
 *  in the running colour. When each began waits for the pointer. */
function Activity({ steps }: { steps: NonNullable<AgentResult['activity']> }) {
  if (!steps.length) return null;
  return (
    <div className="agent-activity" aria-label="What it is doing now">
      {steps.map((step, at) => {
        const kind = toolKind(step.kind, step.title),
          active = !step.done && at === steps.length - 1;
        const label = groupLabel(
          [{ item: step.item, kind, title: step.title, done: step.done, failed: !!step.failed }],
          true,
        );
        return (
          <p
            key={step.item}
            className={`agent-step${active ? ' is-active' : ''}${step.failed ? ' is-failed' : ''}`}
            title={new Date(step.at).toLocaleString()}
          >
            <ToolGlyph kind={kind} />
            <span className="agent-step-title">{label}</span>
          </p>
        );
      })}
    </div>
  );
}

/** One agent's turn. `at` names a turn that ended: its kept record when it has one, else that turn as the session has it
 *  now. Without `at` the card follows the agent's newest turn: `stamp` changes whenever the session moves, and while
 *  the agent works an open card is read again on a slow beat. A closed card reads nothing. */
export function AgentCard({
  id,
  title,
  provider,
  model,
  branch,
  state,
  at,
  stamp,
  review,
  says,
  round,
  files,
  opened,
  since,
  onOpen,
}: {
  id: string;
  title: string;
  provider: Provider;
  model?: string;
  branch?: string;
  state: Exclude<CardState, 'unreadable'>;
  at?: { turn?: number; through?: number; completion?: string };
  stamp?: string;
  /** Inside a job: which round the turn was in, said before the line. */
  round?: number;
  /** How many files the turn is known to have changed, before it is opened. */
  files?: number;
  /** It begins opened: a job's newest line, which is where the job stands. */
  opened?: boolean;
  /** Since when it has waited on the person: said after "needs you". */
  since?: string;
  /** A reviewer's card: the title of the work it judges, and for a turn that ended, what it concluded. */
  review?: { title: string; ended?: Pick<Review, 'verdict' | 'changed'> };
  /** Inside a job: the whole line in words, "Codex reviewed · needs changes", which names the agent itself. */
  says?: string;
  onOpen(target: PaneTarget): void;
}) {
  const [open, setOpen] = useState(!!opened);
  const frozen = at ? (at.completion ?? `${id}:${at.turn ?? ''}:${at.through ?? ''}`) : undefined;
  const [read, setRead] = useState<{ key: string; result?: AgentResult; failed?: boolean }>();
  const [file, setFile] = useState<string>();
  const [every, setEvery] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [beat, setBeat] = useState(0);
  const reading = useRef(false);
  const source = useEntrySource();
  // What was read under another state is another turn's: a working card never shows the words of the turn before.
  const key = frozen ?? `${id}:${state === 'working' || state === 'waiting' ? 'live' : state}`;
  const result = frozen
    ? (ended.get(frozen) ?? (read?.key === key ? read.result : undefined))
    : read?.key === key
      ? read.result
      : undefined;
  const failed = read?.key === key && !!read.failed;
  useEffect(() => {
    if (!open || (frozen && ended.has(frozen))) return;
    let gone = false;
    reading.current = true;
    void source
      .result(id, at)
      .then(
        (next) => {
          if (gone) return;
          if (frozen && next.state !== 'working' && !next.unreachable) keep(frozen, next);
          setRead({ key, result: next });
        },
        () => {
          if (!gone)
            setRead((was) => ({
              key,
              result: was?.key === key ? was.result : undefined,
              failed: true,
            }));
        },
      )
      .finally(() => {
        if (!gone) reading.current = false;
      });
    return () => {
      gone = true;
      reading.current = false;
    };
  }, [open, id, key, frozen, at?.completion, at?.turn, at?.through, stamp, beat, source]);
  // An agent at work says and changes things between the moments its session's state moves: an open card keeps up, slowly.
  const live = !at;
  useEffect(() => {
    if (!readsAgain({ open, state, live }, false, false)) return;
    const timer = setInterval(() => {
      if (readsAgain({ open, state, live }, document.visibilityState === 'hidden', reading.current))
        setBeat((was) => was + 1);
    }, LIVE_EVERY);
    return () => clearInterval(timer);
  }, [open, state, live]);
  // Opened by a press, the card comes into view whole where it can, within whatever scrolls it. One that begins opened
  // moves nothing: what stands above it, such as its job's own line and what can be done, stays where it is.
  const card = useRef<HTMLElement>(null),
    pressed = useRef(false);
  const loaded = !!result;
  useEffect(() => {
    if (open && pressed.current) card.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open, loaded, file]);
  const shown: CardState = open && failed && !result ? 'unreadable' : state;
  // A review that ended says what it concluded where an agent says how it ended. What the entry kept leads; the record opened agrees with it.
  const concluded = review?.ended ?? (review && at && result?.review ? result.review : undefined);
  const end =
    concluded &&
    shown !== 'unreadable' &&
    (state === 'finished' || state === 'failed' || state === 'stopped')
      ? reviewEnd(concluded, state)
      : undefined;
  const changed = !!(review && (concluded?.changed || result?.review?.changed));
  // A kept record counts everything the turn changed, also what it does not list.
  const sum = result
    ? (result.total ?? { files: result.files.length, ...totals(result.files) })
    : undefined;
  const left = {
    files: result ? Math.max(0, sum!.files - result.files.length) : 0,
    text: result?.files.filter((changed) => changed.state === 'omitted').length ?? 0,
  };
  // A long list opens short: the first few, and one line for the rest.
  const short = !!result && result.files.length > FILES_SHOWN && !every;
  const listed = result ? (short ? result.files.slice(0, FILES_SHOWN) : result.files) : [];
  // A finished worker's entry says, while open, that its work is not merged when that is certainly so.
  const unmerged = useUnmerged(id, open && !!at && !!branch && !review && state === 'finished');
  const body = `agent-card-${frozen ?? id}`;
  // A line of what is now (not a member's line in a job): one line, mark, name, state, and one word that opens its session.
  const row = says === undefined;
  const head = (
    <button
      type="button"
      className="agent-head"
      aria-expanded={open}
      aria-controls={body}
      onClick={() => {
        pressed.current = true;
        setOpen(!open);
      }}
      onKeyDown={(event) => {
        if (!event.metaKey && !event.ctrlKey && !event.altKey)
          moveLine(event, NOW_HEADS, '.agent-cards');
      }}
    >
      {says !== undefined ? (
        <>
          <ProviderMark provider={provider} size={16} />
          <MemberWords
            round={round}
            words={open && failed && !result ? `${says.split(' · ')[0]} · cannot be read` : says}
          />
        </>
      ) : (
        <>
          <ProviderMark provider={provider} size={16} />
          {model && (
            <span className="soft">
              {providerName(provider)} · {modelName(model)}
            </span>
          )}
          {review ? (
            <span className="agent-name">
              <span className="agent-role">
                {state === 'working' || state === 'waiting' ? 'reviewing ' : 'Review of '}
              </span>
              {review.title}
            </span>
          ) : (
            <span className="agent-name">{title}</span>
          )}
          <span className="agent-state">
            {end ? (
              <>
                <ReviewMark end={end} />
                {end}
              </>
            ) : (
              <>
                <Mark state={shown} />
                {shown === 'waiting' ? needsWords(since) : STATE_WORDS[shown]}
              </>
            )}
          </span>
        </>
      )}
      {!row && (
        <Toggle
          open={open}
          what={reveals({ state, review: !!review, files: files ?? result?.files.length })}
        />
      )}
    </button>
  );
  return (
    <section
      ref={card}
      className={`agent-card is-${end === 'changed files' ? 'failed' : shown}${review ? ' is-review' : ''}${end === 'needs changes' && row ? ' is-needs-changes' : ''}${end === 'passed' && row ? ' is-passed' : ''}${open ? ' is-open' : ''}`}
      data-agent={provider}
    >
      {row ? (
        <div className="agent-row">
          {head}
          <button
            type="button"
            className="agent-link"
            onClick={() => {
              setOpen(false);
              onOpen({ kind: 'thread', id });
            }}
          >
            open session
          </button>
        </div>
      ) : (
        head
      )}
      {open && (
        <div className="agent-body" id={body}>
          {!result ? (
            <p className="soft">{failed ? 'This turn cannot be read right now.' : 'Reading…'}</p>
          ) : (
            <>
              {/* The agent's own words lead, then the files it changed; where it worked and the sums come last. */}
              {/* The line above already states a review's verdict: the reviewer's own line that only repeats it is not shown again. */}
              {result.said ? (
                <div className="said assistant">
                  <Prose
                    text={review ? withoutVerdict(result.said, end) || result.said : result.said}
                  />
                </div>
              ) : (
                <p className="soft">
                  {result.state === 'working'
                    ? 'Nothing said yet in this turn.'
                    : 'It ended without a closing answer.'}
                </p>
              )}
              {result.cut && <p className="soft">Cut here. Open the session to read it whole.</p>}
              {result.state === 'working' && !!result.activity?.length && (
                <Activity steps={result.activity} />
              )}
              {failed && (
                <p className="soft">
                  This could not be read again just now; what is shown is from a moment ago.
                </p>
              )}
              {result.unmeasured && result.state !== 'working' && (
                <p className="soft">
                  {review
                    ? 'Whether files changed during this review was not measured.'
                    : result.unreachable
                      ? "This turn's changes could not be measured: its repository could not be read."
                      : "This turn's changes were not measured."}
                </p>
              )}
              {/* A review changes nothing, so it shows no changes. One that did says so before them. */}
              {changed && !!result.files.length && (
                <p className="soft agent-review-changed">
                  Files in this folder changed while the review ran, which a review must not do.
                  They are listed here; read its verdict with that in mind.
                </p>
              )}
              {!!result.files.length && (
                <ChangesLine
                  count={sum!.files}
                  soFar={result.settled === false}
                  open={changesOpen}
                  toggle={() => setChangesOpen(!changesOpen)}
                  id={`${body}-files`}
                />
              )}
              {!!result.files.length && changesOpen && (
                <div className="agent-files" id={`${body}-files`}>
                  {result.mixed && (
                    <p className="soft">
                      This folder was shared during the turn, so these changes may include someone
                      else's.
                    </p>
                  )}
                  {listed.map((changed) =>
                    changed.state === 'omitted' ? (
                      // Named and counted, with nothing behind it to open: the line under the list says why.
                      <div key={changed.path} className="agent-file is-omitted">
                        <span className="agent-path">{changed.path}</span>
                        <span>
                          {changed.status === 'modified' ? '' : `${changed.status} `}
                          <Counts added={changed.added} removed={changed.removed} />
                        </span>
                      </div>
                    ) : (
                      <div key={changed.path}>
                        <button
                          type="button"
                          className="agent-file"
                          aria-expanded={file === changed.path}
                          onClick={() => setFile(file === changed.path ? undefined : changed.path)}
                        >
                          <span className="agent-path">{changed.path}</span>
                          <Toggle open={file === changed.path} what="diff" />
                          <span className="agent-counts">
                            {changed.status === 'modified' ? '' : `${changed.status} `}
                            {changed.state === 'binary' ? (
                              'binary'
                            ) : (
                              <Counts added={changed.added} removed={changed.removed} />
                            )}
                          </span>
                        </button>
                        {file === changed.path &&
                          (changed.state ? (
                            <p className="soft">{UNSHOWN[changed.state]}</p>
                          ) : (
                            <Hunks hunks={changed.hunks} />
                          ))}
                      </div>
                    ),
                  )}
                  {/* Two different things can be missing, and each is said for what it is. */}
                  {short && (
                    <button
                      type="button"
                      className="agent-all-files"
                      onClick={() => setEvery(true)}
                    >
                      Show all {result.files.length}
                    </button>
                  )}
                  {!short && left.files > 0 && (
                    <p className="soft agent-more-changes">
                      {result.files.length} of {sum!.files} files shown. Open the session to see the
                      rest.
                    </p>
                  )}
                  {!short && left.text > 0 && (
                    <p className="soft agent-more-changes">
                      {left.text === 1
                        ? 'The dimmed file is named without its text.'
                        : `The ${left.text} dimmed files are named without their text.`}{' '}
                      Open the session to read {left.text === 1 ? 'it' : 'them'}.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
          {(branch || (!!result?.files.length && changesOpen)) && (
            <p className="agent-meta">
              {!!result?.files.length && changesOpen && (
                <span>
                  {sum!.files} {sum!.files === 1 ? 'file' : 'files'}{' '}
                  <Counts added={sum!.added} removed={sum!.removed} />
                </span>
              )}
              {branch && (
                <span className="agent-where">{whereWords(branch, !review, unmerged)}</span>
              )}
            </p>
          )}
          {/* The session opens under the thread with these same words in it: the card folds, so they are not shown twice.
          A link in words at the end of what was read, where reading ends. */}
          {!row && (
            <div className="actions">
              <button
                type="button"
                className="agent-open"
                onClick={() => {
                  setOpen(false);
                  onOpen({ kind: 'thread', id });
                }}
              >
                Open this {review ? 'reviewer' : 'worker'}'s session
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Every line of what is now, for the arrow keys to move between. */
export const NOW_HEADS = ':scope .now-rows > .agent-card > .agent-row > .agent-head';

/** Live work folded behind one plain word over the reply box, at its right: "3 running". Pressed, what runs opens above
 *  it; pressed again, it folds. Folded, its lines stay mounted, only hidden, so nothing in them is lost or stopped.
 *  Off (a chat that has the window), or with nothing live, there is no word and nothing is hidden. */
export function useRunningFold(on: boolean, count: number, needs = false) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const shown = on && count > 0;
  return {
    region: { id, hidden: shown && !open },
    button: shown && (
      <div className="running-fold">
        <button
          type="button"
          className={`running-toggle${needs ? ' is-needs' : ''}`}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
        >
          {count} running
        </button>
      </div>
    ),
  };
}

/** The thread's Now container owns scrolling; rows keep their natural height. */
export function NowRows({ children }: { children: ReactNode }) {
  return <div className="now-rows">{children}</div>;
}

/** A turn that ended, read once: by its kept record, else as the session has it now. Asked only while `wanted`. */
function useEnded(
  id: string | undefined,
  at: { turn?: number; through?: number; completion?: string } | undefined,
  wanted: boolean,
): { result?: AgentResult; failed: boolean } {
  const key = at?.completion ?? `${id}:${at?.turn ?? ''}:${at?.through ?? ''}`;
  const [read, setRead] = useState<{ key: string; result?: AgentResult; failed?: boolean }>();
  const source = useEntrySource();
  useEffect(() => {
    if (!wanted || !id || ended.has(key)) return;
    let gone = false;
    void source.result(id, at).then(
      (next) => {
        if (next.state !== 'working' && !next.unreachable) keep(key, next);
        if (!gone) setRead({ key, result: next });
      },
      () => {
        if (!gone) setRead({ key, failed: true });
      },
    );
    return () => {
      gone = true;
    };
  }, [wanted, id, key, source]);
  return {
    result: id ? (ended.get(key) ?? (read?.key === key ? read.result : undefined)) : undefined,
    failed: read?.key === key && !!read.failed,
  };
}

/** Whether a line has come into view, once: an entry that must ask for its words asks only then. */
function useSeen(line: RefObject<Element | null>, wanted: boolean): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!wanted || seen) return;
    const el = line.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setSeen(true);
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: '240px' },
    );
    watch.observe(el);
    return () => watch.disconnect();
  }, [wanted, seen]);
  return seen;
}

/** The one quiet line at the end of a finished entry: how many files it changed and the word that lists them, then what
 *  can be done with its work (`after`). Opened, the files follow under the line: the first few by name with their
 *  counts, the rest behind "and 4 more"; a name opens that file's diff in place, its text asked for only then. */
function Footer({
  agent,
  at,
  named,
  count,
  id,
  after,
  below,
}: {
  agent?: string;
  at?: { turn?: number; through?: number; completion?: string };
  named: EntryFile[];
  count: number;
  id: string;
  after?: ReactNode;
  below?: ReactNode;
}) {
  const [file, setFile] = useState<string>(),
    [all, setAll] = useState(false),
    [open, setOpen] = useState(false);
  const { result, failed } = useEnded(agent, at, !!file);
  const files = !!named.length && !!agent && !!at;
  if (!files && !after && !below) return null;
  const total = Math.max(count, named.length),
    more = total - Math.min(FILES_NAMED, named.length),
    shown = all ? named : named.slice(0, FILES_NAMED);
  const opened = file ? result?.files.find((changed) => changed.path === file) : undefined;
  return (
    <div className={`agent-foot${open ? '' : ' is-quiet'}`}>
      {(files || after) && (
        <div className="agent-foot-line">
          {files && (
            <ChangesLine
              count={total}
              open={open}
              toggle={() => {
                setOpen(!open);
                if (open) setFile(undefined);
              }}
              id={`${id}-files`}
            />
          )}
          {after}
        </div>
      )}
      {files && open && (
        <>
          <p className={`agent-changed-line${all ? ' is-all' : ''}`} id={`${id}-files`}>
            {shown.map((changed) => (
              <button
                key={changed.path}
                type="button"
                className="agent-file-name"
                aria-expanded={file === changed.path}
                aria-controls={id}
                onClick={() => setFile(file === changed.path ? undefined : changed.path)}
              >
                <span className="agent-path">{changed.path}</span>
                {(changed.added > 0 || changed.removed > 0) && (
                  <>
                    {' '}
                    <Counts added={changed.added} removed={changed.removed} />
                  </>
                )}
              </button>
            ))}
            {more > 0 && named.length <= FILES_NAMED && (
              <span className="agent-unnamed">and {more} more</span>
            )}
            {named.length > FILES_NAMED && (
              <button
                type="button"
                className="agent-more-files"
                aria-expanded={all}
                onClick={() => {
                  if (
                    all &&
                    file &&
                    !named.slice(0, FILES_NAMED).some((changed) => changed.path === file)
                  )
                    setFile(undefined);
                  setAll(!all);
                }}
              >
                {all ? 'show fewer' : `and ${more} more`}
              </button>
            )}
          </p>
          {all && total > named.length && (
            <p className="soft agent-more-changes">
              {named.length} of {total} files named. Its session has the rest.
            </p>
          )}
          {file && (
            <div className="agent-diff" id={id}>
              {!result ? (
                <p className="soft">
                  {failed ? "This file's changes cannot be read right now." : 'Reading…'}
                </p>
              ) : !opened || opened.state === 'omitted' ? (
                <p className="soft">Its text is not kept here. Its session has it.</p>
              ) : opened.state ? (
                <p className="soft">{UNSHOWN[opened.state]}</p>
              ) : (
                <>
                  {result.mixed && (
                    <p className="soft">
                      This folder was shared during the turn, so these changes may include someone
                      else's.
                    </p>
                  )}
                  <Hunks hunks={opened.hunks} />
                </>
              )}
            </div>
          )}
        </>
      )}
      {below}
    </div>
  );
}

/** What an entry shows of its turn: carried by the entry itself, or, for one an earlier build wrote, read from its
 *  completion once it is in view. Unread or unreadable, only who it was is known. */
function useSpoken(
  line: RefObject<Element | null>,
  entry: Spoken & { files?: number },
  agent: string | undefined,
  at: { turn?: number; through?: number; completion?: string } | undefined,
  folded = false,
) {
  // Folded, only what the entry itself carries is shown: nothing is read for it.
  const seen = useSeen(line, !entry.worded && !folded);
  const { result } = useEnded(agent, at, !entry.worded && seen && !!agent);
  if (entry.worded)
    return {
      known: true,
      said: entry.said ?? '',
      cut: !!entry.cut,
      named: entry.changes ?? [],
      count: entry.files ?? entry.changes?.length ?? 0,
    };
  if (!result || result.state === 'working')
    return { known: false, said: '', cut: false, named: [] as EntryFile[], count: 0 };
  return {
    known: true,
    said: result.said,
    cut: result.cut,
    named: result.files as EntryFile[],
    count: result.total?.files ?? result.files.length,
  };
}

/** What can be done with ended work that sits on its own branch, as plain muted words on its entry's last line: merge
 *  it into the branch it really grew from (named, as the desk reads it from git), open a pull request where the
 *  repository has one to open, or discard it. Read once the entry is in view. A merge the desk refuses changes nothing
 *  and says why in words under the line. Discarding destroys work, so it asks once more in the same place; nothing else
 *  here does. Once either is done the words are gone and the line states the fact, in the words the desk kept as it did
 *  it (`workWords`): never inferred. */
function useWorkEnd(
  thread: string | undefined,
  line: RefObject<Element | null>,
  wanted: boolean,
): { acts?: ReactNode; reason?: ReactNode } {
  const source = useEntrySource();
  wanted &&= !!source.work;
  const seen = useSeen(line, wanted && !!thread);
  const [work, setWork] = useState<Work>(),
    [busy, setBusy] = useState(''),
    [reason, setReason] = useState(''),
    [sure, setSure] = useState(false);
  useEffect(() => {
    if (!wanted || !seen || !thread) return;
    let gone = false;
    void source.work!(thread).then(
      (read) => {
        if (!gone) setWork(read);
      },
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [wanted, seen, thread]);
  // The second question is not left standing: it is withdrawn after a moment, and when the keys leave it.
  useEffect(() => {
    if (!sure) return;
    const timer = setTimeout(() => setSure(false), 6000);
    return () => clearTimeout(timer);
  }, [sure]);
  if (!wanted || !thread || !work) return {};
  const said = workWords(work);
  if (said.fact)
    return {
      acts: (
        <span className="work-end">
          <span className="work-fact">{said.fact}</span>
        </span>
      ),
    };
  if (!said.acts.length) return {};
  const act = async (what: 'merge' | 'pull-request' | 'discard') => {
    if (busy) return;
    if (what === 'discard' && !sure) return setSure(true);
    setBusy(what);
    setReason('');
    setSure(false);
    try {
      setWork(await source.act!(thread, what));
    } catch (failed) {
      setReason((failed as Error).message);
    } finally {
      setBusy('');
    }
  };
  return {
    acts: (
      <span className="work-end">
        {said.acts.map(({ what, words, into }, at) => (
          <span key={what} className="work-each">
            {at > 0 && (
              <span className="work-sep" aria-hidden="true">
                ·
              </span>
            )}
            <button
              type="button"
              className="work-act"
              disabled={!!busy}
              onClick={() => void act(what)}
              onBlur={what === 'discard' ? () => setSure(false) : undefined}
            >
              {words}
              {into && (
                <>
                  {' '}
                  <span className="work-into">{into}</span>
                </>
              )}
              {what === 'discard' && sure ? ' · sure?' : busy === what ? '…' : ''}
            </button>
          </span>
        ))}
      </span>
    ),
    reason: reason ? (
      <p className="soft work-reason" role="alert">
        {reason}
      </p>
    ) : undefined,
  };
}

/** A worker's turn that ended, in the main thread where it ended: a message from that agent. Its name is the way into
 *  its session. How it ended is said after the name only when that is news: it failed, it was stopped, it said nothing,
 *  or, for a review, what it concluded. */
export function AgentEntry({
  entry,
  onOpen,
  last,
  children,
}: {
  entry: AgentEntryBlock;
  onOpen(target: PaneTarget): void;
  /** This is the newest turn of its agent in the thread: where that agent's work is spoken for, once. */
  last?: boolean;
  /** What else stands under its words, before its last line: in Merv's thread, what a manager added. */
  children?: ReactNode;
}) {
  const line = useRef<HTMLElement>(null);
  const at = { turn: entry.turn, through: entry.through, completion: entry.completion };
  const [folded, toggle] = useFolded(
    `agent:${entry.completion ?? `${entry.agent}:${entry.turn ?? ''}:${entry.through ?? ''}`}`,
  );
  const { known, said, cut, named, count } = useSpoken(line, entry, entry.agent, at, folded);
  const review = entry.review,
    end = review ? reviewEnd(review, entry.outcome) : undefined;
  const work = useWorkEnd(
    entry.agent,
    line,
    !folded && !!last && !review && entry.outcome === 'finished' && !!entry.branch,
  );
  // The name line already states a review's verdict: the reviewer's own line that only repeats it is not shown again.
  const words = (review ? withoutVerdict(said, end) : said).trim();
  // Paused while its background work runs, it has not ended: it says so, open or folded, until it carries on in this place.
  const paused = !review && entry.paused && entry.outcome === 'finished';
  // The line always says how it ended, open or folded, in an agent's own state words: never "job".
  const how =
    end ??
    (paused
      ? PAUSED_WORDS
      : entry.outcome !== 'finished'
        ? entry.outcome
        : known && !words && !named.length
          ? 'finished without an answer'
          : 'finished');
  const tone =
    how === 'failed' || how === 'changed files'
      ? 'failed'
      : how === 'passed'
        ? 'passed'
        : how === 'needs changes'
          ? 'needs-changes'
          : 'quiet';
  const id = `agent-said-${entry.completion ?? `${entry.agent}:${entry.turn ?? ''}:${entry.through ?? ''}`}`;
  return (
    <section
      ref={line}
      className={`agent-msg is-${entry.outcome}${review ? ' is-review' : ''}${folded ? ' is-folded' : ''}`}
      data-agent={entry.provider}
      data-seq={entry.seq}
    >
      <EntryLine
        folded={folded}
        toggle={toggle}
        at={entry.at}
        files={entry.files ?? (known ? count : undefined)}
        what={reveals({
          state: entry.outcome,
          review: !!review,
          files: entry.files ?? (known ? count : undefined),
        })}
        mark={<ProviderMark provider={entry.provider} size={16} />}
        name={
          review
            ? `Review of ${askTitle(review.title) || 'an agent'}`
            : askTitle(entry.title) || 'Agent'
        }
        end={
          how && (
            <span className={`agent-end is-${tone}`}>
              {review ? (
                <ReviewMark end={end!} />
              ) : paused ? (
                <StateMark state="running" />
              ) : (
                how === 'failed' && <StateMark state="failed" />
              )}
              {how}
            </span>
          )
        }
        session={{ words: 'open session', open: () => onOpen({ kind: 'thread', id: entry.agent }) }}
      />
      {!folded && (
        <>
          {!!words && <Words text={words} cut={cut} id={id} />}
          {/* A review changes nothing, so it names no files. One that did says so before them. */}
          {review?.changed && !!named.length && (
            <p className="soft agent-review-changed">
              Files in this folder changed while the review ran, which a review must not do. Read
              its verdict with that in mind.
            </p>
          )}
          {children}
          {/* One quiet last line: what it changed, then, for a plain worker that finished on its own branch, what can be done with that work, at its newest message. */}
          <Footer
            agent={entry.agent}
            at={at}
            named={named}
            count={count}
            id={`${id}-diff`}
            after={work.acts}
            below={work.reason}
          />
        </>
      )}
    </section>
  );
}

/** A member's line inside a job: which round, who did what, then how it came out, quieter. */
function MemberWords({ words, round }: { words: string; round?: number }) {
  const [lead, ...rest] = words.split(' · ');
  return (
    <>
      <span className="agent-name">
        {!!round && <span className="agent-role">Round {round} · </span>}
        {lead}
      </span>
      {!!rest.length && <span className="agent-state">· {rest.join(' · ')}</span>}
    </>
  );
}

/** The turns a job's members took, oldest first: one plain line each, saying its round, and each opens in place to that
 *  member's own words and diff. */
function JobLines({
  job,
  threads,
  opened,
  onOpen,
}: {
  job: JobView;
  threads?: Thread[];
  opened?: number;
  onOpen(target: PaneTarget): void;
}) {
  const live = (line: JobLine) => threads?.find((thread) => thread.id === line.thread);
  return (
    <>
      {!job.lines.length && <p className="soft">Nobody has taken a turn in it yet.</p>}
      {job.lines.map((line) => (
        <AgentCard
          key={line.n}
          id={line.thread}
          title=""
          provider={line.provider}
          says={
            line.model
              ? line.words.replace(
                  providerName(line.provider),
                  `${providerName(line.provider)} · ${modelName(line.model)}`,
                )
              : line.words
          }
          round={line.round}
          files={line.files}
          opened={line.n === opened}
          state={line.state}
          at={line.completion ? { completion: line.completion } : undefined}
          stamp={
            line.completion
              ? undefined
              : `${live(line)?.updated_at}:${live(line)?.status}:${live(line)?.counts?.turns ?? 0}`
          }
          review={
            line.role === 'reviewer' ? { title: askTitle(job.title) || 'this work' } : undefined
          }
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

/** A job's goal and state stay visible; its round history opens only when asked. */
function JobCard({
  job,
  threads,
  onOpen,
}: {
  job: JobView;
  threads?: Thread[];
  onOpen(target: PaneTarget): void;
}) {
  const id = job.id,
    mac = useMacDesk();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const state = job.state;
  // A legacy fallback that only repeats the title adds nothing to the row.
  const summary = job.summary && goalOf(job.summary, askTitle(job.title)).first ? job.summary : '';
  const words = jobWords(job.rounds ? job.words.replace(/ · round \d+$/, '') : job.words),
    body = `job-${id}`;
  const act = async (what: 'continue' | 'stop') => {
    if (busy) return;
    setBusy(what);
    setError('');
    try {
      await jobAct(mac, id, what);
    } catch (failed) {
      setError((failed as Error).message);
      setOpen(true);
    } finally {
      setBusy('');
    }
  };
  // A job the person opened comes into view.
  const card = useRef<HTMLElement>(null),
    pressed = useRef(false);
  useEffect(() => {
    if (open && pressed.current) card.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open, job.lines.length]);
  const actions = !!jobActions(job).length && (
    <p className="job-actions">
      {jobActions(job).map((what) => (
        <button
          key={what}
          type="button"
          className="job-act"
          disabled={!!busy}
          onClick={() => void act(what)}
        >
          {what === 'continue' ? continueWords(job) : 'Stop'}
        </button>
      ))}
    </p>
  );
  // The spinner takes the colour of whichever member is at work now.
  const working = state === 'running' ? job.lines.at(-1)?.provider : undefined;
  return (
    <section
      ref={card}
      className={`agent-card job-card is-${state}${open ? ' is-open' : ''}`}
      data-agent={working}
      data-job={job.id}
    >
      <div className="agent-row">
        <button
          type="button"
          className="agent-head"
          aria-expanded={open}
          aria-controls={body}
          onClick={() => {
            pressed.current = true;
            setOpen(!open);
          }}
          onKeyDown={(event) => {
            // With the keys on a job's line: the arrows move between lines, S stops it, C carries it on. The key is the line's, not the reply box's.
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.altKey ||
              moveLine(event, NOW_HEADS, '.agent-cards')
            )
              return;
            const what = jobKey(job, event.key);
            if (!what || event.repeat) return;
            event.preventDefault();
            event.stopPropagation();
            void act(what);
          }}
        >
          <JobMark />
          <span className="job-overview">
            <span className="agent-name">{askTitle(job.title) || 'Job'}</span>
            {summary && <span className="job-summary">{summary}</span>}
            <span className="agent-state">
              {job.rounds &&
                `round ${Math.min(job.round ?? 1, job.rounds.max)} of ${job.rounds.max} · `}
              {state === 'running' && <StateMark state="running" />}
              {words.accent && <span className="job-needs">{needsWords(job.since)}</span>}
              {words.accent && words.rest ? ` ${words.rest}` : words.rest}
            </span>
          </span>
        </button>
        {job.main && (
          <button
            type="button"
            className="agent-link job-open"
            onClick={() => openJobPage(job.main!, job.id)}
          >
            open job
          </button>
        )}
      </div>
      {actions}
      {error && (
        <p className="said error-line" role="alert">
          {error}
        </p>
      )}
      {open && (
        <div className="agent-body job-body" id={body}>
          <JobLines job={job} threads={threads} opened={job.lines.at(-1)?.n} onOpen={onOpen} />
        </div>
      )}
    </section>
  );
}

/** A job that ended, in the main thread where it ended: one line, its own mark and its name, and one word, "open job",
 *  that opens its page. How it ended, its rounds, its writer's words and what can be done with its work are all on that
 *  page; the line repeats none of it. The name takes the line's room and is cut only when it does not fit. */
export function JobEntry({
  entry,
  main,
  device,
  children,
}: {
  entry: JobEntryBlock;
  /** The main thread it is in: its page opens over it. */ main?: string;
  /** Far from the Mac: which Mac has it, for its page to be read from. */ device?: string;
  /** What else stands under its line: in Merv's thread, what a manager added. */
  children?: ReactNode;
}) {
  const title = askTitle(entry.title) || 'Job';
  return (
    <section
      className={`agent-msg job-msg is-${entry.state}`}
      data-job={entry.job}
      data-seq={entry.seq}
    >
      <div className="agent-line job-row">
        <span className="agent-by">
          <JobMark />
          <span className="agent-name" title={title}>
            {title}
          </span>
        </span>
        {main && (
          <button
            type="button"
            className="job-open"
            onClick={() => openJobPage(main, entry.job, device)}
          >
            open job
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

/** A task handed to a new agent without leaving the thread: it starts on a branch of its own and shows above as it works. */
function NewAgent({ cwd, onStarted }: { cwd: string; onStarted?(): void }) {
  const call = useMacDesk();
  const [text, setText] = useState('');
  const [provider, setProvider] = useState<Thread['provider']>(() =>
    localStorage.getItem('merv:thread-agent') === 'codex' ? 'codex' : 'claude',
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const start = async () => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError('');
    try {
      await call<{ thread: string }>('threads', { provider, cwd, prompt, ownBranch: true });
      setText('');
      onStarted?.();
    } catch (failed) {
      setError((failed as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const other = provider === 'claude' ? 'codex' : 'claude';
  return (
    <form
      className="agent-new"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <button
        type="button"
        className="agent-pick"
        title={`Start with ${other === 'codex' ? 'Codex' : 'Claude Code'} instead`}
        aria-label={`Agent: ${provider === 'codex' ? 'Codex' : 'Claude Code'}. Press to change.`}
        disabled={busy}
        onClick={() => {
          setProvider(other);
          try {
            localStorage.setItem('merv:thread-agent', other);
          } catch {}
        }}
      >
        <ProviderMark provider={provider} size={16} />
      </button>
      <input
        value={text}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        placeholder={`Give an agent a task in ${folderName(cwd)}, on its own branch`}
        aria-label="Task for a new agent"
      />
      <button type="submit" disabled={busy || !text.trim()}>
        {busy ? 'Starting…' : 'Start'}
      </button>
      {error && (
        <p className="said error-line" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** What a project's Now lists: its jobs under way, one that needs the person first, each one line with its members
 *  inside it, and the agents at work or asking outside them. `asking` is the agent whose request card shows beside. */
export function liveWork(
  threads: Thread[],
  waiting?: Set<string>,
  finished?: boolean,
  asking?: string,
) {
  const jobs = [...(mainThread(threads)?.jobs ?? [])].sort(
    (a, b) => Number(b.state === 'needs') - Number(a.state === 'needs'),
  );
  const agents = threadAgents(outsideJobs(threads, jobs), Date.now(), waiting, finished).filter(
    (thread) => thread.id !== asking || !waiting?.has(thread.id),
  );
  return { jobs, agents };
}

export function AgentCards({
  threads,
  waiting,
  onOpen,
  project,
  onStarted,
  most,
  finished,
  asking,
  now,
  held,
  since,
  shown: wanted,
}: {
  /** The column beside the chat lists who is at work: only what must be answered here stays, a job that waits for the
   *  person's word, with no heading. A request stands under it in its own place, as ever. */
  held?: boolean;
  /** A job the person asked to see from the column: held, it shows too, whatever its state. */
  shown?: string;
  threads: Thread[];
  waiting?: Set<string>;
  onOpen(target: PaneTarget): void;
  /** Since when each asking session has waited, where the desk said. */
  since?: Map<string, string>;
  /** The conversation above has entries: these lines, which say how things stand, are introduced by the one word "Now". */
  now?: boolean;
  /** The agent whose request card is showing right beside these: it is not also listed as needing the person. */
  asking?: string;
  /** The project's main checkout: with it, a new agent can be started from here. */
  project?: string;
  onStarted?(): void;
  /** How many show before the rest wait behind one line; absent, all of them show. One that needs the person always shows. */
  most?: number;
  /** For a thread that keeps no record of finished turns: those done within the day show too. */
  finished?: boolean;
}) {
  const [all, setAll] = useState(false);
  const { jobs, agents } = liveWork(threads, waiting, finished, asking);
  // The request card standing beside these is live too: with it alone, the word still says where "now" begins.
  const asked = !!asking && !!waiting?.has(asking);
  if (held) {
    const waits = jobs.filter(
      (job) => (job.state === 'needs' && job.needs !== 'asking') || job.id === wanted,
    );
    return waits.length ? (
      <div className="agent-cards is-held" aria-label="Jobs that need you">
        <NowRows>
          {waits.map((job) => (
            <JobCard key={job.id} job={job} threads={threads} onOpen={onOpen} />
          ))}
        </NowRows>
      </div>
    ) : null;
  }
  if (!agents.length && !jobs.length && !project && !(now && asked)) return null;
  const { shown, more } = shownAgents(agents, most, all, (thread) => !!waiting?.has(thread.id));
  return (
    <div className="agent-cards" aria-label="Agents at work in this project">
      {now && (agents.length > 0 || jobs.length > 0 || asked) && <p className="agent-now">Now</p>}
      {(jobs.length > 0 || shown.length > 0) && (
        <NowRows>
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} threads={threads} onOpen={onOpen} />
          ))}
          {shown.map((thread) => (
            <AgentCard
              key={thread.id}
              id={thread.id}
              title={sessionTitle(thread.title, thread.cwd)}
              provider={thread.provider}
              model={thread.choices?.model}
              branch={thread.worktree?.branch}
              state={
                waiting?.has(thread.id)
                  ? 'waiting'
                  : thread.status === 'running'
                    ? 'working'
                    : thread.status === 'failed'
                      ? 'failed'
                      : thread.status === 'stopped'
                        ? 'stopped'
                        : 'finished'
              }
              since={since?.get(thread.id)}
              review={thread.review && { title: askTitle(thread.review.title) || 'an agent' }}
              stamp={`${thread.updated_at}:${thread.status}:${thread.counts?.turns ?? 0}`}
              onOpen={onOpen}
            />
          ))}
        </NowRows>
      )}
      {more > 0 && (
        <button type="button" className="agent-more" onClick={() => setAll(true)}>
          {more} more at work
        </button>
      )}
      {project && <NewAgent cwd={project} onStarted={onStarted} />}
    </div>
  );
}
