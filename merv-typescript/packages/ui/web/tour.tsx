import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { safely } from './api';
import { cx } from './components';

/**
 * The first-run tour: one short card per place in the rail, its row lit through the dimmed
 * page. It opens once per person on this browser and again from Settings › Session. A step
 * whose row this project does not register is left out, and the tour opens no page: Pi rents
 * a machine when it opens.
 */
const STEPS = [
  { at: ['project'], title: 'Project switcher', line: 'Hop between your projects here.' },
  { at: ['home'], title: 'Home', line: 'Everything about your project, at a glance.' },
  { at: ['work'], title: 'Work', line: 'Your tasks and experiments.' },
  {
    at: ['pi'],
    title: 'Pi',
    line: 'The built-in agent that runs the whole show. Try voice, it’s good.',
  },
  { at: ['boards'], title: 'Board', line: 'A whiteboard you and your agent draw on, yours or Pi.' },
  {
    at: ['sandboxes'],
    title: 'Compute',
    line: 'GPU boxes on offer, and what your agents are renting.',
  },
  {
    at: ['code', 'artifacts'],
    title: 'Git and Files',
    line: 'Every commit and file your agents ship.',
  },
  { at: ['discord'], title: 'Discord', line: 'Come say hi.' },
  { at: ['settings'], title: 'Settings', line: 'Replay this tour anytime.' },
];

const REPLAY = 'merv:tour';
/** Opens the tour again, from wherever the person asks for it. */
export const startTour = () => window.dispatchEvent(new Event(REPLAY));

const targets = (at: string[]) =>
  at.flatMap((key) => [...document.querySelectorAll(`[data-tour="${key}"]`)]);
/** Where each target stands on screen, with room for the ring; a hidden one is not lit. */
const holes = (at: string[]) =>
  targets(at)
    .map((el) => el.getBoundingClientRect())
    .filter((box) => box.width > 0 && box.height > 0)
    .map((box) => ({ x: box.left - 4, y: box.top - 4, w: box.width + 8, h: box.height + 8 }));

export function Tour({ who }: { who: string }) {
  const seen = `merv:tour-seen:${who}`;
  const [at, setAt] = useState<'welcome' | number | null>(() =>
    safely(() => localStorage.getItem(seen), null) ? null : 'welcome',
  );
  const [, redraw] = useState(0);
  const primary = useRef<HTMLButtonElement>(null);
  const title = useId();
  const steps = STEPS.filter((step) => targets(step.at).length > 0);
  const close = () => {
    safely(() => localStorage.setItem(seen, new Date().toISOString()));
    setAt(null);
  };
  // Finishing marks the tour seen, as skipping does.
  const next = () =>
    at === 'welcome'
      ? setAt(0)
      : typeof at === 'number' && at + 1 < steps.length
        ? setAt(at + 1)
        : close();
  const back = () => typeof at === 'number' && at > 0 && setAt(at - 1);
  useEffect(() => {
    const replay = () => setAt(0);
    window.addEventListener(REPLAY, replay);
    return () => window.removeEventListener(REPLAY, replay);
  }, []);
  useEffect(() => {
    if (at === null) return;
    primary.current?.focus();
    const again = () => redraw((n) => n + 1);
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') next();
      else if (event.key === 'ArrowLeft') back();
      else if (event.key === 'Escape') close();
    };
    window.addEventListener('resize', again);
    window.addEventListener('scroll', again, true);
    window.addEventListener('keydown', keys);
    return () => {
      window.removeEventListener('resize', again);
      window.removeEventListener('scroll', again, true);
      window.removeEventListener('keydown', keys);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);
  if (at === null) return null;
  const index = typeof at === 'number' ? at : -1;
  const step = steps[index];
  const lit = step ? holes(step.at) : [];
  const [width, height] = [window.innerWidth, window.innerHeight];
  const first = lit[0];
  // Beside the first lit row, never off the screen; with nothing lit, in the middle.
  const place: CSSProperties | undefined = first && {
    left: first.x + first.w + 14,
    top: Math.min(Math.max(12, first.y + first.h / 2 - 60), height - 180),
  };
  const last = index === steps.length - 1;
  return (
    <div className="tour">
      <svg className="tour-scrim" width={width} height={height} aria-hidden="true">
        <defs>
          <mask id="tour-holes">
            <rect width={width} height={height} fill="white" />
            {lit.map((box, i) => (
              <rect key={i} x={box.x} y={box.y} width={box.w} height={box.h} rx={10} />
            ))}
          </mask>
        </defs>
        <rect className="tour-veil" width={width} height={height} mask="url(#tour-holes)" />
        {lit.map((box, i) => (
          <rect
            key={i}
            className="tour-ring"
            x={box.x}
            y={box.y}
            width={box.w}
            height={box.h}
            rx={10}
          />
        ))}
      </svg>
      <section
        role="dialog"
        aria-labelledby={title}
        className={cx('tour-card', !place && 'tour-card--center')}
        style={place}
      >
        <h2 id={title}>{step ? step.title : 'Welcome to Merv'}</h2>
        <p>{step ? step.line : 'Quick tour?'}</p>
        <div className="tour-foot">
          {step && (
            <span className="tour-count">
              {index + 1} of {steps.length}
            </span>
          )}
          {index > 0 ? (
            <button type="button" className="btn btn--quiet" onClick={back}>
              Back
            </button>
          ) : (
            <button type="button" className="btn btn--quiet" onClick={close}>
              Skip
            </button>
          )}
          <button type="button" className="btn btn--primary" ref={primary} onClick={next}>
            {step ? (last ? 'Done' : 'Next') : 'Let’s go'}
          </button>
        </div>
      </section>
    </div>
  );
}
