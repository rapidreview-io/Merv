/**
 * Merv's side panel: merv-desktop's chat panel, beside whatever page is open. It replaces the
 * Agent's floating window and its page of its own. One button at the top right opens it; it
 * holds Merv's one thread (thread.tsx): the Agent's conversation with its quiet step trail, the
 * project's agents, their questions answered with worded buttons, and the hand-off cards waiting
 * for the person's Approve. Opening an agent's session goes to its page on Agents.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { safely } from '../api';
import { DeskCalls } from '../panel/desk-calls';
import { Handoffs } from '../panel/handoff';
import { EntrySourceProvider, farSource } from '../panel/entry-source';
import { useAgent } from '../views/pi';
import { heldCalls, useHeld } from './held';
import { onOpenSession, sessionPath } from './open-session';
import { MervThread } from './thread';
import { readReport } from './thread-data';

/** A finished agent's card reads its report from Merv, never from a Mac. */
const mervSource = farSource(readReport);

/** Whether the panel was left open, on this browser. */
const OPEN = 'merv:panel';
const listeners = new Set<(open: boolean) => void>();
/** Anything on the page may open the panel: a hand-off waiting, a first ask. */
export const showPanel = (open = true) => listeners.forEach((hear) => hear(open));

/** Words to ask the Agent as the person's own, once its conversation is there to take them. */
let pending: string | null = null;
const asking = new Set<() => void>();
export function askMerv(words: string) {
  pending = words;
  showPanel(true);
  asking.forEach((hear) => hear());
}

export function usePanelOpen() {
  const [open, setOpen] = useState(() =>
    safely(() => localStorage.getItem(OPEN) === 'open', false),
  );
  useEffect(() => {
    const hear = (next: boolean) => setOpen(next);
    listeners.add(hear);
    return () => void listeners.delete(hear);
  }, []);
  useEffect(
    () =>
      void safely(() =>
        open ? localStorage.setItem(OPEN, 'open') : localStorage.removeItem(OPEN),
      ),
    [open],
  );
  return [open, setOpen] as const;
}

/** The thread with what waits on the person under it: drawn in the panel, and as the Agent's page. */
export function MervChat({ back }: { back(): void }) {
  const navigate = useNavigate();
  const agent = useAgent();
  const pi = agent?.pi;
  const held = useHeld();
  const calls = useMemo(() => heldCalls(async (words) => !!(await pi?.send(words))), [pi]);
  // Drawn, the thread holds the Agent's conversation: it begins, or goes on as it was left.
  const start = agent?.start;
  useEffect(() => start?.(), [start]);
  // A first ask waits for the conversation, then goes as the person's own words.
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    const hear = () => setAsked((n) => n + 1);
    asking.add(hear);
    return () => void asking.delete(hear);
  }, []);
  const ready = !!pi?.listed && !!pi.snapshot;
  useEffect(() => {
    if (!ready || !pending || !pi) return;
    const words = pending;
    pending = null;
    void pi.send(words);
  }, [ready, asked, pi]);
  useEffect(() => onOpenSession(({ thread }) => navigate(sessionPath(thread))), [navigate]);
  return (
    <DeskCalls.Provider value={calls}>
      <EntrySourceProvider value={mervSource}>
        <MervThread back={back} stage onOpen={({ thread }) => navigate(sessionPath(thread))}>
          <Handoffs held={held.map((one) => one.held)} onDone={() => undefined} />
        </MervThread>
      </EntrySourceProvider>
    </DeskCalls.Provider>
  );
}

export function MervPanel() {
  const [open, setOpen] = usePanelOpen();
  // Work handed from a board opens the panel on its card, which waits there for Approve.
  const held = useHeld().length;
  useEffect(() => {
    if (held) setOpen(true);
  }, [held, setOpen]);
  return (
    <>
      {!open && (
        <button
          type="button"
          className="web-open merv-open"
          aria-label="Chat with Merv"
          title="Chat with Merv"
          onClick={() => setOpen(true)}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-4 3v-3H4A1.5 1.5 0 0 1 2.5 13V6A1.5 1.5 0 0 1 4 4.5Z" />
          </svg>
        </button>
      )}
      <aside
        id="web-panel"
        className={`web-panel merv-panel${open ? ' is-open' : ''}`}
        aria-label="Merv"
        aria-hidden={!open}
      >
        {open && <MervChat back={() => setOpen(false)} />}
      </aside>
    </>
  );
}

/** The Agent's own page: the same thread as the panel, with the page's width. */
export function AgentPage() {
  const navigate = useNavigate();
  return (
    <div className="page-stage merv-agent-page">
      <div className="web-panel is-open is-page" aria-label="Merv">
        <MervChat back={() => navigate('/')} />
      </div>
    </div>
  );
}
