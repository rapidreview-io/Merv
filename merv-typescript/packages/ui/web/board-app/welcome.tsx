/**
 * Merv's first minute in a project, before anything is asked: one card over the page. It began as
 * runmerv.com's three first-run cards over a new board (profile, microphone, a first ask); Merv keeps
 * the last, made one field: what the person wants to learn, with research asks to start from.
 */
import { useEffect, useRef, useState } from 'react';
import { OrbCanvas } from '../panel/orb';

type FirstAsk = { kind: string; ask: string; icon: string };

/** What a researcher might ask first: one of each kind of work Merv does, in a person's words. */
export const RESEARCH_ASKS: FirstAsk[] = [
  {
    kind: 'Survey',
    ask: 'What is known about scaling laws for small language models?',
    icon: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.5 15.5 20 20',
  },
  {
    kind: 'Reproduce',
    ask: 'Reproduce the main result of the LoRA paper on a small model.',
    icon: 'M5 18V6M5 18h14M8 14l3-4 3 2 4-6',
  },
  {
    kind: 'Compare',
    ask: 'Compare optimizers for fine-tuning a vision transformer.',
    icon: 'M12 4v16M5 8h14M5 8l-2 6h4zM19 8l-2 6h4z',
  },
  {
    kind: 'Explain',
    ask: 'Explain how quantum error correction protects a qubit.',
    icon: 'M5 6h4v4H5zM15 6h4v4h-4zM10 14h4v4h-4zM9 8h6M12 10v4',
  },
];

/**
 * Merv's first run: one card, one field. "What do you want to learn?", with a few research asks
 * to start from; whatever is asked goes to Merv as the person's own words. Skipped, nothing is.
 */
export function LearnWelcome({
  asks = RESEARCH_ASKS,
  onDone,
}: {
  asks?: FirstAsk[];
  onDone(ask?: string): void;
}) {
  const [text, setText] = useState('');
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!navigator.maxTouchPoints)
      card.current?.querySelector<HTMLElement>('[data-first]')?.focus();
  }, []);
  const ask = () => {
    if (text.trim()) onDone(text.trim());
  };
  return (
    <div
      className="board-welcome"
      role="dialog"
      aria-modal="true"
      aria-labelledby="board-welcome-title"
    >
      <div className="board-welcome-card is-learn" ref={card}>
        <span className="board-welcome-orb" aria-hidden="true">
          <OrbCanvas kind="off" hearing muted={false} voice="merv" />
        </span>
        <h1 id="board-welcome-title">What do you want to learn?</h1>
        <p className="board-welcome-lead">
          Ask a research question. Merv reads, plans the work, runs it and shows you what it finds.
        </p>
        <form
          className="board-welcome-field"
          onSubmit={(event) => {
            event.preventDefault();
            ask();
          }}
        >
          <span className="sr-only">Your question</span>
          <input
            data-first
            value={text}
            maxLength={2000}
            aria-label="What do you want to learn?"
            placeholder="How do diffusion models turn noise into images?"
            onChange={(event) => setText(event.target.value)}
          />
        </form>
        <div className="board-welcome-asks">
          {asks.map(({ kind, ask, icon }) => (
            <button key={kind} type="button" onClick={() => onDone(ask)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d={icon}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <small>{kind}</small>
              <span>“{ask}”</span>
            </button>
          ))}
        </div>
        <footer className="board-welcome-foot">
          <button type="button" className="board-welcome-skip" onClick={() => onDone()}>
            Skip
          </button>
          <button
            type="button"
            className="board-welcome-next"
            disabled={!text.trim()}
            onClick={ask}
          >
            Ask Merv
          </button>
        </footer>
      </div>
    </div>
  );
}
