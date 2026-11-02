/**
 * What someone signed out sees: the board itself, with Pi drawing on it, one demo and then the next
 * and round again. It looks like the app because it is the app's board, played. Reaching for it in
 * any way slides in the way to sign in, and the drawing goes on behind.
 */
import '@excalidraw/excalidraw/index.css';
import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { Excalidraw, MainMenu } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { DEMOS } from '@merv/board-app/demos';
import { Icon } from '../icons';
import { GoogleButton } from '../session';
import { BoardReplay } from '../views/board-replay';
import { useSharedBoard } from '../views/board-shared';

(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/ui/assets/excalidraw/';
/** How long a finished demo stands before the next. */
const HOLD_MS = 6_000;
const noop = () => {};
const free = () => true;
const settle = async () => {};
const editor: ComponentProps<typeof Excalidraw> = {
  theme: 'dark',
  aiEnabled: false,
  validateEmbeddable: false,
  UIOptions: { canvasActions: { loadScene: false, export: false, saveToActiveFile: false } },
  children: <MainMenu />,
};

/** How long a demo may take to begin once asked, before the board is simply shown. */
const STARTS_MS = 12_000;
/** What went wrong in someone's browser, for the server's log: a page has no other way to say. */
const report = (what: unknown) => {
  const text = String((what as Error)?.stack ?? what).slice(0, 600);
  void fetch(`/board-report?m=${encodeURIComponent(text)}`, { credentials: 'omit' }).catch(
    () => undefined,
  );
};
/** A replay that falls over leaves the board and the page standing. */
class Standing extends Component<{ failed(error: unknown): void; children: ReactNode }> {
  state = { gone: false };
  static getDerivedStateFromError = () => ({ gone: true });
  componentDidCatch(error: unknown) {
    this.props.failed(error);
  }
  render() {
    return this.state.gone ? null : this.props.children;
  }
}

/** A person's words come a letter at a time, as fast as they type; the agent answers a moment after. */
const LETTER_MS = 70;
const ANSWER_MS = 700;
/** How far apart a demo's steps are, before the pen's own time. */
const STEP_MS = 800;
type Playing = { pause(): void; play(): void };
/** What is being said, a line at a time. While the person speaks the pen waits for them. */
function useSpoken() {
  const [spoken, setSpoken] = useState({ person: '', agent: '' });
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const say = useCallback((person: string, agent: string, done: () => void) => {
    clearTimeout(timer.current);
    const type = (count: number) => {
      setSpoken({ person: person.slice(0, count), agent: '' });
      timer.current =
        count < person.length
          ? setTimeout(() => type(count + 1), LETTER_MS)
          : setTimeout(() => {
              setSpoken({ person, agent });
              done();
            }, ANSWER_MS);
    };
    type(1);
  }, []);
  const speak = useCallback(
    (line: string, playing: Playing) => {
      const [person, agent] = line.includes('\n') ? line.split('\n') : ['', line];
      if (!person) {
        clearTimeout(timer.current);
        return setSpoken((now) => ({ person: now.person, agent: agent! }));
      }
      playing.pause();
      say(person, agent!, () => playing.play());
    },
    [say],
  );
  return { spoken, say, speak };
}

/** One demo: the person asks, and only then does the board begin; it says when it is done. */
function Demo({ token, ask, done }: { token: string; ask: string; done(): void }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const { scene, history } = useSharedBoard(token, api);
  const held = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(held.current), []);
  const [over, setOver] = useState(false);
  const [asked, setAsked] = useState(false);
  const { spoken, say, speak } = useSpoken();
  // A demo was drawn all at once by the server: its waits are no one thinking, so they go.
  const closed = useCallback(
    async (after?: number) => {
      const page = await history(after);
      return {
        ...page,
        changes: page.changes.map((change, index) => ({
          ...change,
          at: new Date(index * STEP_MS).toISOString(),
        })),
      };
    },
    [history],
  );
  useEffect(() => say(ask, '', () => setAsked(true)), [ask, say]);
  // Whatever stops a demo, the finished board stands for a moment and the next one comes.
  const fail = useCallback(
    (why: unknown) => {
      report(why);
      setOver(true);
      clearTimeout(held.current);
      held.current = setTimeout(done, HOLD_MS);
    },
    [done],
  );
  useEffect(() => {
    if (!asked) return;
    const late = setTimeout(() => {
      if (!document.querySelector('.board-landing [role="slider"]')) fail('demo did not start');
    }, STARTS_MS);
    return () => clearTimeout(late);
  }, [asked, fail]);
  return (
    <div className={`board-landing-demo${over ? ' is-over' : ''}`}>
      <Excalidraw {...editor} excalidrawAPI={setApi} />
      {api && scene && asked && (
        <Standing failed={fail}>
          <BoardReplay
            demo
            speak={speak}
            id={token}
            live={api}
            editor={editor}
            free={free}
            settle={settle}
            revision={() => scene.revision}
            mode={(playing) => {
              if (playing) return noop();
              setOver(true);
              clearTimeout(held.current);
              held.current = setTimeout(done, HOLD_MS);
            }}
            readHistory={closed}
          />
        </Standing>
      )}
      <div className="board-landing-spoken" aria-live="polite">
        {spoken.person && <p className="is-person">{spoken.person}</p>}
        {spoken.agent && <p>{spoken.agent}</p>}
      </div>
    </div>
  );
}

export function Landing({ google }: { google: ReactNode }) {
  const [tokens, setTokens] = useState<string[]>([]);
  const [at, setAt] = useState(0);
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    void fetch('/board-demos', { credentials: 'omit' })
      .then((response) => response.json())
      .then((given: { tokens: string[] }) => setTokens(given.tokens))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const failed = (event: ErrorEvent | PromiseRejectionEvent) =>
      report('reason' in event ? event.reason : (event.error ?? event.message));
    addEventListener('error', failed);
    addEventListener('unhandledrejection', failed);
    return () => {
      removeEventListener('error', failed);
      removeEventListener('unhandledrejection', failed);
    };
  }, []);
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return setAsking(false);
      if (event.key !== 'Tab' && !event.metaKey && !event.ctrlKey) setAsking(true);
    };
    // Whatever is reached for, the slider aside, it is first of all heard here.
    const touch = (event: Event) => {
      if (!(event.target as Element).closest('.board-landing-slider')) setAsking(true);
    };
    addEventListener('keydown', press, true);
    addEventListener('pointerdown', touch, true);
    addEventListener('wheel', touch, { capture: true, passive: true });
    return () => {
      removeEventListener('keydown', press, true);
      removeEventListener('pointerdown', touch, true);
      removeEventListener('wheel', touch, true);
    };
  }, []);
  return (
    <div className="board-page board-landing">
      <div className="board-main">
        <div className="board-canvas">
          {tokens[at] && (
            <Demo
              key={at}
              token={tokens[at]!}
              ask={DEMOS[at]!.ask}
              done={() => setAt((now) => (now + 1) % tokens.length)}
            />
          )}
          <div className="board-bar" aria-hidden="true">
            <span className="board-orb board-orb--live" />
            <span className="btn-icon">
              <Icon name="chat" size={16} />
            </span>
          </div>
          {/* Everything on the board is reached through this, and nothing behind it is. */}
          <div className="board-landing-catch" onDragOver={() => setAsking(true)} />
        </div>
      </div>
      <aside
        className={`board-landing-slider${asking ? ' is-in' : ''}`}
        aria-hidden={!asking}
        aria-label="Sign in"
      >
        <button
          type="button"
          className="btn-icon board-landing-close"
          aria-label="Close"
          title="Close"
          tabIndex={asking ? 0 : -1}
          onClick={() => setAsking(false)}
        >
          <Icon name="close" />
        </button>
        <span className="board-landing-pi" aria-hidden="true" />
        <h1>Hi, it’s Merv, let’s get to work.</h1>
        {google ?? <GoogleButton disabled />}
        <button
          type="button"
          className="btn-text board-landing-later"
          tabIndex={asking ? 0 : -1}
          onClick={() => setAsking(false)}
        >
          Keep watching
        </button>
      </aside>
    </div>
  );
}
