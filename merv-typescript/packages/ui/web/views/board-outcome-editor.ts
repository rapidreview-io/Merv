/**
 * The one surface an outcome is read and written on: CodeMirror over the Markdown itself, so that
 * the text stored is exactly the document open, byte for byte, and nothing ever has to be turned
 * into Markdown and back. It loads when a pane first opens (views/board-outcome.tsx). What arrives
 * from elsewhere goes outside the person's history, so Undo only ever takes back their own typing,
 * and carries their caret and their scroll along with it.
 */
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { defineLanguageFacet, Language, syntaxTree } from '@codemirror/language';
import { type ChangeSpec, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import {
  type Command,
  drawSelection,
  EditorView,
  keymap,
  showTooltip,
  type Tooltip,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { GFM, parser } from '@lezer/markdown';
import { hunksBetween, openingTitle } from './board-outcome-text';
import {
  hand,
  handAt,
  handState,
  present,
  type HandReport,
  type Run,
  wrote,
} from './board-outcome-hand';
import { markdownOf } from './board-outcome-paste';
import { carets, preview } from './board-outcome-preview';

const markdown = new Language(defineLanguageFacet(), parser.configure(GFM), [], 'markdown');

const LIST_LINE = /^(\s*)([-*+]|\d+[.)])( +)(\[[ xX]\] +)?/;
const QUOTE_LINE = /^(\s*(?:> ?)+)/;
const HEAD_LINE = /^#{1,6} /;

/** Whether a place is in code, where a line is only a line. */
const inCode = (state: EditorState, at: number) => {
  let up: SyntaxNode | null = syntaxTree(state).resolveInner(at, -1);
  for (; up; up = up.parent) if (up.name === 'FencedCode' || up.name === 'CodeBlock') return true;
  return false;
};

/** Enter in a list or a quote goes on with it; on an empty item, it ends it. */
const goOn: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty || state.readOnly || inCode(state, range.head)) return false;
  const line = state.doc.lineAt(range.head);
  const item = LIST_LINE.exec(line.text);
  const quote = !item && QUOTE_LINE.exec(line.text);
  const lead = item?.[0] ?? (quote ? quote[0] : null);
  if (lead === null || range.head < line.from + lead.length) return false;
  // With a blank line after it, or what comes next would be taken as more of the same item.
  if (line.length === lead.length) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '\n' },
      selection: { anchor: line.from + 1 },
      userEvent: 'input',
    });
    return true;
  }
  let next = lead;
  if (item) {
    const number = /^\d+/.exec(item[2]!)?.[0];
    const marker = number ? item[2]!.replace(number, String(Number(number) + 1)) : item[2]!;
    next = `${item[1]}${marker}${item[3]}${item[4] ? '[ ] ' : ''}`;
  }
  view.dispatch(
    state.update({
      changes: { from: range.head, insert: `\n${next}` },
      selection: { anchor: range.head + 1 + next.length },
      scrollIntoView: true,
      userEvent: 'input',
    }),
  );
  return true;
};

/** Backspace right after a mark takes the whole mark, where one character of it would be debris. */
const dropMark: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty || state.readOnly) return false;
  const line = state.doc.lineAt(range.head);
  const before = line.text.slice(0, range.head - line.from);
  if (!before || inCode(state, range.head)) return false;
  const item = LIST_LINE.exec(line.text);
  const lead =
    (item && item[0] === before && before.length - item[1]!.length) ||
    (HEAD_LINE.test(before) && HEAD_LINE.exec(before)![0] === before && before.length) ||
    (QUOTE_LINE.exec(before)?.[0] === before && before.length);
  if (!lead) return false;
  view.dispatch({
    changes: { from: range.head - lead, to: range.head },
    userEvent: 'delete',
  });
  return true;
};

/** Tab moves a list's item under the one above it; in code it is two spaces; elsewhere it leaves. */
const indent =
  (out: boolean): Command =>
  (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const range = state.selection.main;
    const line = state.doc.lineAt(range.head);
    const item = LIST_LINE.exec(line.text);
    if (!item) {
      if (!inCode(state, range.head) || out) return false;
      view.dispatch(state.replaceSelection('  '), { userEvent: 'input' });
      return true;
    }
    const above = line.number > 1 ? LIST_LINE.exec(state.doc.line(line.number - 1).text) : null;
    const step = above ? above[2]!.length + above[3]!.length : item[2]!.length + item[3]!.length;
    if (out) {
      const drop = Math.min(step, item[1]!.length);
      if (!drop) return true;
      view.dispatch({ changes: { from: line.from, to: line.from + drop }, userEvent: 'delete' });
    } else
      view.dispatch({ changes: { from: line.from, insert: ' '.repeat(step) }, userEvent: 'input' });
    return true;
  };

/** Wraps what is selected in a mark, or takes it off again. */
const toggle =
  (mark: string): Command =>
  (view) => {
    const { state } = view;
    if (state.readOnly) return false;
    const size = mark.length;
    view.dispatch(
      state.changeByRange((range) => {
        const words = state.sliceDoc(range.from, range.to);
        const outside =
          state.sliceDoc(range.from - size, range.from) === mark &&
          state.sliceDoc(range.to, range.to + size) === mark;
        if (outside)
          return {
            changes: [
              { from: range.from - size, to: range.from },
              { from: range.to, to: range.to + size },
            ],
            range: EditorSelection.range(range.from - size, range.to - size),
          };
        if (words.startsWith(mark) && words.endsWith(mark) && words.length >= size * 2)
          return {
            changes: { from: range.from, to: range.to, insert: words.slice(size, -size) },
            range: EditorSelection.range(range.from, range.to - size * 2),
          };
        return {
          changes: { from: range.from, to: range.to, insert: `${mark}${words}${mark}` },
          range: EditorSelection.range(range.from + size, range.to + size),
        };
      }),
      { userEvent: 'input.format' },
    );
    return true;
  };

/** Cmd-K: the selection as a link, with the caret where the address goes. */
const linkIt: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
  const range = state.selection.main;
  const words = state.sliceDoc(range.from, range.to);
  const url = 'https://';
  const start = range.from + words.length + 3;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: `[${words}](${url})` },
    selection: words
      ? EditorSelection.range(start, start + url.length)
      : { anchor: range.from + 1 },
    userEvent: 'input.format',
  });
  view.focus();
  return true;
};

/** Escape steps back: from a selection to a caret, from a caret out of the words. */
const stepBack: Command = (view) => {
  const range = view.state.selection.main;
  if (!range.empty) view.dispatch({ selection: { anchor: range.head } });
  else view.contentDOM.blur();
  return true;
};

const bubbleButton = (label: string, title: string, act: () => void, className = '') => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  if (className) button.className = className;
  // The selection is what the press is about, so the press must not take it.
  button.onmousedown = (event) => event.preventDefault();
  button.onclick = act;
  return button;
};

const bubble = (ask: (() => void) | undefined) => {
  const create = (view: EditorView) => {
    const dom = document.createElement('div');
    dom.className = 'cm-bubble';
    dom.append(
      bubbleButton('B', 'Bold', () => toggle('**')(view), 'is-strong'),
      bubbleButton('I', 'Italic', () => toggle('*')(view), 'is-em'),
      bubbleButton('Link', 'Link', () => linkIt(view)),
    );
    if (ask) dom.append(bubbleButton('Ask Pi', 'Ask Pi about this', ask, 'is-ask'));
    return { dom };
  };
  return showTooltip.compute(['selection', carets], (state): Tooltip | null => {
    const range = state.selection.main;
    const { focused, pressed } = state.field(carets);
    if (range.empty || !focused || pressed || state.readOnly) return null;
    return { pos: range.from, above: true, arrow: false, create };
  });
};

export interface EditorEvents {
  /** The person changed the text. */
  typed(): void;
  /** Whether the text now opens with a title of its own. */
  titled(has: boolean): void;
  /** Up or back from the first place, where a title stands above it. */
  left(): void;
  /** Where the other hand is. */
  hand(hand: HandReport | null): void;
  ask?(): void;
}

export interface OutcomeEditor {
  text(): string;
  /** Whether it has any words, asked at no cost in a long text. */
  written(): boolean;
  /** The text as it now stands elsewhere, written by `by` if anyone is to be seen writing it. */
  land(next: string, by: string | null): void;
  /** Someone is at work on this text, for as long as they are named. */
  working(name: string | null): void;
  /** Once no word is being composed: nothing may land under one. */
  settled(): Promise<void>;
  composing(): boolean;
  selected(): { from: number; to: number } | null;
  /** Lets go of a selection. */
  release(): void;
  focus(at?: 'start' | 'end'): void;
  toHand(): void;
  destroy(): void;
}

const quiet = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function outcomeEditor(
  parent: HTMLElement,
  text: string,
  editable: boolean,
  events: EditorEvents,
): OutcomeEditor {
  let plainNext = false;
  const titled = (state: EditorState) => !!openingTitle(state.sliceDoc(0, 400));
  let wasTitled = titled(EditorState.create({ doc: text }));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        // Only a newline parts lines, so a \r an agent wrote is still there when it is read back.
        EditorState.lineSeparator.of('\n'),
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Outcome text', spellcheck: 'true' }),
        history({ newGroupDelay: 600 }),
        markdown.extension,
        ...(matchMedia('(pointer: coarse)').matches ? [] : [drawSelection()]),
        preview,
        hand(events.hand),
        ...(editable ? [bubble(events.ask)] : []),
        keymap.of([
          { key: 'Enter', run: goOn },
          { key: 'Backspace', run: dropMark },
          { key: 'Tab', run: indent(false) },
          { key: 'Shift-Tab', run: indent(true) },
          { key: 'Mod-b', run: toggle('**') },
          { key: 'Mod-i', run: toggle('*') },
          { key: 'Mod-k', run: linkIt },
          { key: 'Escape', run: stepBack },
          {
            key: 'ArrowUp',
            run: (v) => (v.state.selection.main.head === 0 ? (events.left(), true) : false),
          },
          {
            key: 'Backspace',
            run: (v) => {
              const { empty, head } = v.state.selection.main;
              if (empty && head === 0) events.left();
              return false;
            },
          },
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.domEventHandlers({
          keydown(event) {
            plainNext = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'v';
            return false;
          },
          paste(event, v) {
            const data = event.clipboardData;
            const plain = data?.getData('text/plain') ?? '';
            const range = v.state.selection.main;
            // An address pasted over words makes them its link.
            if (!range.empty && /^https?:\/\/\S+$/.test(plain.trim()) && !v.state.readOnly) {
              const words = v.state.sliceDoc(range.from, range.to);
              v.dispatch(v.state.replaceSelection(`[${words}](${plain.trim()})`), {
                userEvent: 'input.paste',
              });
              return true;
            }
            const html = data?.getData('text/html');
            const asked = plainNext;
            plainNext = false;
            // Text copied from an editor of code carries colors, not structure.
            if (!html || asked || data?.types.includes('vscode-editor-data')) return false;
            const written = markdownOf(html);
            if (!written || v.state.readOnly) return false;
            v.dispatch(v.state.replaceSelection(written), {
              scrollIntoView: true,
              userEvent: 'input.paste',
            });
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const now = titled(update.state);
            if (now !== wasTitled) events.titled((wasTitled = now));
            if (update.transactions.some((tr) => tr.annotation(Transaction.userEvent)))
              events.typed();
          }
        }),
      ],
    }),
  });
  let waking: (() => void)[] = [];
  const woken = () => {
    if (!view.composing) {
      for (const wake of waking.splice(0)) wake();
      waking = [];
    }
  };
  view.contentDOM.addEventListener('compositionend', () => setTimeout(woken));
  return {
    text: () => view.state.doc.toString(),
    written: () => view.state.doc.length > 64 || !!view.state.doc.toString().trim(),
    land(next, by) {
      const hunks = hunksBetween(view.state.doc.toString(), next);
      if (!hunks.length) return;
      const changes: ChangeSpec[] = hunks;
      const runs: Run[] = [];
      let moved = 0;
      let rest = 0;
      for (const { from, to, insert } of hunks) {
        const at = from + moved;
        if (insert.trim()) runs.push({ at, to: at + insert.length });
        rest = at + insert.trimEnd().length;
        moved += insert.length - (to - from);
      }
      const shown = by && document.visibilityState === 'visible' && !quiet();
      // What stands at the caret, or else at the top of the view, stays where it is on the screen.
      const scroller = view.scrollDOM;
      const box = scroller.getBoundingClientRect();
      const anchor = view.hasFocus
        ? view.state.selection.main.head
        : view.posAtCoords({ x: box.left + box.width / 2, y: box.top + 4 }, false);
      const was = view.state.doc.length ? view.coordsAtPos(anchor, 1)?.top : undefined;
      const transaction = view.state.update({
        changes,
        annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
        ...(by && { effects: wrote.of({ name: by, runs: shown ? runs : [], rest }) }),
      });
      view.dispatch(transaction);
      if (was === undefined) return;
      const mapped = transaction.changes.mapPos(anchor, 1);
      view.requestMeasure({
        read: () => view.coordsAtPos(mapped, 1)?.top,
        write(now) {
          if (now !== undefined && Math.abs(now - was) > 1) scroller.scrollTop += now - was;
        },
      });
    },
    working(name) {
      view.dispatch({ effects: present.of(name) });
    },
    settled: () =>
      new Promise((wake) => {
        if (view.composing) waking.push(wake);
        else wake();
      }),
    composing: () => view.composing,
    selected() {
      const { from, to, empty } = view.state.selection.main;
      return empty ? null : { from, to };
    },
    release() {
      const { empty, head } = view.state.selection.main;
      if (!empty) view.dispatch({ selection: { anchor: head } });
    },
    focus(at) {
      if (at) {
        const anchor = at === 'start' ? 0 : view.state.doc.length;
        view.dispatch({ selection: { anchor }, scrollIntoView: true });
      }
      view.focus();
    },
    toHand() {
      view.dispatch({
        effects: EditorView.scrollIntoView(handAt(view.state.field(handState)), {
          y: 'center',
        }),
      });
    },
    destroy: () => view.destroy(),
  };
}
