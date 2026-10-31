/**
 * The replay's scrubber: the board's history as a waveform along the bottom of the page, with no
 * panel around it. Ink is its height and the hand that drew it is its tone (board-timeline.ts); the
 * part already played stands full and the rest stands faint. It is drawn once to a canvas at the
 * screen's own pixels, and the playhead is a composited line moved each frame, so playing costs the
 * page no redraw of it. All it hears and says is a moment on the clock.
 */
import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import { momentAt, profileOf, toneOf, type Timeline } from './board-timeline';

/** How the part not yet played stands against the part that has. */
const UNPLAYED = 0.3;
/** How far ink is softened along the ridge, in CSS pixels, and how thick its crest is. */
const [SOFTEN, CREST] = [2.4, 1.25];
/** How often a screen reader is told where it is. */
const TELL_MS = 250;
/** Letting go this near the right end is now; the left end, the start. */
const SNAP_PX = 6;
/** The tones of hands: people in ink, agents in turn. */
const AGENT_TONES = ['--replay-agent-1', '--replay-agent-2', '--replay-agent-3'];

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const whenOf = (at: string) => {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(date, new Date())) return time;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
};
const laterOf = (ms: number) => {
  const [hours, days] = [ms / 3_600_000, ms / 86_400_000];
  if (days >= 2) return `${Math.round(days)} days later`;
  if (hours >= 2) return `${Math.round(hours)} hours later`;
  return `${Math.round(ms / 60_000)} minutes later`;
};

const shortLater = (ms: number) => {
  const [hours, days] = [ms / 3_600_000, ms / 86_400_000];
  if (days >= 1) return `${Math.round(days)}d`;
  return hours >= 1 ? `${Math.round(hours)}h` : `${Math.round(ms / 60_000)}m`;
};

export interface ScrubberControl {
  /** The playhead is at this moment on the clock. */
  place(at: number): void;
}

export function Scrubber({
  line,
  theme,
  control,
  nameOf,
  when,
  seek,
  grabbed,
  dropped,
  rising,
}: {
  line: Timeline;
  theme: string;
  control: MutableRefObject<ScrubberControl | null>;
  /** What to call a hand. */
  nameOf(hand: number): string;
  /** When a step of history happened. */
  when(step: number): string;
  seek(at: number): void;
  grabbed(): void;
  /** The hand is off; `now` when it let go at the right end. */
  dropped(now: boolean): void;
  rising: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const full = useRef<HTMLCanvasElement>(null);
  const faint = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const said = useRef<HTMLDivElement>(null);
  const placed = useRef(line.length);
  const held = useRef(false);
  const told = useRef<ReturnType<typeof setTimeout>>();

  const widthOf = () => root.current?.clientWidth ?? 0;
  const place = (at: number) => {
    placed.current = at;
    const width = widthOf();
    const share = line.length ? Math.min(1, Math.max(0, at / line.length)) : 1;
    const x = share * width;
    if (head.current) head.current.style.transform = `translate3d(${x}px,0,0)`;
    if (full.current) full.current.style.clipPath = `inset(0 ${width - x}px 0 0)`;
    // Told as it moves at a pace a screen reader can say, and always where it stopped.
    told.current ??= setTimeout(() => {
      told.current = undefined;
      const at = placed.current;
      root.current?.setAttribute(
        'aria-valuenow',
        String(Math.round((at / (line.length || 1)) * 100)),
      );
      root.current?.setAttribute('aria-valuetext', describe(at));
    }, TELL_MS);
  };
  const describe = (at: number) => {
    const { cut, before, unit } = momentAt(line, at);
    if (cut) return laterOf(cut.ms);
    if (before) return 'Before history began';
    return unit ? `${nameOf(unit.hand)} · ${when(unit.step)}` : '';
  };
  control.current = { place };

  // Drawn at the screen's own pixels, at every size and in either theme.
  useLayoutEffect(() => {
    const draw = () => {
      const [canvas, shade] = [full.current, faint.current];
      if (!canvas || !shade || !root.current) return;
      const ratio = devicePixelRatio;
      const [width, height] = [canvas.clientWidth, canvas.clientHeight];
      const [w, h] = [Math.round(width * ratio), Math.round(height * ratio)];
      for (const each of [canvas, shade]) [each.width, each.height] = [w, h];
      const pen = canvas.getContext('2d')!;
      const style = getComputedStyle(root.current);
      const inkOf = (hand: number) =>
        style.getPropertyValue(
          line.hands[hand]?.person ? '--replay-person' : AGENT_TONES[toneOf(line.hands, hand)]!,
        );
      const rule = Math.max(1, Math.round(ratio));
      const floor = h - rule;
      pen.clearRect(0, 0, w, h);
      // The ridge, rising from the floor: a stretch for each hand, its fill fading down from a crest.
      const room = h - rule - Math.round(3 * ratio);
      const count = Math.max(1, Math.round(width));
      const { heights, hands } = profileOf(line, count, SOFTEN);
      const yOf = (at: number) => floor - heights[at]! * room;
      const xAt = (at: number) => ((at + 0.5) / count) * w;
      pen.lineWidth = CREST * ratio;
      pen.lineJoin = 'round';
      for (let at = 0; at < count; at++) {
        if (!heights[at]) continue;
        let end = at;
        while (end + 1 < count && heights[end + 1] && hands[end + 1] === hands[at]) end++;
        // On to where the next begins, so hands meet with no seam between them.
        const last = end + 1 < count && heights[end + 1] ? end + 1 : end;
        const tone = inkOf(hands[at]!);
        const crest = new Path2D();
        crest.moveTo(xAt(at), yOf(at));
        for (let i = at + 1; i <= last; i++) crest.lineTo(xAt(i), yOf(i));
        const fill = new Path2D(crest);
        fill.lineTo(xAt(last), floor);
        fill.lineTo(xAt(at), floor);
        fill.closePath();
        const fade = pen.createLinearGradient(0, floor - room, 0, floor);
        fade.addColorStop(0, `color-mix(in srgb, ${tone} 78%, transparent)`);
        fade.addColorStop(1, `color-mix(in srgb, ${tone} 26%, transparent)`);
        pen.fillStyle = fade;
        pen.fill(fill);
        pen.strokeStyle = tone;
        pen.stroke(crest);
        at = end;
      }
      const faintly = shade.getContext('2d')!;
      faintly.clearRect(0, 0, w, h);
      faintly.globalAlpha = UNPLAYED;
      faintly.drawImage(canvas, 0, 0);
      faintly.globalAlpha = 1;
      // The floor of it, the same played or not: broken where a silence was cut, with how long, and
      // dashed for what history cannot say.
      const xOf = (at: number) => Math.round((at / (line.length || 1)) * w);
      const before = xOf(line.before);
      const tone = style.getPropertyValue('--replay-floor');
      for (const each of [pen, faintly]) {
        each.fillStyle = each.strokeStyle = tone;
        each.lineWidth = rule;
        each.lineCap = 'round';
        let from = before;
        for (let x = 0; x < before; x += 6 * rule) each.fillRect(x, floor, 3 * rule, rule);
        for (const cut of line.cuts) {
          const [start, end] = [xOf(cut.from), xOf(cut.to)];
          each.fillRect(from, floor, start - from, rule);
          from = end;
          const middle = (start + end) / 2;
          const tall = 5 * ratio;
          for (const side of [-1, 1]) {
            each.beginPath();
            each.moveTo(middle + (side - 1) * 1.5 * ratio, floor);
            each.lineTo(middle + (side + 1) * 1.5 * ratio, floor - tall);
            each.stroke();
          }
          each.font = `500 ${10 * ratio}px ${style.fontFamily}`;
          each.textAlign = 'center';
          each.fillStyle = style.getPropertyValue('--muted');
          each.fillText(shortLater(cut.ms), middle, floor - tall - 3 * ratio);
          each.fillStyle = tone;
        }
        each.fillRect(from, floor, w - from, rule);
      }
      place(placed.current);
    };
    draw();
    const watch = new ResizeObserver(draw);
    watch.observe(root.current!);
    addEventListener('resize', draw);
    return () => {
      watch.disconnect();
      removeEventListener('resize', draw);
    };
  }, [line, theme]);

  const atX = (clientX: number) => {
    const { left, width } = root.current!.getBoundingClientRect();
    const x = clientX - left;
    if (x <= SNAP_PX) return 0;
    if (x >= width - SNAP_PX) return line.length;
    return (x / width) * line.length;
  };
  const say = (clientX: number, at: number) => {
    const [box, words, line_] = [root.current, said.current, ghost.current];
    if (!box || !words || !line_) return;
    const { left, width } = box.getBoundingClientRect();
    const x = Math.max(0, Math.min(width, clientX - left));
    words.textContent = describe(at);
    words.hidden = !words.textContent;
    const half = words.offsetWidth / 2;
    words.style.transform = `translate3d(${Math.max(half, Math.min(width - half, x)) - half}px,0,0)`;
    line_.style.transform = `translate3d(${x}px,0,0)`;
    box.classList.add('is-told');
  };
  const quiet = () => root.current?.classList.remove('is-told');
  useEffect(
    () => () => {
      clearTimeout(told.current);
      told.current = undefined;
    },
    [],
  );
  useEffect(() => {
    if (!rising) quiet();
  }, [rising]);

  return (
    <div
      ref={root}
      className={`board-scrub${rising ? ' is-in' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label="Replay"
      aria-valuemin={0}
      aria-valuemax={100}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        held.current = true;
        grabbed();
        const at = atX(event.clientX);
        seek(at);
        place(at);
        say(event.clientX, at);
      }}
      onPointerMove={(event) => {
        const at = atX(event.clientX);
        if (held.current) {
          seek(at);
          place(at);
        }
        say(event.clientX, at);
      }}
      onPointerUp={(event) => {
        if (!held.current) return;
        held.current = false;
        dropped(atX(event.clientX) >= line.length);
        if (event.pointerType !== 'mouse') quiet();
      }}
      onPointerCancel={() => {
        if (held.current) dropped(false);
        held.current = false;
        quiet();
      }}
      onPointerLeave={() => held.current || quiet()}
    >
      <canvas ref={faint} className="board-scrub-faint" />
      <canvas ref={full} className="board-scrub-full" />
      <div ref={ghost} className="board-scrub-ghost" />
      <div ref={head} className="board-scrub-head" />
      <div ref={said} className="board-scrub-said" hidden />
    </div>
  );
}

export { whenOf };
