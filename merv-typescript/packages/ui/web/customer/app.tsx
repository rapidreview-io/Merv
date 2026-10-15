import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import type { createClient } from '@supabase/supabase-js';
import { Icon } from '../icons';
import { Records } from '../navigation';
import { Speak, Transcript } from '../views/pi';
import { Floating } from '../views/pi-dock';
import { useVoice, type Voice } from '../views/pi-voice';
import { useConversation, type Conversation } from '../views/pi-conversation';
import { customerRequest, requestOf } from './api';
import { FileManager, UploadTray, type Listing } from './files';
import { PlanEditor, type Plan } from './plan';
import { Start, takePending } from './start';
import { useCustomerSession, type CustomerSession, type SessionControls } from './session';
import { customerTransport } from './transport';
import { formatBytes, fromDrop, Uploader } from './uploads';

type View = 'arrive' | 'chat' | 'plan' | 'files';

/**
 * The customer experiments page (service_experiment@3), served at /customer-experiments/r/<id>.
 * This browser is signed in silently (session.ts); the person arrives at a drop zone over the
 * chat with Merv's intake agent, which scrolls into a full-screen chat; the plan they and the
 * agent write and the request's files are a header button away. No project's records are known
 * here.
 */
export function CustomerApp({ client }: { client?: typeof createClient } = {}) {
  const [request, setRequest] = useState(() => requestOf());
  // /start is the page before its request: it becomes that request's page once made.
  const starting = !request && /^\/start\/?$/.test(location.pathname);
  const [session, controls] = useCustomerSession(request, { createClient: client });
  return (
    <Records.Provider value={false}>
      <MemoryRouter>
        {starting ? (
          <div className="cx-page">
            <Header />
            <Start opened={setRequest} />
          </div>
        ) : session.phase === 'ready' ? (
          <Experiment />
        ) : (
          <div className="cx-page">
            <Header />
            <Gate session={session} controls={controls} />
          </div>
        )}
      </MemoryRouter>
    </Records.Provider>
  );
}

function Header({ children, home }: { children?: ReactNode; home?(): void }) {
  return (
    <header className="cx-head">
      {home ? (
        <button type="button" className="cx-brand" onClick={home}>
          Merv <span className="cx-brand-bar">|</span> Experiment
        </button>
      ) : (
        <span className="cx-brand">
          Merv <span className="cx-brand-bar">|</span> Experiment
        </span>
      )}
      {children && <nav className="cx-nav">{children}</nav>}
    </header>
  );
}

/** Before the page is the customer's: loading, a link that does not work, or a request another
 * browser holds. */
function Gate({ session, controls }: { session: CustomerSession; controls: SessionControls }) {
  if (session.phase === 'loading')
    return (
      <p className="cx-center muted" role="status">
        Loading…
      </p>
    );
  if (session.phase === 'invalid')
    return (
      <p className="cx-center" role="alert">
        {session.message}
      </p>
    );
  if (session.phase === 'failed')
    return (
      <div className="cx-center cx-elsewhere">
        <p role="alert">{session.message}</p>
        <button type="button" className="btn btn--primary" onClick={controls.retry}>
          Retry
        </button>
      </div>
    );
  if (session.phase !== 'elsewhere') return null;
  return (
    <div className="cx-center cx-elsewhere">
      <p>
        This experiment is open in another browser. Opening it here signs that browser out of it.
      </p>
      <button
        type="button"
        className="btn btn--primary"
        disabled={session.busy}
        onClick={() => void controls.takeOver()}
      >
        Open here instead
      </button>
      {session.error && (
        <p className="pi-error" role="alert">
          {session.error}
        </p>
      )}
    </div>
  );
}

/** One of the request's reads, polled every `every` ms while the tab is shown. */
function usePoll<T>(path: string, every: number) {
  const [data, setData] = useState<T | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let stopped = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout>;
    // One loop only: a read already in flight schedules the next one itself.
    const read = async (first = false) => {
      if (reading) return;
      reading = true;
      if (first || document.visibilityState !== 'hidden')
        await customerRequest<T>(path).then(
          (next) => !stopped && setData(next),
          () => {},
        );
      reading = false;
      if (!stopped) timer = setTimeout(() => void read(), every);
    };
    // A tab shown again reads at once rather than at its next turn.
    const shown = () => {
      if (document.visibilityState === 'hidden' || reading) return;
      clearTimeout(timer);
      void read();
    };
    document.addEventListener('visibilitychange', shown);
    // The first read happens even in a background tab, so the page is ready when shown.
    void read(true);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [path, every, version]);
  return [data, useCallback(() => setVersion((value) => value + 1), [])] as const;
}

/** The view, kept in the tab's history so Back returns to the one before. */
function useView(): [View, (next: View) => void] {
  const [view, setView] = useState<View>(() => {
    const kept = (history.state as { cx?: View } | null)?.cx;
    return kept ?? 'arrive';
  });
  useEffect(() => {
    const back = (event: PopStateEvent) =>
      setView((event.state as { cx?: View } | null)?.cx ?? 'arrive');
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  const go = useCallback((next: View) => {
    setView((now) => {
      if (now !== next) history.pushState({ cx: next }, '', location.pathname + location.search);
      return next;
    });
  }, []);
  return [view, go];
}

function Experiment() {
  const transport = useMemo(customerTransport, []);
  const pi = useConversation(transport);
  const voice = useVoice(pi);
  const [hidden, setHidden] = useState(false);
  const [view, navigate] = useView();
  const go = (next: View) => {
    setHidden(false);
    navigate(next);
  };
  const [plan, reloadPlan] = usePoll<Plan>('/plan', view === 'plan' ? 4000 : 10_000);
  const [files, reloadFiles] = usePoll<Listing>('/files?prefix=', 15_000);
  const [request] = usePoll<{ state?: string }>('', 15_000);
  const uploader = useMemo(() => new Uploader({ onDone: reloadFiles }), [reloadFiles]);
  // Files dropped on /start before the request existed go up now, in the files view.
  useEffect(() => {
    const dropped = takePending();
    if (dropped.length) {
      uploader.add(dropped, '');
      go('files');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploader]);
  // Files hold still while the agent verifies a submitted plan, and once one is accepted.
  const frozen = !!plan && plan.status !== 'drafting' && plan.status !== 'changes_requested';
  const planned = !!plan?.document.trim();
  // The chat is drawn in one place at a time, so the transcript and composer refs are its own.
  const nav = view !== 'arrive' && (
    <>
      <button
        type="button"
        className="cx-nav-button"
        aria-current={view === 'files' ? 'page' : undefined}
        onClick={() => go('files')}
      >
        Files
      </button>
      <button
        type="button"
        className="cx-nav-button"
        aria-current={view === 'plan' ? 'page' : undefined}
        onClick={() => go('plan')}
      >
        Plan
        {planned && <span className="cx-dot" aria-label="Plan ready" />}
      </button>
    </>
  );
  const home = () => go(view === 'chat' ? 'arrive' : 'chat');
  // The chat floats over the plan and the files; wide pages keep their content clear of it.
  const floating = (view === 'plan' || view === 'files') && !(hidden && voice.state === 'off');
  return (
    <div className={`cx-page cx-page--${view}${floating ? ' cx-page--docked' : ''}`}>
      <Header home={view === 'arrive' ? undefined : home}>{nav}</Header>
      {view === 'arrive' && (
        <Arrive
          voice={voice}
          pi={pi}
          size={files?.totalBytes ?? null}
          frozen={frozen}
          open={() => go('files')}
          drop={(entries) => {
            uploader.add(entries, '');
            go('files');
          }}
          expand={() => go('chat')}
        />
      )}
      {view === 'chat' && <Chat pi={pi} voice={voice} />}
      {view === 'plan' && (
        <div className="cx-plan-layout">
          <PlanEditor
            plan={plan}
            state={request?.state ?? null}
            agentBusy={pi.active}
            reload={() => {
              reloadPlan();
            }}
          />
        </div>
      )}
      {view === 'files' && <FileManager uploader={uploader} frozen={frozen} />}
      {(view === 'plan' || view === 'files' || (voice.compact && voice.state !== 'off')) &&
        (hidden && voice.state === 'off' ? (
          <button className="btn cx-chat-reopen" onClick={() => setHidden(false)}>
            Chat
          </button>
        ) : (
          <Floating pi={pi} voice={voice} expand={() => go('chat')} hide={() => setHidden(true)} />
        ))}
      <UploadTray uploader={uploader} />
    </div>
  );
}

/** The reused Pi transcript and composer, and how the conversation stands when it cannot. */
function Chat({ pi, voice }: { pi: Conversation; voice: Voice }) {
  if (voice.compact && voice.state !== 'off') return null;
  return (
    <section className="cx-chat" aria-labelledby="cx-chat-title">
      <h2 className="cx-chat-title" id="cx-chat-title">
        Chat
      </h2>
      {pi.listed ? (
        <Transcript pi={pi} />
      ) : (
        !pi.error && (
          <p className="muted" role="status">
            Loading…
          </p>
        )
      )}
      {pi.error && (
        <p className="pi-error" role="alert">
          {pi.error}
        </p>
      )}
      {pi.streamError && (
        <p className="muted" role="status">
          {pi.streamError}
        </p>
      )}
      {pi.unavailable && (
        <button className="btn" type="button" onClick={pi.retryStream}>
          Retry connection
        </button>
      )}
      {!pi.listed && pi.error && (
        <button className="btn" type="button" onClick={pi.retryList}>
          Retry
        </button>
      )}
      {pi.listed && <Speak pi={pi} voice={voice} rows={3} />}
    </section>
  );
}

/**
 * Where the person arrives: a drop zone that opens the files, with the request's size, and the
 * chat beneath it. Scrolling down from here makes the chat the whole page.
 */
function Arrive({
  pi,
  voice,
  size,
  frozen,
  open,
  drop,
  expand,
}: {
  pi: Conversation;
  voice: Voice;
  size: number | null;
  frozen: boolean;
  open(): void;
  drop(entries: { file: File; path: string }[]): void;
  expand(): void;
}) {
  const [over, setOver] = useState(false);
  const touch = useRef<number | null>(null);
  return (
    <div
      className="cx-arrive"
      onWheel={(event) => {
        if (event.deltaY > 0) expand();
      }}
      onTouchStart={(event) => (touch.current = event.touches[0]?.clientY ?? null)}
      onTouchMove={(event) => {
        const from = touch.current;
        const at = event.touches[0]?.clientY;
        if (from !== null && at !== undefined && from - at > 40) {
          touch.current = null;
          expand();
        }
      }}
    >
      <button
        type="button"
        className={`cx-drop${over ? ' cx-drop--over' : ''}`}
        onClick={open}
        onDragOver={(event) => {
          if (frozen) return;
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          if (frozen) return;
          event.preventDefault();
          setOver(false);
          void fromDrop(event.dataTransfer).then(drop);
        }}
      >
        <span className="cx-drop-title">Chug anything</span>
        <Icon name="upload" size={20} className="cx-drop-icon" />
        <span className="cx-drop-kinds">datasets, papers, content files</span>
        {size !== null && <span className="cx-chip cx-drop-size mono">{formatBytes(size)}</span>}
      </button>
      <Chat pi={pi} voice={voice} />
    </div>
  );
}
