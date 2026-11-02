/**
 * What someone signed out sees: the board itself, with Pi drawing on it, one demo and then the next
 * and round again. It looks like the app because it is the app's board, played. Reaching for it in
 * any way slides in the way to sign in, and the drawing goes on behind.
 */
import '@excalidraw/excalidraw/index.css';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { Excalidraw, MainMenu } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
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

/** The person's words come as fast as they would be spoken, and the agent answers after them. */
const WORD_MS = 300;
const ANSWER_MS = 500;
/** What is being said in a demo, a line at a time: the person's words as they speak, then the agent's. */
function useSpoken() {
  const [spoken, setSpoken] = useState({ person: '', agent: '' });
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const speak = useCallback((line: string) => {
    clearTimeout(timer.current);
    const [person, agent] = line.includes('\n') ? line.split('\n') : ['', line];
    const words = person!.split(' ');
    const type = (count: number) => {
      setSpoken({ person: words.slice(0, count).join(' '), agent: '' });
      timer.current =
        count < words.length
          ? setTimeout(() => type(count + 1), WORD_MS)
          : setTimeout(() => setSpoken({ person: person!, agent: agent! }), ANSWER_MS);
    };
    if (person) type(1);
    else setSpoken({ person: '', agent: agent! });
  }, []);
  return [spoken, speak] as const;
}

/** One demo, from nothing to done, and it says when it is. */
function Demo({ token, done, title }: { token: string; done(): void; title(name: string): void }) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const { scene, history } = useSharedBoard(token, api);
  const held = useRef<ReturnType<typeof setTimeout>>();
  const named = scene?.title;
  useEffect(() => void (named && title(named)), [named, title]);
  useEffect(() => () => clearTimeout(held.current), []);
  const [over, setOver] = useState(false);
  const [spoken, speak] = useSpoken();
  return (
    <div className={`board-landing-demo${over ? ' is-over' : ''}`}>
      <Excalidraw {...editor} excalidrawAPI={setApi} />
      {api && scene && (
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
          readHistory={history}
        />
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
  const [title, setTitle] = useState('');
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    void fetch('/board-demos', { credentials: 'omit' })
      .then((response) => response.json())
      .then((given: { tokens: string[] }) => setTokens(given.tokens))
      .catch(() => undefined);
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
  const reach = () => setAsking(true);
  return (
    <div className="board-page board-landing">
      <div className="board-main">
        <header className="board-line">
          <div className="board-line-title">
            <span className="board-switch">{title}</span>
          </div>
          <span className="board-line-end">
            <button type="button" className="btn-text" onClick={reach}>
              Sign in
            </button>
          </span>
        </header>
        <div className="board-canvas">
          {tokens[at] && (
            <Demo
              key={at}
              token={tokens[at]!}
              title={setTitle}
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
          <div className="board-landing-catch" onDragOver={reach} />
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
