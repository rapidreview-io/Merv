/**
 * Handing an outcome on is one control, and what came of it one line at the top of the page. The
 * control remembers how this browser last sent, so the next send is a press. The line is present
 * tense and says only the newest send, or a Fleet task still open behind it; a task's own threads
 * and state say how that stands, and earlier sends are in Files.
 */
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { OutcomeSent } from '@merv/board/models';
import type { ThreadMessages } from '@merv/sessions/models';
import type { Task } from '@merv/tasks/models';
import { safely, useTool } from '../api';
import { Ago, useDismiss, useNow } from '../components';
import { Icon } from '../icons';
import { elapsed } from '../liveness';
import { routeOf, type Reference } from '../markdown';
import { useRows } from '../navigation';
import { ThreadCompose, ThreadDialog, currentOf, groupOf, isLive, useThreadList } from './threads';

export type Way = OutcomeSent['how'];
const WAYS: Record<Way, { act: string; name: string; hint: string }> = {
  fleet: { act: 'Send to Fleet', name: 'Fleet', hint: 'A Merv agent takes it' },
  claude: { act: 'Open in Claude Code', name: 'Claude Code', hint: 'Opens on this computer' },
  copy: { act: 'Copy prompt', name: 'Copy prompt', hint: 'To paste anywhere' },
};
const LAST_WAY = 'merv:outcome-send';
/** How long Pi has to make the task before the line stops saying it is being taken up. */
const NO_TASK_MS = 180_000;

/**
 * `quiet`: what stands has been sent, so sending again asks which way, and asks little attention.
 * A press in the menu is still the press the clipboard needs, so `go` copies straight away.
 */
export function SendControl(props: {
  ways: Way[];
  quiet: boolean;
  busy: boolean;
  said?: string;
  go(way: Way): void;
}) {
  const { ways, quiet, busy, said, go } = props;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, box, () => setOpen(false), true);
  const [last, setLast] = useState(() => safely(() => localStorage.getItem(LAST_WAY), null));
  const send = (way: Way) => {
    setOpen(false);
    setLast(way);
    safely(() => localStorage.setItem(LAST_WAY, way));
    go(way);
  };
  const one = ways.length === 1 ? ways[0] : undefined;
  const lead = one ?? (quiet ? undefined : ways.find((way) => way === last));
  return (
    <div className="board-send" ref={box} data-quiet={quiet && !one ? '' : undefined}>
      <button
        type="button"
        disabled={busy}
        aria-haspopup={lead ? undefined : 'menu'}
        aria-expanded={lead ? undefined : open}
        onClick={() => (lead ? send(lead) : setOpen(!open))}
      >
        {busy ? 'Sending…' : (said ?? (lead ? WAYS[lead].act : 'Send'))}
        {!lead && <Icon name="chevron-right" />}
      </button>
      {lead && !one && (
        <button
          type="button"
          className="board-send-more"
          disabled={busy}
          aria-label="Other ways to send"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name="chevron-right" />
        </button>
      )}
      {open && (
        <div className="file-menu-panel" role="menu">
          {ways.map((way) => (
            <button
              key={way}
              type="button"
              role="menuitem"
              className="file-menu-item"
              onClick={() => send(way)}
            >
              {WAYS[way].name}
              <small>{WAYS[way].hint}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkLine(props: {
  sent: OutcomeSent[];
  revision: number;
  /** Where the frozen files open, for one who may read them. */
  files?: string;
  /** Pi is at it in this browser, however long it takes. */
  thinking: boolean;
  /** Pi would not take the ask. */
  refused: boolean;
  /** Claude Code was asked just now, and a link cannot say whether anything took it. */
  unsure: boolean;
  copy(): void;
  again?(): void;
}) {
  const { sent, revision, files, thinking, refused, unsure, copy, again } = props;
  const rows = useRows();
  const now = useNow(30_000);
  const [opened, setOpened] = useState(false);
  const [why, setWhy] = useState(false);
  const fleet = sent.filter((one) => one.how === 'fleet').at(-1);
  const taskId = fleet?.taskId;
  const task = useTool<Task>(
    taskId ? 'task.read:get' : null,
    { taskId, full: true },
    { every: 10_000 },
  ).data;
  const ended = task?.settled || task?.failed;
  const { threads, loadedAt } = useThreadList(taskId);
  const thread = threads.length ? currentOf(threads) : undefined;
  const asked = useTool<ThreadMessages>(
    thread && !ended ? `/sessions/threads/${encodeURIComponent(thread.id)}/messages` : null,
    {},
    { every: 5000 },
  ).data;
  const question = asked?.questions.find((one) => one.open);

  const newest = sent.at(-1);
  if (!newest) return null;
  const shown = fleet && (fleet === newest || (taskId && !ended)) ? fleet : newest;
  const changed = shown.revision !== revision && <i> · changed since</i>;
  const file = files && (
    <>
      {' · '}
      <Link to={`${files}/${shown.artifactId}`} target="_blank">
        File
      </Link>
    </>
  );
  if (shown.how !== 'fleet')
    return (
      <div className="board-outcome-work" role="status">
        {shown.how === 'claude' ? 'Opened in Claude Code' : 'Copied'} · <Ago at={shown.at} />
        {file}
        {shown.how === 'claude' && unsure && (
          <>
            {' · Not opened? '}
            <button type="button" onClick={copy}>
              Copy
            </button>
          </>
        )}
        {changed}
      </div>
    );

  const started = thread?.visits.map((visit) => visit.startedAt ?? visit.offeredAt).sort()[0];
  const gaveUp = refused || (!taskId && !thinking && now - Date.parse(shown.at) > NO_TASK_MS);
  const state = task?.failed
    ? 'stopped'
    : task?.settled
      ? 'done'
      : question
        ? 'asks'
        : threads.some(isLive)
          ? 'working'
          : 'waiting';
  const word =
    state === 'asks'
      ? `needs you: ${question!.question}`
      : state === 'working'
        ? `working${started ? ` · ${elapsed(now - Date.parse(started))}` : ''}`
        : state !== 'waiting'
          ? state
          : task
            ? 'waiting for a worker'
            : gaveUp
              ? 'no task came of it'
              : 'taking it up';
  return (
    <div className="board-outcome-work" role="status" data-state={state}>
      <button
        type="button"
        className="board-work-open"
        disabled={!thread}
        onClick={() => setOpened(true)}
      >
        {state === 'done' ? '✓' : state === 'stopped' ? '✕' : <span className="board-work-dot" />}
        <span>
          Fleet · <b>{word}</b>
        </span>
      </button>
      {state === 'done' && (
        <>
          {' · '}
          <Ago at={task!.workflow.updatedAt} />
          {' · '}
          <Link to={routeOf({ kind: 'task', id: taskId! } as Reference, rows) ?? '#'}>Open</Link>
        </>
      )}
      {state === 'stopped' && task?.failure && (
        <>
          {' · '}
          <button type="button" onClick={() => setWhy(!why)}>
            Why
          </button>
          {why && <p>{task.failure.reason}</p>}
        </>
      )}
      {gaveUp && again && (
        <>
          {' · '}
          <button type="button" onClick={again}>
            Send again
          </button>
        </>
      )}
      {changed}
      {question && thread && <ThreadCompose thread={thread} answering />}
      {opened && thread && (
        <ThreadDialog
          thread={thread}
          group={groupOf(threads, thread)}
          title={task?.title ?? 'Fleet'}
          loadedAt={loadedAt}
          onClose={() => setOpened(false)}
        />
      )}
    </div>
  );
}
