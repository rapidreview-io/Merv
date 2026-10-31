/**
 * Who else is writing, drawn as a hand. What comes in is whole in the document the moment it lands,
 * since the merge and the saves reckon with the text as it is, and a hand reveals it from its first
 * letter to its last at a caret with a name: nothing else moves, because the words it has yet to
 * reach already stand there unseen. It never scrolls toward what a person has left, and it is told
 * away from the pane in words where it cannot be seen.
 */
import { StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  layer,
  type LayerMarker,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

/** The least a hand writes a second, the longest one chunk may take, and how long it lingers. */
const [LEAST_PER_S, MOST_S, LINGER_MS] = [70, 8, 6000];
/** How many of the last letters are still drying. */
const DRYING = 14;

export interface Run {
  at: number;
  to: number;
}
interface HandState {
  name: string | null;
  runs: Run[];
  /** Where it rests once it has no more to write. */
  rest: number;
  /** Told to stay, because its agent is still at work. */
  held: boolean;
}
export const wrote = StateEffect.define<{ name: string; runs: Run[]; rest: number }>();
const advance = StateEffect.define<number>();
export const present = StateEffect.define<string | null>();
const gone = StateEffect.define<null>();

export const handState = StateField.define<HandState>({
  create: () => ({ name: null, runs: [], rest: 0, held: false }),
  update(was, tr) {
    let { name, runs, rest, held } = was;
    if (tr.docChanged) {
      rest = tr.changes.mapPos(rest, 1);
      const typed = tr.isUserEvent('input') || tr.isUserEvent('delete');
      runs = runs.map(({ at, to }) => {
        let [now, end] = [tr.changes.mapPos(at, 1), tr.changes.mapPos(to, -1)];
        // A person's words in what it has yet to reach are seen at once, with what is around them.
        if (typed)
          tr.changes.iterChanges((from, stop) => {
            if (from <= to && stop >= at) now = end;
          });
        return { at: now, to: end };
      });
    }
    for (const effect of tr.effects) {
      if (effect.is(wrote)) {
        name = effect.value.name;
        rest = effect.value.rest;
        runs = [...runs, ...effect.value.runs];
      } else if (effect.is(advance)) {
        let left = effect.value;
        runs = runs.map((run) => {
          const step = Math.min(left, run.to - run.at);
          left -= step;
          return { at: run.at + step, to: run.to };
        });
      } else if (effect.is(present)) {
        held = !!effect.value;
        if (effect.value) name = effect.value;
        if (effect.value && !was.name) rest = tr.state.doc.length;
      } else if (effect.is(gone)) {
        name = null;
      }
    }
    runs = runs.filter((run) => run.at < run.to);
    return { name, runs, rest, held };
  },
});
export const handAt = ({ runs, rest }: HandState) => (runs.length ? runs[0]!.at : rest);

const veil = Decoration.mark({ class: 'cm-unwritten' });
const drying = Decoration.mark({ class: 'cm-drying' });
const inks = EditorView.decorations.compute([handState], (state) => {
  const { runs } = state.field(handState);
  if (!runs.length) return Decoration.none;
  const first = runs[0]!;
  return Decoration.set(
    [
      ...(first.at > 0 ? [drying.range(Math.max(0, first.at - DRYING), first.at)] : []),
      ...runs.map(({ at, to }) => veil.range(at, to)),
    ],
    true,
  );
});

class HandMarker implements LayerMarker {
  constructor(
    readonly left: number,
    readonly top: number,
    readonly height: number,
    readonly name: string,
    readonly flip: boolean,
    readonly busy: boolean,
  ) {}
  eq(other: HandMarker) {
    return (
      other.left === this.left &&
      other.top === this.top &&
      other.height === this.height &&
      other.name === this.name &&
      other.flip === this.flip &&
      other.busy === this.busy
    );
  }
  draw() {
    const dom = document.createElement('div');
    dom.className = 'cm-hand';
    dom.appendChild(document.createElement('span')).className = 'cm-hand-name';
    this.place(dom);
    return dom;
  }
  update(dom: HTMLElement) {
    this.place(dom);
    return true;
  }
  private place(dom: HTMLElement) {
    dom.style.cssText = `left:${this.left}px;top:${this.top}px;height:${this.height}px`;
    dom.classList.toggle('is-flipped', this.flip);
    dom.classList.toggle('is-resting', !this.busy);
    dom.firstElementChild!.textContent = this.name;
  }
}
const hands = layer({
  above: true,
  class: 'cm-hands',
  update: (update) =>
    update.docChanged ||
    update.viewportChanged ||
    update.geometryChanged ||
    update.state.field(handState) !== update.startState.field(handState),
  markers(view) {
    const state = view.state.field(handState);
    if (!state.name) return [];
    const spot = view.coordsAtPos(handAt(state), 1);
    if (!spot) return [];
    const box = view.scrollDOM.getBoundingClientRect();
    const left = spot.left - box.left + view.scrollDOM.scrollLeft;
    const top = spot.top - box.top + view.scrollDOM.scrollTop;
    // Its name goes above where it would stand on the words to the right of it.
    const pos = handAt(state);
    const busy = !!state.runs.length;
    const words = !busy && view.state.doc.lineAt(pos).to > pos;
    const flip = spot.left > box.right - 110;
    return [new HandMarker(left, top, spot.bottom - spot.top, state.name, flip || words, busy)];
  },
});

export interface HandReport {
  name: string;
  /** Out of sight, and which way. */
  away: 'above' | 'below' | null;
}

/** Moves the hand on by the clock, keeps it in view while it was, and says where it is. */
const walker = (report: (hand: HandReport | null) => void) =>
  ViewPlugin.fromClass(
    class {
      private frame = 0;
      private last = 0;
      private owed = 0;
      private linger?: ReturnType<typeof setTimeout>;
      private said = '';
      /** It was in sight at the last look, so following it takes nobody anywhere. */
      private seen = true;
      constructor(private view: EditorView) {
        view.scrollDOM.addEventListener('scroll', this.look, { passive: true });
      }
      update(update: ViewUpdate) {
        const [was, now] = [update.startState.field(handState), update.state.field(handState)];
        if (was === now) return;
        if (now.runs.length && !this.frame) {
          this.last = 0;
          this.frame = requestAnimationFrame(this.tick);
        }
        clearTimeout(this.linger);
        if (now.name && !now.runs.length && !now.held)
          this.linger = setTimeout(() => {
            this.view.dispatch({ effects: gone.of(null) });
          }, LINGER_MS);
        queueMicrotask(this.look);
      }
      private tick = (time: number) => {
        const { runs } = this.view.state.field(handState);
        if (!runs.length) {
          this.frame = 0;
          return;
        }
        // Asked for before the step, which would otherwise ask for one of its own.
        this.frame = requestAnimationFrame(this.tick);
        const dt = this.last ? Math.min(0.1, (time - this.last) / 1000) : 1 / 60;
        this.last = time;
        const left = runs.reduce((sum, run) => sum + run.to - run.at, 0);
        const pace = Math.max(LEAST_PER_S, left / MOST_S);
        const hidden = document.visibilityState === 'hidden';
        // Whole letters, with what a short frame owes carried to the next.
        this.owed += pace * dt;
        const step = Math.floor(this.owed);
        this.owed -= step;
        if (hidden || step) this.view.dispatch({ effects: advance.of(hidden ? left : step) });
        this.follow();
      };
      /** Into view with the hand, where it was in view and the person is not writing. */
      private follow() {
        if (this.view.hasFocus || !this.seen) return;
        const state = this.view.state.field(handState);
        const spot = this.view.coordsAtPos(handAt(state), 1);
        if (!spot) return;
        const box = this.view.scrollDOM.getBoundingClientRect();
        const below = spot.bottom + 96 - box.bottom;
        // Eased: a page that follows a hand glides, and does not hop a line at a time.
        if (below > 0) this.view.scrollDOM.scrollTop += Math.ceil(below / 6);
      }
      private look = () => {
        if (!this.view.dom.isConnected) return;
        const state = this.view.state.field(handState);
        if (!state.name) return this.say(null);
        const at = handAt(state);
        const spot = this.view.coordsAtPos(at, 1);
        const box = this.view.scrollDOM.getBoundingClientRect();
        const away = !spot
          ? at >= this.view.viewport.to
            ? 'below'
            : 'above'
          : spot.top > box.bottom
            ? 'below'
            : spot.bottom < box.top
              ? 'above'
              : null;
        this.seen = !away;
        this.say({ name: state.name, away });
      };
      private say(hand: HandReport | null) {
        const key = JSON.stringify(hand);
        if (key === this.said) return;
        this.said = key;
        report(hand);
      }
      destroy() {
        cancelAnimationFrame(this.frame);
        clearTimeout(this.linger);
        this.view.scrollDOM.removeEventListener('scroll', this.look);
      }
    },
  );

export const hand = (report: (hand: HandReport | null) => void) => [
  handState,
  inks,
  hands,
  walker(report),
];
