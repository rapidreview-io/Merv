/**
 * Merv's one thread, drawn: every project's conversation in one column, with the very components a project's main
 * thread is drawn with. The person's words and Merv's, Merv's steps folded to one gray line, a worker's finish and a
 * job's end as the main thread's own entries (read from afar through an entry source); and, what only this thread has,
 * a worker starting as one quiet line, a question (the one place the accent goes while it waits), a stop. What is live stands over the reply box under the word "Now". Nothing here is a box, and nothing
 * here acts: a name is the way into that session, and everything else is said to Merv.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentEntry, JobEntry, NOW_HEADS, NowRows, useRunningFold } from './agent-cards';
import { moveLine } from './live-lines';
import { AssistantSaid } from './chat-entry';
import { EntrySourceProvider, farSource, type EntrySource } from './entry-source';
import { threadEntries, type MervTurn, type ThreadEntry } from './one-thread-entries';
import { openJobPage, type PaneTarget } from './panes';
import { Trail } from './trail';
import { FILES_NAMED, needsWords, reviewEnd, withoutVerdict } from './agents';
import { requestWords } from './approval';
import { ChangesLine, Counts, Hunks, UNSHOWN } from './entry-parts';
import { JobMark, ProviderMark, StateMark, ToolGlyph, toolKind } from './marks';
import { Prose } from './prose';
import { SentFiles, splitAttached } from './merv-files';
import { ago, askTitle } from './rows';
import {
  dayWords,
  memberWords,
  type NowLine,
  type OneThread,
  type QuestionRow,
  type StartedRow,
  type StopRow,
  type ThreadMember,
  type ThreadNote,
  type ThreadStep,
  type Who,
} from './one-thread';
import type { DoneCard } from '@merv/protocol/link';

/** A session to open beside the thread: a worker's, a reviewer's, or a project's own main thread. */
export interface ThreadOpen {
  device?: string;
  thread: string;
}
/** A turn in full, as its Mac has it: asked for only when a file's name or a worker's progress is opened. */
export interface Report {
  said?: string;
  state?: string;
  mixed?: boolean;
  files: {
    path: string;
    state?: 'binary' | 'too_large' | 'unavailable' | 'omitted';
    hunks: { id: string; diff: string }[];
  }[];
  activity?: { kind: string; title: string; done: boolean; failed?: boolean; at: string }[];
}
export type ReadReport = (ask: {
  device?: string;
  agent?: string;
  completion?: string;
}) => Promise<Report>;
interface Ways {
  onOpen?(target: ThreadOpen): void;
  read?: ReadReport;
  /** A question's choice was pressed: it is the person's answer, said to Merv. Without it, choices are words to read.
   *  Answers whether it was sent: one that was not leaves the choices to press again. */
  answer?(row: QuestionRow, choice: string): Promise<boolean> | boolean;
}

const age = (at: string) => {
  const when = ago(at);
  return when ? (
    <span className="row-age agent-age" title={new Date(at).toLocaleString()}>
      {when === 'now' ? 'now' : `${when} ago`}
    </span>
  ) : null;
};
const mark = (from: Pick<Who, 'provider' | 'kind'>, size = 16) =>
  from.kind === 'job' ? (
    <JobMark size={size} />
  ) : from.provider ? (
    <ProviderMark provider={from.provider} size={size} />
  ) : (
    <span className="one-dot" aria-hidden="true" />
  );
const nameOf = (from: Who, fallback = 'A worker') => askTitle(from.title) || fallback;

/** What the person wrote: their words, and the files that went with them. */
export function UserSaid({ id, text: said }: { id?: string; text: string }) {
  const { text, files } = splitAttached(said);
  if (!files.length && text.length > 600) return <Spoken text={text} />;
  return (
    <div data-block-id={id} className="said user">
      {text}
      {files.length > 0 && <SentFiles files={files} />}
    </div>
  );
}

/** A long turn is what the person said aloud: one line saying how long, the words a press away. */
export function Spoken({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const minutes = Math.max(1, Math.round(text.split(/\s+/).length / 150));
  return (
    <p className={`said user is-spoken${open ? ' is-open' : ''}`} onClick={() => setOpen(!open)}>
      {open ? text : `\u{1F399} ${minutes} min`}
    </p>
  );
}

/** What a manager added to an entry: quiet, unless it changes what the work means. */
function Notes({ notes }: { notes: ThreadNote[] }) {
  return (
    <>
      {notes.map((note) => (
        <p key={note.seq} className={`one-note${note.matters ? ' is-news' : ''}`}>
          <span className="one-note-by">manager</span>
          {note.text}
        </p>
      ))}
    </>
  );
}

/** The one quiet line under a finish: how many files, and the word that names them. A name opens that file's changes in
 *  place, read from its Mac only then; where nothing can read them, the names are just names. */
function Files({
  card,
  device,
  agent,
  completion,
  id,
  read,
  after,
}: {
  card: Pick<DoneCard, 'files' | 'changes'>;
  device?: string;
  agent?: string;
  completion?: string;
  id: string;
  read?: ReadReport;
  /** What else the last line holds: the way into the session. */
  after?: ReactNode;
}) {
  const [open, setOpen] = useState(false),
    [all, setAll] = useState(false),
    [file, setFile] = useState<string>();
  const [found, setFound] = useState<{ report?: Report; failed?: string }>();
  const named = card.changes ?? [],
    total = Math.max(card.files ?? 0, named.length);
  const can = !!read && !!agent;
  useEffect(() => {
    if (!file || !can || found?.report) return;
    let gone = false;
    setFound(undefined);
    void read!({ device, agent, completion }).then(
      (report) => {
        if (!gone) setFound({ report });
      },
      (failed: Error) => {
        if (!gone)
          setFound({ failed: failed.message || "This file's changes cannot be read right now." });
      },
    );
    return () => {
      gone = true;
    };
  }, [file, can, device, agent, completion]);
  if (!total)
    return after ? (
      <div className="agent-foot is-quiet">
        <div className="agent-foot-line">{after}</div>
      </div>
    ) : null;
  if (!named.length)
    return (
      <div className="agent-foot is-quiet">
        <div className="agent-foot-line">
          <span className="one-files">
            {total} {total === 1 ? 'file' : 'files'}
          </span>
          {after}
        </div>
      </div>
    );
  const more = total - Math.min(FILES_NAMED, named.length),
    shown = all ? named : named.slice(0, FILES_NAMED);
  const opened = file ? found?.report?.files.find((changed) => changed.path === file) : undefined;
  return (
    <div className={`agent-foot${open ? '' : ' is-quiet'}`}>
      <div className="agent-foot-line">
        <ChangesLine
          count={total}
          open={open}
          toggle={() => {
            setOpen(!open);
            if (open) setFile(undefined);
          }}
          id={`${id}-files`}
        />
        {after}
      </div>
      {open && (
        <>
          <p className={`agent-changed-line${all ? ' is-all' : ''}`} id={`${id}-files`}>
            {shown.map((changed) => {
              const counts = (changed.added > 0 || changed.removed > 0) && (
                <>
                  {' '}
                  <Counts added={changed.added} removed={changed.removed} />
                </>
              );
              return can ? (
                <button
                  key={changed.path}
                  type="button"
                  className="agent-file-name"
                  aria-expanded={file === changed.path}
                  onClick={() => setFile(file === changed.path ? undefined : changed.path)}
                >
                  <span className="agent-path">{changed.path}</span>
                  {counts}
                </button>
              ) : (
                <span key={changed.path} className="agent-file-name is-plain">
                  <span className="agent-path">{changed.path}</span>
                  {counts}
                </span>
              );
            })}
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
          {file && (
            <div className="agent-diff">
              {!found ? (
                <p className="soft">Reading…</p>
              ) : found.failed ? (
                <p className="soft">{found.failed}</p>
              ) : !opened || opened.state === 'omitted' ? (
                <p className="soft">Its text is not kept here. Its session has it.</p>
              ) : opened.state ? (
                <p className="soft">{UNSHOWN[opened.state]}</p>
              ) : (
                <>
                  {found.report!.mixed && (
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
    </div>
  );
}

const reviewOf = (
  card: DoneCard,
): { verdict: 'pass' | 'needs changes' | 'none'; title: string; changed?: boolean } | undefined =>
  card.review && {
    verdict:
      card.review.verdict === 'pass' || card.review.verdict === 'needs changes'
        ? card.review.verdict
        : 'none',
    title: card.review.title,
    ...(card.review.changed && { changed: true }),
  };
/** A member's turn inside a job: one line, "Round 2 · Codex reviewed · needs changes", which opens in place to that
 *  member's own words and files. */
function Member({
  member,
  onOpen,
  read,
}: { member: ThreadMember } & Pick<Ways, 'onOpen' | 'read'>) {
  const [open, setOpen] = useState(false);
  const [lead, ...rest] = memberWords(member).split(' · ');
  const review = reviewOf(member.card),
    end = review ? reviewEnd(review, member.outcome) : undefined;
  const words = (
    review ? withoutVerdict(member.card.said ?? '', end) : (member.card.said ?? '')
  ).trim();
  const id = `one-m${member.seq}`,
    session = member.card.agent ?? member.who.id;
  return (
    <section
      className={`agent-card is-${member.outcome}${review ? ' is-review' : ''}${open ? ' is-open' : ''}`}
      data-agent={member.who.provider}
    >
      <button
        type="button"
        className="agent-head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {mark(member.who)}
        <span className="agent-name">
          {!!member.round && <span className="agent-role">Round {member.round} · </span>}
          {lead}
        </span>
        {!!rest.length && <span className="agent-state">· {rest.join(' · ')}</span>}
        <span className="agent-toggle" aria-hidden="true">
          {open ? 'hide' : review ? 'show review' : words ? 'show answer' : 'show changes'}
        </span>
      </button>
      {open && (
        <div className="agent-body" id={id}>
          {words ? (
            <div className="said assistant">
              <Prose text={words} />
            </div>
          ) : (
            <p className="soft">It ended without a closing answer.</p>
          )}
          {member.card.cut && <p className="soft">Cut here. Its session has it whole.</p>}
          <Files
            card={member.card}
            device={member.device}
            agent={session}
            completion={member.card.completion}
            id={id}
            read={read}
          />
          {onOpen && (
            <div className="actions">
              <button
                type="button"
                className="agent-open"
                onClick={() => onOpen({ device: member.device, thread: session })}
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

/** What a worker asks, in plain words: its own question where it wrote one; for leave to do something, a sentence that
 *  says what, with the exact command or input one press away and never in the way. */
export function askWords(row: Pick<QuestionRow, 'ask' | 'text'>): {
  said: string;
  exact?: string;
  options: string[];
} {
  const ask = row.ask;
  if (ask?.questions?.length)
    return {
      said: ask.questions.map((question) => question.question).join('\n'),
      options: ask.questions.length === 1 ? ask.questions[0]!.options : [],
    };
  if (ask?.kind === 'plan') return { said: 'Has a plan for you to read.', options: [] };
  if (ask?.kind === 'question' || ask?.kind === 'elicitation')
    return { said: ask.title, options: ask.options ?? [] };
  // Leave to do something: what it is for, in plain words, never the tool's own text (rule 3); that is one press away.
  const title = ask?.title ?? row.text,
    words =
      ask &&
      requestWords({ kind: ask.kind as 'command', title: ask.title, detail: ask.detail ?? null });
  return {
    said: leaveWords(ask?.kind ?? 'tool', title, ask?.detail),
    exact: words?.exact ?? [title, ask?.detail].filter(Boolean).join('\n'),
    options: [],
  };
}

/** What a worker wants leave for, as a person would say it: what kind of thing, and where on the web, never a tool's name. */
function leaveWords(kind: string, title: string, detail?: string | null): string {
  const host = /https?:\/\/([^/\s"'?#:]+)/i
    .exec(`${title}\n${detail ?? ''}`)?.[1]
    ?.replace(/^www\./, '');
  if (kind === 'command' || /^(Run |Bash\b)/.test(title)) return 'Wants your OK to run a command.';
  if (kind === 'file_change' || /^(Edit|Write|MultiEdit|NotebookEdit)\b/.test(title))
    return 'Wants your OK to change files.';
  if (host) return `Wants your OK to read ${host}.`;
  if (/^(Web)?(Fetch|Search)\b/.test(title))
    return 'Wants your OK to look something up on the web.';
  if (/^(Read|Glob|Grep)\b/.test(title)) return 'Wants your OK to read files.';
  return 'Wants your OK to go on.';
}

/** The question itself, under whoever asks it. */
function Asked({ row, answer }: { row: QuestionRow; answer?: Ways['answer'] }) {
  const [exact, setExact] = useState(false);
  // What was pressed, for this request only: a new question from the same worker starts with every choice open.
  const asked = `${row.seq}:${row.request ?? ''}`;
  const [chosen, setChosen] = useState<{ asked: string; choice: string; failed?: boolean }>();
  const chose = chosen?.asked === asked && !chosen.failed ? chosen.choice : '';
  const words = askWords(row);
  const press = (choice: string) => {
    setChosen({ asked, choice });
    // Pressed is not sent: if it did not go, it says so and the choices open again.
    void Promise.resolve()
      .then(() => answer!(row, choice))
      .catch(() => false)
      .then((sent) => {
        if (!sent)
          setChosen((now) =>
            now?.asked === asked && now.choice === choice ? { asked, choice, failed: true } : now,
          );
      });
  };
  return (
    <>
      <p className="one-ask-words">{words.said}</p>
      {!!words.options.length &&
        (answer && row.waiting ? (
          <p className="one-options is-choices" role="group" aria-label="Answer with">
            {words.options.map((option) => (
              <button
                type="button"
                key={option}
                className="one-option"
                aria-pressed={chose === option}
                disabled={!!chose}
                onClick={() => press(option)}
              >
                {option}
              </button>
            ))}
          </p>
        ) : (
          <p className="one-options">{words.options.join(' · ')}</p>
        ))}
      {chosen?.asked === asked && chosen.failed && (
        <p className="soft one-unsent" role="status">
          That answer did not go. Press it again.
        </p>
      )}
      {words.exact && (
        <button
          type="button"
          className="agent-rest"
          aria-expanded={exact}
          onClick={() => setExact(!exact)}
        >
          {exact ? 'hide request' : 'show request'}
        </button>
      )}
      {words.exact && exact && <pre className="one-exact">{words.exact}</pre>}
    </>
  );
}

/** A question, where it was asked. While it waits, "asks you" is in the one accent; answered, the answer stands under it. */
function Question({ row, onOpen }: { row: QuestionRow } & Ways) {
  const session = row.who.id;
  return (
    <section
      className={`agent-msg one-ask${row.waiting ? ' is-waiting' : ''}`}
      data-agent={row.who.provider}
      data-seq={row.seq}
    >
      <div className="agent-line">
        <button
          type="button"
          className="agent-by"
          disabled={!onOpen}
          onClick={() => onOpen?.({ device: row.device, thread: session })}
        >
          {mark(row.who)}
          <span className="agent-name">
            {nameOf(row.who, row.who.kind === 'manager' ? 'The manager' : 'A worker')}
          </span>
          <span className="agent-end one-asks">
            {row.waiting && <StateMark state="waiting" />}
            {row.waiting ? 'asks you' : 'asked'}
          </span>
          {age(row.at)}
        </button>
      </div>
      <Asked row={row} />
      {row.answers.map((answer) => (
        <p key={answer.seq} className="one-answer">
          You answered
          {/^(allowed|denied)$/i.test(answer.text)
            ? `: ${answer.text.toLowerCase()}`
            : /^answered$/i.test(answer.text)
              ? ''
              : `: ${answer.text}`}
        </p>
      ))}
      <Notes notes={row.notes} />
    </section>
  );
}

/** A worker starting: one quiet line. While it works and nothing else says so, its newest step follows. */
function Started({ row, onOpen, shownNow }: { row: StartedRow; shownNow: boolean } & Ways) {
  const step = row.live && !shownNow ? row.steps.at(-1)?.text : undefined;
  return (
    <p className="one-line one-started" data-agent={row.who.provider} data-seq={row.seq}>
      {mark(row.who, 14)}
      <button
        type="button"
        className="one-name"
        disabled={!onOpen}
        onClick={() => onOpen?.({ device: row.device, thread: row.who.id })}
      >
        {nameOf(row.who)}
      </button>
      <span className="one-word">started</span>
      {step && <span className="one-step">{step}</span>}
      {age(row.at)}
    </p>
  );
}

function Stop({ row }: { row: StopRow }) {
  return (
    <p className="one-line one-stop" data-seq={row.seq}>
      <svg className="one-stop-mark" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" fill="currentColor" />
      </svg>
      <span className="one-word">{row.text || 'Stopped'}</span>
      {age(row.at)}
    </p>
  );
}

/** No reader: a turn shows what the stream carried, and says it cannot be read for more. */
const unread: EntrySource = { result: () => Promise.reject(new Error('unread')) };

/** The rows of the thread, oldest first, drawn as a project's main thread draws its own: the same words, the same
 *  folded steps, the same worker and job entries (`threadEntries` turns rows into those entries). `turns`: Merv's own
 *  tool calls, each turn's under its words; `active`: the turn under way, whose steps are still moving. */
export function ThreadRows({
  thread,
  turns,
  active,
  onOpen,
  read,
  now,
}: {
  thread: OneThread;
  turns?: MervTurn[];
  active?: string;
  onOpen?(target: ThreadOpen): void;
  read?: ReadReport;
  now?: number;
}) {
  const ways: Ways = { onOpen, read };
  const live = new Set(thread.now.map((line) => line.id));
  const entries = useMemo(() => threadEntries(thread, turns), [thread, turns]);
  // Each Mac's turns are read from that Mac.
  const sources = useMemo(() => new Map<string, EntrySource>(), [read]);
  // What the stream carried of each turn, by its completion: shown when its Mac cannot be read.
  const carried = useMemo(
    () =>
      new Map(
        thread.rows.flatMap((row) =>
          row.type === 'done' && row.card.completion
            ? [[row.card.completion, { ...row.card, outcome: row.outcome }] as const]
            : row.type === 'job'
              ? row.members.flatMap((member) =>
                  member.card.completion
                    ? [
                        [
                          member.card.completion,
                          { ...member.card, outcome: member.outcome },
                        ] as const,
                      ]
                    : [],
                )
              : [],
        ),
      ),
    [thread],
  );
  const known = useRef(carried);
  known.current = carried;
  const sourceOf = (device?: string) => {
    if (!read) return unread;
    if (!sources.has(device ?? ''))
      sources.set(
        device ?? '',
        farSource(read, device, (completion) => known.current.get(completion)),
      );
    return sources.get(device ?? '')!;
  };
  const opener = (device?: string) => (target: PaneTarget) => {
    if (target.kind === 'thread' && target.id) onOpen?.({ device, thread: target.id });
  };
  const one = (row: Extract<ThreadEntry, { type: 'one' }>['row']): ReactNode => {
    switch (row.type) {
      case 'day':
        return (
          <p key={row.key} className="one-day">
            {dayWords(row.at, now)}
          </p>
        );
      case 'project':
        return (
          <p key={row.key} className="one-project">
            {row.project}
          </p>
        );
      case 'started':
        return <Started key={row.key} row={row} shownNow={live.has(row.who.id)} {...ways} />;
      case 'question':
        return <Question key={row.key} row={row} {...ways} />;
      case 'stop':
        return <Stop key={row.key} row={row} />;
      case 'note':
        return (
          <p
            key={row.key}
            className={`one-line one-note is-alone${row.matters ? ' is-news' : ''}`}
            data-seq={row.seq}
          >
            <span className="one-note-by">manager</span>
            {row.text}
          </p>
        );
      case 'answer':
        return (
          <p key={row.key} className="one-line one-answer" data-seq={row.seq}>
            You answered{/^answered$/i.test(row.text) ? '' : `: ${row.text.toLowerCase()}`}
          </p>
        );
    }
  };
  const draw = (entry: ThreadEntry): ReactNode => {
    switch (entry.type) {
      case 'user':
        return <UserSaid key={entry.key} id={entry.key} text={entry.text} />;
      case 'assistant':
        return <AssistantSaid key={entry.key} id={entry.key} text={entry.text} />;
      case 'trail':
        return (
          <Trail
            key={entry.key}
            blockId={entry.key}
            steps={entry.steps}
            live={entry.key === `t:${active}`}
          />
        );
      case 'agent':
        return (
          <EntrySourceProvider key={entry.key} value={sourceOf(entry.device)}>
            <AgentEntry entry={entry} onOpen={opener(entry.device)}>
              <Notes notes={entry.notes} />
            </AgentEntry>
          </EntrySourceProvider>
        );
      case 'job':
        return (
          <EntrySourceProvider key={entry.key} value={sourceOf(entry.device)}>
            <JobEntry
              entry={entry}
              main={onOpen ? entry.view.main : undefined}
              device={entry.device}
            >
              <Notes notes={entry.notes} />
            </JobEntry>
          </EntrySourceProvider>
        );
      case 'one':
        return one(entry.row);
    }
  };
  return <>{entries.map(draw)}</>;
}

/** A worker's steps as lines, oldest first, the newest in the running colour. */
function Steps({
  steps,
}: {
  steps: { key: string; kind?: string; title: string; done?: boolean; failed?: boolean }[];
}) {
  return (
    <div className="agent-activity" aria-label="What it is doing now">
      {steps.map((step, at) => (
        <p
          key={step.key}
          className={`agent-step${!step.done && at === steps.length - 1 ? ' is-active' : ''}${step.failed ? ' is-failed' : ''}`}
        >
          <ToolGlyph kind={toolKind(step.kind ?? '', step.title)} />
          <span className="agent-step-title">{step.title}</span>
        </p>
      ))}
    </div>
  );
}

/** How often an opened line of a worker at work asks its Mac again. */
const LIVE_EVERY = 5000;
const STEPS_SHOWN = 5;

/** One line of what is live, the shape of every such line in a project's main thread: a mark, the name, how it stands
 *  in quiet words, and the word for what a press shows. What one asks is in the thread where it asked; here it is a press away. */
function NowCard({ line, onOpen, read, answer }: { line: NowLine } & Ways) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<Report>();
  const asks = open && !!read && line.kind !== 'job' && !line.needs;
  useEffect(() => {
    if (!asks) return;
    let gone = false;
    const ask = () => {
      if (document.visibilityState !== 'hidden')
        void read!({ device: line.device, agent: line.id }).then(
          (next) => {
            if (!gone) setReport(next);
          },
          () => undefined,
        );
    };
    ask();
    const timer = setInterval(ask, LIVE_EVERY);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [asks, line.device, line.id]);
  const body = `one-now-${line.key}`;
  const steps = report?.activity?.length
    ? report.activity.map((step, at) => ({ key: `${step.at}:${at}`, ...step }))
    : line.steps
        .slice(-STEPS_SHOWN)
        .map((step: ThreadStep, at) => ({ key: `${step.seq}:${at}`, title: step.text }));
  // How it stands, without the word "job": its mark already says it.
  const state =
    line.kind === 'job' ? (
      line.needs ? (
        <span className="job-needs">{needsWords(line.since)}</span>
      ) : (
        line.words.replace(/^(job · )+/, '')
      )
    ) : line.needs ? (
      needsWords(line.since)
    ) : (
      'working'
    );
  const openIt =
    onOpen &&
    (() =>
      line.kind === 'job'
        ? openJobPage(line.manager, line.id, line.device)
        : onOpen({ device: line.device, thread: line.id }));
  return (
    <section
      className={`agent-card${line.kind === 'job' ? ' job-card' : ''} is-${line.needs ? 'waiting' : 'working'}${open ? ' is-open' : ''}`}
      data-agent={line.provider}
      data-now={line.id}
    >
      <div className="agent-row">
        <button
          type="button"
          className="agent-head"
          aria-expanded={open}
          aria-controls={body}
          onClick={() => setOpen(!open)}
          onKeyDown={(event) => {
            if (!event.metaKey && !event.ctrlKey && !event.altKey)
              moveLine(event, NOW_HEADS, '.agent-cards');
          }}
        >
          {line.kind === 'job' ? (
            <JobMark />
          ) : line.provider ? (
            <ProviderMark provider={line.provider} size={16} />
          ) : (
            <span className="one-dot" aria-hidden="true" />
          )}
          <span className="agent-name">
            {line.kind === 'reviewer' && <span className="agent-role">reviewing </span>}
            {askTitle(line.title) || (line.kind === 'job' ? 'Job' : 'A worker')}
          </span>
          <span className="agent-state">
            {line.needs ? (
              <StateMark state="waiting" />
            ) : (
              !line.stale && <StateMark state="running" />
            )}
            {state}
            {line.stale && ' · Mac away'}
          </span>
        </button>
        {openIt && (
          <button type="button" className="agent-link" onClick={openIt}>
            {line.kind === 'job' ? 'open job' : 'open session'}
          </button>
        )}
      </div>
      {open && (
        <div className={`agent-body${line.kind === 'job' ? ' job-body' : ''}`} id={body}>
          {/* Keyed by the question: a new request is a new choice, never one already pressed. */}
          {line.needs &&
            (line.question ? (
              <div className="one-now-ask">
                <Asked
                  key={line.question.request ?? line.question.seq}
                  row={line.question}
                  answer={answer}
                />
              </div>
            ) : (
              line.kind !== 'job' && <p className="soft">It waits for your answer.</p>
            ))}
          {line.needs && (
            <p className="soft">
              {answer && line.question && askWords(line.question).options.length
                ? 'Press one, or tell Merv your answer.'
                : 'Tell Merv your answer.'}
            </p>
          )}
          {line.kind === 'job' ? (
            line.members.length ? (
              line.members.map((member) => (
                <Member key={member.seq} member={member} onOpen={onOpen} read={read} />
              ))
            ) : (
              <p className="soft">Nobody has finished a turn in it yet.</p>
            )
          ) : (
            !line.needs && (
              <>
                {report?.said && (
                  <div className="said assistant">
                    <Prose text={report.said} />
                  </div>
                )}
                {steps.length ? (
                  <Steps steps={steps} />
                ) : (
                  <p className="soft">Nothing to show of it yet.</p>
                )}
              </>
            )
          )}
        </div>
      )}
    </section>
  );
}

/** What is live across every project, over the reply box: the word "Now", then one line each. With nothing live there is nothing here.
 *  `fold` (a phone, or a chat sharing the screen with the board): the lines wait behind "N running" under them, the
 *  person's to open and close. */
export function ThreadNow({
  thread,
  onOpen,
  read,
  answer,
  fold = false,
}: { thread: OneThread; fold?: boolean } & Ways) {
  const running = useRunningFold(
    fold,
    thread.now.length,
    thread.now.some((line) => line.needs),
  );
  // A Mac whose link closed moments ago says nothing: it is nearly always back within the minute.
  if (!thread.now.length) return null;
  const many = thread.projects.length > 1;
  return (
    <>
      <div className="thread-now">
        <div
          className="agent-cards"
          aria-label="What is live across your projects"
          {...running.region}
        >
          <NowRows>
            {thread.now.map((line, at, shown) => {
              const first = at === 0,
                changed = many && (first || shown[at - 1]!.project !== line.project);
              return (
                <Fragment key={line.key}>
                  {(first || changed) && (
                    <p className="agent-now">
                      {first && 'Now'}
                      {first && changed && ' · '}
                      {changed && <span className="one-now-project">{line.project}</span>}
                    </p>
                  )}
                  <NowCard line={line} onOpen={onOpen} read={read} answer={answer} />
                </Fragment>
              );
            })}
          </NowRows>
        </div>
      </div>
      {running.button}
    </>
  );
}
