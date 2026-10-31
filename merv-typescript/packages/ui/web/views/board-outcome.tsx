/**
 * The outcome beside a board (founder, 2026-10-31): the flexible screen on the right, where a person
 * and their agent write what the brainstorm led to, and hand it on. The agent opens it by writing:
 * the canvas's poll reports each outcome's revision, and one that moved comes up unless the person
 * is typing in the pane or turned away from that one. The text saves itself as they pause; a send
 * freezes it as a file. Narrower than both fit, styles.css makes the pane the page, the canvas
 * waiting mounted under it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Outcome, OutcomeLine, OutcomeSent } from '@merv/board/models';
import { type ApiError, call, readOnly } from '../api';
import { Ago, useSidebarEscape } from '../components';
import { Icon } from '../icons';
import { Markdown } from '../markdown';
import { useSession, writes } from '../session';
import { useRoomy } from '../theme';
import { useAgent } from './pi';
import {
  caretAfter,
  deepLink,
  handoffInline,
  handoffPrompt,
  hunkOf,
  rebased,
} from './board-outcome-text';

const SAVE_MS = 600;
const NOT_OPENED_MS = 8000;
const SAID_MS = 3000;
const newest = (lines: OutcomeLine[]) =>
  [...lines].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);

/** The pane's place on the board's page: which outcome is up, and what the poll says of them all. */
export function useOutcomes(board: string, first: OutcomeLine[] | undefined) {
  const [params, setParams] = useSearchParams();
  const shown = params.get('outcome');
  const [polled, setPolled] = useState<OutcomeLine[]>();
  const lines = polled ?? first ?? [];
  const [full, setFull] = useState(false);
  const place = useRef(setParams);
  place.current = setParams;
  const show = (id: string | null, replace: boolean) =>
    place.current(
      (now) => {
        const next = new URLSearchParams(now);
        if (id) next.set('outcome', id);
        else next.delete('outcome');
        return next;
      },
      { replace },
    );
  const seen = useRef<Map<string, number>>();
  /** What the person turned away from, which then moves without pulling them back. */
  const shut = useRef(new Set<string>());
  const report = useCallback((now: OutcomeLine[]) => {
    setPolled((held) => (JSON.stringify(held) === JSON.stringify(now) ? held : now));
    const was = seen.current;
    seen.current = new Map(now.map((line) => [line.id, line.revision]));
    if (!was || document.activeElement?.closest('.board-outcome')) return;
    const moved = newest(
      now.filter((line) => was.get(line.id) !== line.revision && !shut.current.has(line.id)),
    );
    if (moved && moved.id !== new URLSearchParams(location.search).get('outcome'))
      show(moved.id, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pushed = useRef(false);
  const open = (id: string) => {
    if (shown) shut.current.add(shown);
    shut.current.delete(id);
    pushed.current = !shown;
    show(id, !!shown);
  };
  const close = () => {
    if (shown) shut.current.add(shown);
    setFull(false);
    if (pushed.current) history.back();
    else show(null, true);
    pushed.current = false;
  };
  // The word on the title line: the newest outcome, or a blank one.
  const toggle = async () => {
    if (shown) return close();
    const last = newest(lines);
    if (last) return open(last.id);
    const made = await call<{ outcome: OutcomeLine }>('board.write:outcome', {
      board,
      title: 'Untitled',
    });
    open(made.outcome.id);
  };
  // Escape restores a maximized pane and shuts one beside the board, but is the canvas's in the canvas.
  useSidebarEscape(!!shown, () => {
    if (full) setFull(false);
    else if (!document.activeElement?.closest('.board-canvas')) close();
  });
  return { lines, shown, full, setFull, report, open, close, toggle };
}
type Place = ReturnType<typeof useOutcomes>;

/** The word that opens the pane, lit with how many there are. */
export function OutcomeWord({ place }: { place: Place }) {
  const count = place.lines.length;
  if (!count && readOnly()) return null;
  return (
    <button
      type="button"
      className={`btn-text board-outcome-word${count ? ' is-lit' : ''}`}
      aria-pressed={!!place.shown}
      onClick={() => void place.toggle().catch(() => undefined)}
    >
      Outcome{count > 1 ? ` ${count}` : ''}
    </button>
  );
}

const copying = async (text: Promise<string>) => {
  // Safari takes the clipboard only in the press itself, so the text is promised to it there.
  if (typeof ClipboardItem === 'undefined') return navigator.clipboard.writeText(await text);
  const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
  await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
};
const version = (line: OutcomeLine) => `${line.revision}/${line.sent.at(-1)?.at}`;

export function OutcomePane({ board, place }: { board: string; place: Place }) {
  const id = place.shown!;
  const line = place.lines.find((one) => one.id === id);
  const { actor, project } = useSession();
  const agent = useAgent();
  const roomy = useRoomy();
  const member = !readOnly();
  const keeps = writes(actor) && member;

  const [record, setRecord] = useState<Outcome | null>(null);
  const saved = useRef<Outcome | null>(null);
  const [draft, setDraft] = useState('');
  /** What the person sees now, since timers outlive the render that set them. */
  const text = useRef('');
  const [title, setTitle] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState('');
  const [note, setNote] = useState('');
  const noteTimer = useRef<ReturnType<typeof setTimeout>>();
  /** A word in the head, for a moment; then it says how the outcome stands again. */
  const say = (words: string, ms = SAID_MS) => {
    clearTimeout(noteTimer.current);
    setNote(words);
    noteTimer.current = setTimeout(() => setNote(''), ms);
  };
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  /** Where the caret goes once the text it stood in has changed under it. */
  const caret = useRef<{ start: number; end: number; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  /** One write or read at a time, in order, so a reply is never read against the wrong base. */
  const queue = useRef(Promise.resolve());
  const enqueue = (work: () => Promise<void>) => {
    queue.current = queue.current
      .then(work)
      .catch((error: Error) => setProblem(`Not saved: ${error.message}`));
    return queue.current;
  };

  const show = (next: string) => {
    const box = area.current;
    if (box && document.activeElement === box)
      caret.current = {
        start: caretAfter(box.value, next, box.selectionStart),
        end: caretAfter(box.value, next, box.selectionEnd),
        top: box.scrollTop,
      };
    text.current = next;
    setDraft(next);
  };
  useLayoutEffect(() => {
    if (!caret.current || !area.current) return;
    area.current.setSelectionRange(caret.current.start, caret.current.end);
    area.current.scrollTop = caret.current.top;
    caret.current = null;
  }, [draft]);

  /** Takes up what Board holds, carrying over what was typed against `base`. */
  const reread = async (base = saved.current?.text ?? '') => {
    const { outcome } = await call<{ outcome: Outcome }>('board.read:outcome', {
      board,
      outcome: id,
    });
    saved.current = outcome;
    setRecord(outcome);
    const next = rebased(base, text.current, outcome.text);
    if (next !== text.current) show(next);
    if (next !== outcome.text) later();
  };
  const once = async () => {
    const was = saved.current;
    const sent = text.current;
    if (!was || was.text === sent) return;
    const hunk = hunkOf(was.text, sent);
    const change = hunk ? { edits: [hunk] } : { content: sent, expectedRevision: was.revision };
    try {
      await call('board.write:outcome', { board, outcome: id, ...change });
      // Held now, so that a read failing next does not leave this hunk to be sent again.
      saved.current = { ...was, text: sent };
      setProblem('');
      await reread(sent);
    } catch (error) {
      const { code, status } = error as ApiError;
      const conflict = code === 'board_outcome_conflict';
      // With no answer it may be in: what Board holds decides, as a conflict does.
      if (saved.current === was && (conflict || !status || code.startsWith('http_')))
        await reread(was.text);
      if (!conflict) throw error;
    }
  };
  const push = () => {
    clearTimeout(timer.current);
    return enqueue(once);
  };
  const later = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void push(), SAVE_MS);
  };

  useEffect(() => {
    void enqueue(() => reread(''));
    const flush = () => document.visibilityState === 'hidden' && void push();
    document.addEventListener('visibilitychange', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      clearTimeout(noteTimer.current);
      void push();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // What the poll says moved (the agent's next paragraph, a colleague's send) is read at once.
  const standing = line && version(line);
  useEffect(() => {
    if (standing && saved.current && standing !== version(saved.current)) void enqueue(reread);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standing]);

  const rename = () => {
    const name = title?.trim();
    setTitle(null);
    if (!name || name === saved.current?.title) return;
    void enqueue(async () => {
      await call('board.write:outcome', { board, outcome: id, title: name });
      await reread();
    });
  };

  const handoff = () => ({
    projectId: project.id,
    boardId: board,
    title: saved.current!.title,
    origin: location.origin,
  });
  /** Every word typed goes first, and the file comes from exactly what Board then holds. */
  const freeze = async () => {
    await push();
    const now = saved.current!;
    if (text.current !== now.text) throw new Error('what you typed is not saved yet');
    if (!keeps) return null;
    // Asked of Artifacts each time, never taken from what a send noted: this is what they see.
    const file = await call<{ id: string }>('artifact.write:create', {
      title: now.title,
      content: now.text,
      mediaType: 'text/markdown',
      requestId: `${now.id}:${now.revision}`,
    });
    return { artifactId: file.id, revision: now.revision };
  };
  type Frozen = { artifactId: string; revision: number };
  const mark = async (how: OutcomeSent['how'], frozen: Frozen) => {
    await call('board.outcome.sent', { board, outcome: id, how, ...frozen });
    await enqueue(reread);
  };
  const act = async (work: () => Promise<void>) => {
    setSending(true);
    setProblem('');
    await work().catch((error: Error) => setProblem(`Not sent: ${error.message}`));
    setSending(false);
  };
  const open = () =>
    act(async () => {
      const frozen = (await freeze())!;
      await mark('claude', frozen);
      location.href = deepLink(handoffPrompt(handoff(), frozen.artifactId));
      say('Not opened? Copy prompt', NOT_OPENED_MS);
    });
  const copy = () =>
    act(async () => {
      const frozen = freeze();
      await copying(
        frozen.then((file) =>
          file
            ? handoffPrompt(handoff(), file.artifactId)
            : handoffInline(handoff(), saved.current!.text),
        ),
      );
      const file = await frozen;
      if (file) await mark('copy', file);
      say('Copied');
    });
  /** What Pi is to be told once its conversation stands: the same sentence the person could say. */
  const [asking, setAsking] = useState<Frozen | null>(null);
  const fleet = () =>
    act(async () => {
      setAsking(await freeze());
      agent?.start();
    });
  const pi = agent?.pi;
  const listed = !!pi?.listed;
  useEffect(() => {
    if (!asking || !pi || !listed) return;
    setAsking(null);
    const words = `Create a task from outcome ${id} on board ${board}: derive its checks from the document and name the frozen file ${asking.artifactId} in its goal, to read first.`;
    void pi.send(words).then(async (said) => {
      if (!said) return setProblem('Not sent: the Agent is busy or unavailable. Try again then.');
      await mark('fleet', asking).catch(() => undefined);
      say('Asked the Agent');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asking, listed]);

  const beginEdit = (at?: number) => {
    if (!member) return;
    setEditing(true);
    requestAnimationFrame(() => {
      // In this order the browser brings the caret into view.
      if (at !== undefined) area.current?.setSelectionRange(at, at);
      area.current?.focus();
    });
  };
  /** The place in the source of what was pressed in the rendered text, as near as it can be told. */
  const pressedAt = (x: number, y: number) => {
    const range = document.caretRangeFromPoint?.(x, y);
    const words = range?.startContainer.nodeType === 3 ? range.startContainer.textContent : null;
    const at = words ? text.current.indexOf(words) : -1;
    return at < 0 ? text.current.length : at + range!.startOffset;
  };

  const sent = record?.sent.at(-1);
  const blocked = !draft.trim() || sending;
  return (
    // data-draft: Escape is the pane's while it stands, not the way out of the board.
    <aside className="board-outcome" aria-label="Outcome" data-draft>
      <header className="board-outcome-head">
        <div className="board-outcome-line">
          <button type="button" className="btn-text board-outcome-back" onClick={place.close}>
            ← Board
          </button>
          <input
            className="board-outcome-title"
            aria-label="Outcome title"
            maxLength={200}
            disabled={!member}
            value={title ?? record?.title ?? line?.title ?? ''}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={rename}
            onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
          />
          <span className="running-ends board-outcome-ends">
            <button
              type="button"
              className="btn-icon"
              aria-label={place.full ? 'Restore' : 'Maximize'}
              title={place.full ? 'Restore' : 'Maximize'}
              onClick={() => place.setFull(!place.full)}
            >
              <Icon name={place.full ? 'restore' : 'expand'} />
            </button>
            <button
              type="button"
              className="btn-icon"
              aria-label="Close"
              title="Close"
              onClick={place.close}
            >
              <Icon name="close" />
            </button>
          </span>
        </div>
        <div className="board-outcome-acts">
          {keeps && roomy && (
            <button type="button" className="btn" disabled={blocked} onClick={() => void open()}>
              Open in Claude Code
            </button>
          )}
          <button
            type="button"
            className={keeps && roomy ? 'btn-text' : 'btn'}
            disabled={blocked}
            onClick={() => void copy()}
          >
            Copy prompt
          </button>
          {keeps && (
            <button
              type="button"
              className="btn-text"
              disabled={blocked}
              onClick={() => void fleet()}
            >
              Send to Fleet
            </button>
          )}
          <span className="board-outcome-said muted" role="status">
            {note ||
              (sent && (
                <>
                  Sent · <Ago at={sent.at} />
                  {sent.revision !== record!.revision && ', changed since'}
                </>
              ))}
          </span>
        </div>
        {place.lines.length > 1 && (
          <div className="tabs tabs--strip board-outcome-tabs">
            {place.lines.map((one) => (
              <button
                key={one.id}
                type="button"
                aria-pressed={one.id === id}
                onClick={() => place.open(one.id)}
              >
                {one.title}
              </button>
            ))}
          </div>
        )}
      </header>
      {problem && (
        <p className="pi-error board-outcome-problem" role="alert">
          {problem}
        </p>
      )}
      <textarea
        ref={area}
        className="board-outcome-body board-outcome-text"
        aria-label="Outcome text"
        hidden={!editing}
        value={draft}
        onChange={(event) => {
          text.current = event.target.value;
          setDraft(event.target.value);
          later();
        }}
        onBlur={() => {
          setEditing(false);
          void push();
        }}
        onKeyDown={(event) => event.key === 'Escape' && event.currentTarget.blur()}
      />
      {!editing && (
        <div
          className="board-outcome-body board-outcome-read"
          tabIndex={member ? 0 : undefined}
          onClick={(event) => {
            if (!(event.target as Element).closest('a') && !getSelection()?.toString())
              beginEdit(pressedAt(event.clientX, event.clientY));
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.target !== event.currentTarget) return;
            event.preventDefault();
            beginEdit();
          }}
        >
          {draft.trim() ? (
            <Markdown source={draft} />
          ) : (
            <p className="muted">Write here, or ask the Agent to draft it from the board.</p>
          )}
        </div>
      )}
    </aside>
  );
}
