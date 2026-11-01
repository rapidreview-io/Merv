/**
 * The outcome beside a board (founder, 2026-10-31): the flexible screen on the right, where a person
 * and their agent write what the brainstorm led to, and hand it on. The agent opens it by writing:
 * the canvas's poll reports each outcome's revision, and one that moved comes up unless the person
 * is typing in the pane or turned away from that one. It is one surface, read as it is written
 * (board-outcome-editor). The text saves itself as they pause, and says so only when it cannot; a
 * send freezes it as a file. Narrower than both fit, styles.css makes the pane the page, the canvas
 * waiting mounted under it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import type { Outcome, OutcomeLine, OutcomeSent } from '@merv/board/models';
import { type ApiError, call, readOnly, safely } from '../api';
import { useMoreMenu, useSidebarEscape } from '../components';
import { Icon } from '../icons';
import { pathOf, useRows } from '../navigation';
import { useSession, writes } from '../session';
import { useRoomy } from '../theme';
import { useAgent, useSay } from './pi';
import { speech } from '../speech';
import { pointPassage } from './board-pointing';
import { SendControl, WorkLine, type Way } from './board-outcome-send';
import type { HandReport } from './board-outcome-hand';
import type { OutcomeEditor } from './board-outcome-editor';
import {
  deepLink,
  draftAsk,
  handoffInline,
  handoffPrompt,
  hunkOf,
  openingTitle,
  rebased,
} from './board-outcome-text';

const SAVE_MS = 600;
const KEEP_MS = 300;
const NOT_OPENED_MS = 8000;
const SAID_MS = 3000;
/** The longest a failed save waits before it tries again. */
const MOST_RETRY_MS = 15_000;
/** How long after the fact a text that has just come counts as being written. */
const JUST_WRITTEN_MS = 10_000;
/** What a blank outcome is called until someone names it. */
const UNTITLED = 'Untitled';
const loadEditor = () => import('./board-outcome-editor');
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
    // The editor is worth having at hand as soon as there is something for it to open.
    if (now.length) void loadEditor();
    if (!was || document.activeElement?.closest('.board-outcome')) return;
    const moved = newest(
      now.filter((line) => was.get(line.id) !== line.revision && !shut.current.has(line.id)),
    );
    if (moved && moved.id !== new URLSearchParams(location.search).get('outcome'))
      show(moved.id, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pushed = useRef(false);
  /** Whether the pane has just come up, rather than gone over to another outcome. */
  const up = useRef(false);
  const arriving = !up.current;
  useEffect(() => {
    up.current = !!shown;
  }, [shown]);
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
  const fresh = async () => {
    const made = await call<{ outcome: OutcomeLine }>('board.write:outcome', {
      board,
      title: UNTITLED,
    });
    open(made.outcome.id);
  };
  // The word on the title line: the newest outcome, or a blank one.
  const toggle = async () => {
    if (shown) return close();
    const last = newest(lines);
    return last ? open(last.id) : fresh();
  };
  /** Struck from the list at once: the word that opens the pane must not go to it before the poll. */
  const gone = (id: string) =>
    setPolled((held) => (held ?? first ?? []).filter((line) => line.id !== id));
  /** Gone, and the pane goes on to the next one there is. */
  const dropped = (id: string) => {
    gone(id);
    const next = newest(lines.filter((line) => line.id !== id));
    shut.current.add(id);
    if (next) show(next.id, true);
    else close();
  };
  // Escape restores a maximized pane and shuts one beside the board, but is the canvas's in the canvas.
  useSidebarEscape(!!shown, () => {
    if (full) setFull(false);
    else if (!document.activeElement?.closest('.board-canvas')) close();
  });
  return {
    lines,
    shown,
    full,
    setFull,
    report,
    open,
    close,
    toggle,
    fresh,
    gone,
    dropped,
    arriving,
  };
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
const version = (line: OutcomeLine) =>
  `${line.revision}/${line.sent.at(-1)?.at}/${line.sent.filter((one) => one.taskId).length}`;
type Frozen = { artifactId: string; revision: number };

/** What a tab holds of a text it has not yet saved, so that nothing typed dies with the tab. */
const keptAt = (actor: string, board: string, id: string) =>
  `merv:outcome-unsaved:${actor}:${board}:${id}`;
const keep = (key: string, base: string, text: string) =>
  safely(() => localStorage.setItem(key, JSON.stringify({ base, text })));
const forget = (key: string) => safely(() => localStorage.removeItem(key));
const kept = (key: string): { base: string; text: string } | null =>
  safely(() => JSON.parse(localStorage.getItem(key) ?? 'null'), null);

/** The drag that makes the pane wider or narrower, kept for this browser. */
const WIDTH = 'merv:outcome-width';
function Grip({ pane }: { pane: React.RefObject<HTMLElement> }) {
  const plane = () => pane.current?.closest<HTMLElement>('.board-plane');
  useLayoutEffect(() => {
    const width = safely(() => localStorage.getItem(WIDTH), null);
    if (width) plane()?.style.setProperty('--outcome-width', width);
  }, []);
  const place = (x: number) => {
    const box = plane()?.getBoundingClientRect();
    if (!box) return;
    const width = `${Math.round(Math.min(box.width - 360, Math.max(360, box.right - x)))}px`;
    plane()!.style.setProperty('--outcome-width', width);
    safely(() => localStorage.setItem(WIDTH, width));
  };
  return (
    <div
      className="board-outcome-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Pane width"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) place(event.clientX);
      }}
      onDoubleClick={() => {
        plane()?.style.removeProperty('--outcome-width');
        safely(() => localStorage.removeItem(WIDTH));
      }}
    />
  );
}

export function OutcomePane({ board, place }: { board: string; place: Place }) {
  const id = place.shown!;
  const line = place.lines.find((one) => one.id === id);
  const { actor, project } = useSession();
  const agent = useAgent();
  const roomy = useRoomy();
  const member = !readOnly();
  const keeps = writes(actor) && member;
  const rows = useRows();
  const pane = useRef<HTMLElement>(null);
  const home = useRef<HTMLDivElement>(null);
  const [lead, setLead] = useState<HTMLElement | null>(null);

  const [record, setRecord] = useState<Outcome | null>(null);
  const saved = useRef<Outcome | null>(null);
  const editor = useRef<OutcomeEditor | null>(null);
  /** What the person sees now, kept for the moment after the editor has gone. */
  const left = useRef('');
  const now = () => editor.current?.text() ?? left.current;
  const [hasText, setHasText] = useState(false);
  const [titled, setTitled] = useState(false);
  const titledNow = useRef(false);
  titledNow.current = titled;
  const [title, setTitle] = useState<string | null>(null);
  const titleBox = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState('');
  const [hand, setHand] = useState<HandReport | null>(null);
  const [note, setNote] = useState<'copied' | 'open' | ''>('');
  const noteTimer = useRef<ReturnType<typeof setTimeout>>();
  /** A word on the document's top line, for a moment. */
  const say = (words: typeof note, ms = SAID_MS) => {
    clearTimeout(noteTimer.current);
    setNote(words);
    noteTimer.current = setTimeout(() => setNote(''), ms);
  };
  const [sending, setSending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const keeping = useRef<ReturnType<typeof setTimeout>>();
  const retry = useRef({
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    wait: 1000,
  });
  /** One write or read at a time, in order, so a reply is never read against the wrong base. */
  const queue = useRef(Promise.resolve());
  const alive = useRef(true);
  const enqueue = (work: () => Promise<void>) => {
    queue.current = queue.current.then(work).catch((error: ApiError) => {
      if (error.code === 'not_found')
        return setProblem('This outcome was deleted elsewhere. What is here is no longer kept.');
      // A read that failed with nothing unsaved says nothing; the next one will do.
      if (saved.current?.text === now()) return;
      // Still in the editor and kept in this browser, and trying again by itself.
      setProblem(`Not saved: ${error.message}`);
      clearTimeout(retry.current.timer);
      if (!alive.current) return;
      retry.current.timer = setTimeout(() => void push(), retry.current.wait);
      retry.current.wait = Math.min(MOST_RETRY_MS, retry.current.wait * 2);
    });
    return queue.current;
  };

  /** What the person typed goes first; only then does what came read against it. */
  const take = (next: string, by: string | null) => {
    if (next === now()) return;
    if (editor.current) editor.current.land(next, by);
    else left.current = next;
    setHasText(!!next.trim());
    setTitled(!!openingTitle(next));
  };
  /** Who it was that wrote this, by what Board says; nobody to be seen when it was this person. */
  const writerOf = (outcome: Outcome) =>
    outcome.writer ?? (outcome.updatedBy === actor.id ? null : 'Someone');

  /** Takes up what Board holds, carrying over what was typed against `base`. */
  const reread = async (base = saved.current?.text ?? '') => {
    const { outcome } = await call<{ outcome: Outcome }>('board.read:outcome', {
      board,
      outcome: id,
    });
    await editor.current?.settled();
    const mine = now();
    const next = rebased(base, mine, outcome.text);
    // Taken up first: were it to fail, the next save must not read the difference as the person's.
    take(next, outcome.text !== base ? writerOf(outcome) : null);
    saved.current = outcome;
    setRecord(outcome);
    if (next !== outcome.text) later();
  };
  const settledSave = () => {
    forget(keptAt(actor.id, board, id));
    retry.current.wait = 1000;
    setProblem((was) => (was.startsWith('Not saved') ? '' : was));
  };
  const once = async () => {
    const was = saved.current;
    const sent = now();
    if (!was || was.text === sent) {
      if (was) settledSave();
      return;
    }
    // A word still being composed goes with the rest of the word.
    if (editor.current?.composing()) return later();
    const hunk = hunkOf(was.text, sent);
    const change = hunk ? { edits: [hunk] } : { content: sent, expectedRevision: was.revision };
    // The document's own title is its name, once the person has changed it.
    const heading = openingTitle(sent);
    const renamed = heading && heading !== openingTitle(was.text) && heading !== was.title;
    try {
      await call('board.write:outcome', {
        board,
        outcome: id,
        ...change,
        ...(renamed && { title: heading.slice(0, 200) }),
      });
      // Held now, so that a read failing next does not leave this hunk to be sent again.
      saved.current = { ...was, text: sent };
      await reread(sent);
      if (saved.current?.text === now()) settledSave();
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
  const stash = () => {
    if (saved.current && saved.current.text !== now())
      keep(keptAt(actor.id, board, id), saved.current.text, now());
  };
  const typed = () => {
    setHasText(!!editor.current?.written());
    // In a moment, not on every key: a long text is a long write.
    keeping.current ??= setTimeout(() => {
      keeping.current = undefined;
      stash();
    }, KEEP_MS);
    later();
  };

  // The editor, once its code and the text have both come; what a closed tab left goes in first.
  useEffect(() => {
    let live = true;
    const opening = Promise.all([loadEditor(), reread('')]);
    void opening
      .then(([{ outcomeEditor }]) => {
        if (!live || !home.current) return;
        const { text, updatedAt } = saved.current!;
        // A text that has only just come is seen being written, as what comes after it will be.
        const by =
          Date.now() - Date.parse(updatedAt) < JUST_WRITTEN_MS ? writerOf(saved.current!) : null;
        const made = outcomeEditor(home.current, by ? '' : text, member, {
          typed,
          titled: setTitled,
          left: () => {
            if (!titledNow.current) titleBox.current?.focus();
          },
          hand: setHand,
          ...(member && agent && roomy && { ask: () => agent.ask() }),
        });
        editor.current = made;
        if (by) made.land(text, by);
        const holder = document.createElement('div');
        holder.className = 'board-outcome-lead';
        const scroller = home.current.querySelector('.cm-scroller')!;
        scroller.prepend(holder);
        scroller.addEventListener(
          'scroll',
          () => pane.current?.toggleAttribute('data-scrolled', scroller.scrollTop > 4),
          { passive: true },
        );
        setLead(holder);
        const unsaved = kept(keptAt(actor.id, board, id));
        if (unsaved && unsaved.text !== text) {
          take(rebased(unsaved.base, unsaved.text, text), null);
          later();
        } else if (unsaved) forget(keptAt(actor.id, board, id));
      })
      .catch((error: Error) => setProblem(`Not opened: ${error.message}`));
    const flush = () => {
      if (document.visibilityState === 'hidden') {
        stash();
        void push();
      }
    };
    document.addEventListener('visibilitychange', flush);
    return () => {
      live = false;
      alive.current = false;
      clearTimeout(keeping.current);
      stash();
      document.removeEventListener('visibilitychange', flush);
      clearTimeout(noteTimer.current);
      clearTimeout(retry.current.timer);
      left.current = now();
      editor.current?.destroy();
      editor.current = null;
      pointPassage(undefined);
      const was = saved.current;
      // A blank nobody named or wrote in was never anything; it goes with the pane.
      if (
        member &&
        was &&
        !left.current.trim() &&
        !was.text &&
        !was.sent.length &&
        was.title === UNTITLED &&
        !askedDraft.current
      )
        // At the revision read: a word from anyone since, and it stays.
        void call('board.outcome.delete', {
          board,
          outcome: id,
          expectedRevision: was.revision,
        }).then(
          () => place.gone(id),
          () => undefined,
        );
      else void push();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // What the poll says moved (the agent's next paragraph, a colleague's send) is read at once.
  const standing = line && version(line);
  useEffect(() => {
    if (standing && saved.current && standing !== version(saved.current)) void enqueue(reread);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standing]);

  // What is selected goes with what the person says to Pi, as a selection on the board does.
  useEffect(() => {
    pointPassage({
      note() {
        const passage = editor.current?.selected();
        return `outcome ${id}${passage ? ` chars ${passage.from}-${passage.to}` : ''}`;
      },
      said: () => editor.current?.release(),
    });
    return () => pointPassage(undefined);
  }, [id]);

  // The Agent's window stands beside the pane, where what it writes can be seen.
  useEffect(() => {
    const box = pane.current;
    if (!box) return;
    const root = document.documentElement.style;
    const main = box.closest('.board-plane')?.querySelector('.board-main');
    const watch = new ResizeObserver(() => {
      const beside = !!main && (main as HTMLElement).offsetWidth > 0;
      // With the gutter either side of the sheet.
      root.setProperty('--outcome-pane', beside ? `${box.offsetWidth + 16}px` : '0px');
    });
    watch.observe(box);
    return () => {
      watch.disconnect();
      root.removeProperty('--outcome-pane');
    };
  }, [place.full]);

  // A blank page is for writing on, from its title if it has none.
  useEffect(() => {
    if (!lead || !member || now().trim()) return;
    if (saved.current?.title === UNTITLED) titleBox.current?.focus();
    else editor.current?.focus('start');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead]);

  const rename = () => {
    const name = title?.trim();
    setTitle(null);
    if (!name || name === saved.current?.title) return;
    void enqueue(async () => {
      try {
        await call('board.write:outcome', { board, outcome: id, title: name });
        await reread();
      } catch (error) {
        setTitle(name);
        setProblem(`Not renamed: ${(error as Error).message}`);
      }
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
    const held = saved.current!;
    if (now() !== held.text) throw new Error('what you typed is not saved yet');
    if (!keeps || speech.boardOnly) return null;
    // Asked of Artifacts each time, never taken from what a send noted: this is what they see.
    const file = await call<{ id: string }>('artifact.write:create', {
      title: held.title,
      content: held.text,
      mediaType: 'text/markdown',
      requestId: `${held.id}:${held.revision}`,
    });
    return { artifactId: file.id, revision: held.revision };
  };
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
      say('open', NOT_OPENED_MS);
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
      say('copied');
    });
  const spoken = useSay();
  const asking = !!spoken?.asking;
  const askedDraft = useRef(false);
  const [refused, setRefused] = useState(false);
  /** Pi is told, once its conversation stands; refused, the pane says so. */
  const ask = (words: string) =>
    void spoken?.say(words).then((said) => {
      if (said) return;
      askedDraft.current = false;
      setRefused(true);
      setProblem('Not sent: Pi is busy or unavailable. Try again then.');
    });
  const fleet = () =>
    act(async () => {
      const frozen = await freeze();
      if (!frozen) return;
      setRefused(false);
      // Noted first: the task may come at any moment after the ask, and it finds its send by this.
      await mark('fleet', frozen);
      ask(
        `Create a task from outcome ${id} on board ${board}: derive its checks from the document and name the frozen file ${frozen.artifactId} in its goal, to read first.`,
      );
    });
  const draft = (kind: string) => {
    askedDraft.current = true;
    ask(draftAsk(kind));
  };
  const pi = agent?.pi;
  // A sign of life: from the press that asks for a draft to the end of the turn that writes it.
  const busy = !!pi?.active;
  useEffect(() => {
    if (askedDraft.current && !busy && !asking && !sending) askedDraft.current = false;
    const working = (askedDraft.current || asking) && (busy || asking);
    editor.current?.working(working ? 'Pi' : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, asking, lead]);

  const remove = async () => {
    setDeleting(false);
    const expectedRevision = saved.current!.revision;
    await call('board.outcome.delete', { board, outcome: id, expectedRevision }).then(
      () => {
        forget(keptAt(actor.id, board, id));
        place.dropped(id);
      },
      (error: Error) => setProblem(`Not deleted: ${error.message}`),
    );
  };

  const arrived = useRef(place.arriving);
  const more = useMoreMenu();
  const SENDS: Record<Way, () => Promise<void>> = { fleet, claude: open, copy };
  const ways: Way[] =
    keeps && !speech.boardOnly
      ? [...(agent ? (['fleet'] as const) : []), ...(roomy ? (['claude'] as const) : []), 'copy']
      : ['copy'];
  const sent = record?.sent ?? [];
  const showsTitle = !titled;
  const named = title ?? (record?.title === UNTITLED ? '' : (record?.title ?? line?.title ?? ''));
  const files = pathOf(rows, 'artifacts');
  const offerDraft = member && agent && !hasText && !hand;
  return (
    // data-draft: Escape is the pane's while it stands, not the way out of the board.
    <aside
      className="board-outcome"
      aria-label="Outcome"
      data-draft
      data-arriving={arrived.current ? '' : undefined}
      ref={pane}
    >
      {!place.full && <Grip pane={pane} />}
      <header className="board-outcome-head">
        <button type="button" className="btn-text board-outcome-back" onClick={place.close}>
          ← Board
        </button>
        <div className="tabs tabs--strip board-outcome-tabs">
          {place.lines.length > 1 &&
            place.lines.map((one) => (
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
        <span className="running-ends board-outcome-ends">
          {hasText && (
            <SendControl
              ways={ways}
              quiet={sent.at(-1)?.revision === record?.revision}
              busy={sending}
              said={note === 'copied' ? 'Copied' : undefined}
              go={(way) => void SENDS[way]()}
            />
          )}
          {member &&
            more.menu(
              <>
                {more.item('New outcome', () => {
                  more.close();
                  void place.fresh().catch((error: Error) => setProblem(error.message));
                })}
                {more.item('Delete', () => {
                  more.close();
                  setDeleting(true);
                })}
              </>,
            )}
          <button
            type="button"
            className="btn-icon board-outcome-size"
            aria-label={place.full ? 'Restore' : 'Maximize'}
            title={place.full ? 'Restore' : 'Maximize'}
            onClick={() => place.setFull(!place.full)}
          >
            <Icon name={place.full ? 'restore' : 'expand'} />
          </button>
          <button
            type="button"
            className="btn-icon board-outcome-size"
            aria-label="Close"
            title="Close"
            onClick={place.close}
          >
            <Icon name="close" />
          </button>
        </span>
      </header>
      {problem && (
        <p className="pi-error board-outcome-problem" role="alert">
          {problem}
          {problem.startsWith('Not saved') && (
            <>
              <br />
              Your text is safe in this browser, and it keeps trying.{' '}
              <button type="button" className="btn-text" onClick={() => void push()}>
                Try now
              </button>
            </>
          )}
        </p>
      )}
      {deleting && (
        <p className="board-outcome-problem board-outcome-ask" role="alert">
          Delete this outcome? Files already sent stay in Files.{' '}
          <button type="button" className="btn-text" onClick={() => void remove()}>
            Delete
          </button>{' '}
          <button type="button" className="btn-text" onClick={() => setDeleting(false)}>
            Keep
          </button>
        </p>
      )}
      <div className="board-outcome-doc" ref={home} />
      {lead &&
        createPortal(
          <>
            <WorkLine
              sent={sent}
              revision={record?.revision ?? 0}
              files={files}
              thinking={busy || asking}
              refused={refused}
              unsure={note === 'open'}
              copy={() => void copy()}
              {...(keeps && !!agent && { again: () => void fleet() })}
            />
            {showsTitle && (
              <input
                ref={titleBox}
                className="board-outcome-title"
                aria-label="Outcome title"
                placeholder={member ? UNTITLED : ''}
                maxLength={200}
                disabled={!member}
                value={named}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={rename}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    editor.current?.focus('start');
                  }
                  if (event.key === 'Escape') event.currentTarget.blur();
                }}
              />
            )}
            {offerDraft && speech.boardOnly && (
              <p className="board-outcome-start">
                {[
                  ['Plan', 'a plan'],
                  ['PRD', 'a PRD'],
                  ['Prompt', 'a prompt for another agent'],
                ].map(([word, kind]) => (
                  <button
                    key={word}
                    type="button"
                    className="btn-text"
                    onClick={() => draft(kind!)}
                  >
                    {word}
                  </button>
                ))}
              </p>
            )}
            {offerDraft && !speech.boardOnly && (
              <p className="board-outcome-start">
                What did this board lead to? Write it here
                {roomy && (
                  <>
                    , or ask Pi for{' '}
                    {[
                      ['a plan', 'a plan'],
                      ['a PRD', 'a PRD'],
                      ['an experiment', 'an experiment plan'],
                      ['a prompt', 'a prompt for another agent'],
                    ].map(([word, kind], index) => (
                      <span key={word}>
                        {index ? (index === 3 ? ' or ' : ', ') : ''}
                        <button type="button" className="btn-text" onClick={() => draft(kind!)}>
                          {word}
                        </button>
                      </span>
                    ))}{' '}
                    from it
                  </>
                )}
                .
              </p>
            )}
          </>,
          lead,
        )}
      {hand?.away && (
        <button
          type="button"
          className="board-outcome-away"
          onClick={() => editor.current?.toHand()}
        >
          {hand.name} is writing {hand.away}
        </button>
      )}
    </aside>
  );
}
