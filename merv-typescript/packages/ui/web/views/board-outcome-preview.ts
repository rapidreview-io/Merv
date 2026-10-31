/**
 * The outcome as it reads, drawn over its Markdown: the source is never rewritten, only shown. Marks
 * stay out of sight until the caret touches them. A heading's hashes then hang in the margin so its
 * words stay put, and a mark within a paragraph appears only where the caret is at it, never because
 * it stands somewhere in that sentence. Nothing moves while the mouse is down, so that text never
 * slides out from under a selection being made.
 */
import { syntaxTree } from '@codemirror/language';
import { type Range, StateEffect, StateField, type EditorState } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { safeHref } from '../markdown-links';

const setFocus = StateEffect.define<boolean>();
const setPress = StateEffect.define<boolean>();
interface Carets {
  focused: boolean;
  pressed: boolean;
  at: readonly number[];
}
/** Where the marks are shown: at each caret of a focused editor, and held still while pressing. */
export const carets = StateField.define<Carets>({
  create: () => ({ focused: false, pressed: false, at: [] }),
  update(was, tr) {
    let { focused, pressed } = was;
    for (const effect of tr.effects) {
      if (effect.is(setFocus)) focused = effect.value;
      if (effect.is(setPress)) pressed = effect.value;
    }
    const at = pressed
      ? was.at.map((spot) => tr.changes.mapPos(spot))
      : focused
        ? tr.state.selection.ranges.filter((range) => range.empty).map((range) => range.head)
        : [];
    const same =
      focused === was.focused &&
      pressed === was.pressed &&
      at.length === was.at.length &&
      at.every((spot, i) => spot === was.at[i]);
    return same ? was : { focused, pressed, at };
  },
});

const cached = <T>(make: (key: string) => T) => {
  const held = new Map<string, T>();
  return (key: string) => {
    if (!held.has(key)) held.set(key, make(key));
    return held.get(key)!;
  };
};
/** Out of sight but still in the line: anything replaced would leave a place for the line to break. */
const HIDE = Decoration.mark({ class: 'cm-gone', attributes: { 'aria-hidden': 'true' } });
const mark = cached((name) => Decoration.mark({ class: name }));
const lineOf = cached((name) => Decoration.line({ class: name }));
const hang = cached((size) =>
  Decoration.mark({ class: 'cm-hang', attributes: { style: `--hang:${size}` } }),
);
const lineStyle = cached((style) => Decoration.line({ class: 'cm-li', attributes: { style } }));

const INLINE: Record<string, string> = {
  Emphasis: 'cm-em',
  StrongEmphasis: 'cm-strong',
  Strikethrough: 'cm-del',
  InlineCode: 'cm-inline-code',
};

class Bullet extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const dot = document.createElement('span');
    dot.className = 'cm-li-slot cm-li-dot';
    dot.setAttribute('aria-hidden', 'true');
    return dot;
  }
}
const bullet = Decoration.replace({ widget: new Bullet() });

class Check extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
  ) {
    super();
  }
  override eq(other: Check) {
    return other.checked === this.checked && other.from === this.from;
  }
  toDOM(view: EditorView) {
    const slot = document.createElement('span');
    slot.className = 'cm-li-slot';
    const box = slot.appendChild(document.createElement('input'));
    box.type = 'checkbox';
    box.className = 'cm-check';
    box.checked = this.checked;
    box.disabled = view.state.readOnly;
    box.onmousedown = (event) => event.preventDefault();
    box.onclick = (event) => {
      event.preventDefault();
      // Where it stands now, and what it says now: another hand may have moved both.
      const at = view.posAtDOM(slot);
      const now = view.state.sliceDoc(at, at + 3);
      if (!/^\[[ xX]\]$/.test(now)) return;
      view.dispatch({
        changes: { from: at + 1, to: at + 2, insert: now[1] === ' ' ? 'x' : ' ' },
        userEvent: 'input.check',
      });
    };
    return slot;
  }
  override ignoreEvent() {
    return true;
  }
}

/** A list's depth in the document: how many lists stand around it. */
const depthOf = (node: { parent: unknown }) => {
  let depth = -1;
  for (
    let up = node.parent as { name: string; parent: unknown } | null;
    up;
    up = up.parent as typeof up
  )
    if (up.name === 'BulletList' || up.name === 'OrderedList') depth++;
  return Math.max(0, depth);
};

function drawn(view: EditorView): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const { at } = state.field(carets);
  const touching = (from: number, to: number) => at.some((spot) => spot >= from && spot <= to);
  const open: Range<Decoration>[] = [];
  const lines = new Map<number, string[]>();
  const list = new Map<number, { depth: number; marked: boolean }>();
  const shown = view.visibleRanges;
  const eachLine = (
    from: number,
    to: number,
    act: (line: ReturnType<typeof doc.lineAt>) => void,
  ) => {
    for (const range of shown) {
      const [start, stop] = [Math.max(from, range.from), Math.min(to, range.to)];
      if (start > stop) continue;
      for (let line = doc.lineAt(start); ; line = doc.line(line.number + 1)) {
        act(line);
        if (line.to >= stop || line.number === doc.lines) break;
      }
    }
  };
  const addLine = (from: number, to: number, name: string) =>
    eachLine(from, to, (line) => {
      lines.set(line.from, [...(lines.get(line.from) ?? []), name]);
    });
  const onLine = (from: number) => {
    const line = doc.lineAt(from);
    return touching(line.from, line.to);
  };
  /** A block's mark with the space that follows it. */
  const withSpace = (to: number) => (state.sliceDoc(to, to + 1) === ' ' ? to + 1 : to);
  const blockMark = (from: number, to: number) => {
    const end = withSpace(to);
    if (from === end) return;
    open.push((onLine(from) ? hang(String(end - from)) : HIDE).range(from, end));
  };
  const inlineMark = (from: number, to: number) => {
    if (from === to) return;
    open.push((touching(from, to) ? mark('cm-mark') : HIDE).range(from, to));
  };
  for (const { from, to } of shown)
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const { name } = node;
        if (name.startsWith('ATXHeading')) {
          const level = name.slice(-1);
          const first = level === '1' && !state.sliceDoc(0, node.from).trim();
          addLine(node.from, node.to, `cm-h cm-h${level}${first ? ' cm-title' : ''}`);
        } else if (name.startsWith('SetextHeading')) {
          addLine(node.from, node.to, `cm-h cm-h${name.slice(-1)}`);
        } else
          switch (name) {
            case 'HeaderMark': {
              const opening = doc.lineAt(node.from).from === node.from;
              if (opening) blockMark(node.from, node.to);
              else if (node.from !== node.to) inlineMark(node.from, node.to);
              break;
            }
            case 'QuoteMark':
              blockMark(node.from, node.to);
              break;
            case 'Blockquote':
              addLine(node.from, node.to, 'cm-quote');
              break;
            case 'Emphasis':
            case 'StrongEmphasis':
            case 'Strikethrough':
            case 'InlineCode':
              open.push(mark(INLINE[name]!).range(node.from, node.to));
              break;
            case 'EmphasisMark':
            case 'StrikethroughMark':
            case 'CodeMark':
              inlineMark(node.from, node.to);
              break;
            case 'Escape':
              inlineMark(node.from, node.from + 1);
              break;
            case 'Link': {
              const marks = node.node.getChildren('LinkMark');
              const url = node.node.getChild('URL');
              if (marks.length < 3 || !url) return;
              const [first, last] = [marks[0]!, marks[1]!];
              // A link with no words yet has nothing to underline.
              if (first.to < last.from)
                open.push(
                  Decoration.mark({
                    class: 'cm-link',
                    attributes: { 'data-href': state.sliceDoc(url.from, url.to) },
                  }).range(first.to, last.from),
                );
              const near = touching(node.from, first.to) || touching(last.from, node.to);
              open.push(
                (near ? mark('cm-mark') : HIDE).range(node.from, first.to),
                (near ? mark('cm-mark') : HIDE).range(last.from, node.to),
              );
              break;
            }
            case 'URL':
              if (node.node.parent?.name !== 'Link')
                open.push(
                  Decoration.mark({
                    class: 'cm-link',
                    attributes: { 'data-href': state.sliceDoc(node.from, node.to) },
                  }).range(node.from, node.to),
                );
              break;
            case 'Image':
            case 'HTMLBlock':
            case 'HTMLTag':
            case 'CommentBlock':
              open.push(mark('cm-mark').range(node.from, node.to));
              return false;
            case 'ListItem':
              eachLine(node.from, node.to, (line) =>
                list.set(line.from, {
                  depth: depthOf(node.node),
                  marked: list.get(line.from)?.marked ?? false,
                }),
              );
              break;
            case 'ListMark': {
              const end = withSpace(node.to);
              const line = doc.lineAt(node.from);
              list.set(line.from, { depth: depthOf(node.node.parent!), marked: true });
              const within = at.some((spot) => spot >= node.from && spot < end);
              const task = /^ \[[ xX]\]/.test(state.sliceDoc(node.to, node.to + 4));
              const ordered = /\d/.test(state.sliceDoc(node.from, node.to));
              if (within) open.push(mark('cm-li-slot cm-mark').range(node.from, end));
              else if (task) open.push(HIDE.range(node.from, end));
              else if (ordered) open.push(mark('cm-li-slot cm-li-num').range(node.from, end));
              else open.push(bullet.range(node.from, end));
              break;
            }
            case 'TaskMarker': {
              const end = withSpace(node.to);
              const checked = state.sliceDoc(node.from + 1, node.from + 2) !== ' ';
              if (checked) addLine(node.from, node.to, 'cm-done');
              if (at.some((spot) => spot >= node.from && spot < end))
                open.push(mark('cm-li-slot cm-mark').range(node.from, end));
              else
                open.push(
                  Decoration.replace({ widget: new Check(checked, node.from) }).range(
                    node.from,
                    end,
                  ),
                );
              break;
            }
            case 'FencedCode': {
              const inside = touching(node.from, node.to);
              const fences = node.node.getChildren('CodeMark');
              const top = doc.lineAt(node.from);
              const bottom = doc.lineAt(node.to);
              addLine(node.from, node.to, 'cm-code');
              addLine(top.from, top.from, 'cm-code-top');
              addLine(bottom.from, bottom.from, 'cm-code-bottom');
              if (!inside) {
                addLine(top.from, top.from, 'cm-fence-off');
                if (fences.length > 1) addLine(bottom.from, bottom.from, 'cm-fence-off');
              }
              return false;
            }
            case 'CodeBlock': {
              addLine(node.from, node.to, 'cm-code');
              addLine(node.from, node.from, 'cm-code-top');
              addLine(node.to, node.to, 'cm-code-bottom');
              return false;
            }
            case 'HorizontalRule':
              if (!onLine(node.from)) addLine(node.from, node.to, 'cm-hr');
              return false;
            case 'Table':
              addLine(node.from, node.to, 'cm-table-source');
              return false;
          }
      },
    });
  // The lists' indents, by depth rather than by the width of whatever spaces the source has.
  for (const [from, { depth, marked }] of list) {
    const indent = (depth + 1) * 1.5;
    const style = marked
      ? `padding-left:${indent}em;text-indent:-1.5em`
      : `padding-left:${indent}em`;
    open.push(lineStyle(style).range(from));
    const line = doc.lineAt(from);
    const lead = /^[ \t]+/.exec(line.text)?.[0].length ?? 0;
    if (lead && !at.some((spot) => spot > line.from && spot < line.from + lead))
      open.push(HIDE.range(line.from, line.from + lead));
  }
  for (const { from, to } of shown)
    eachLine(from, to, (line) => {
      if (!line.text.trim() && !lines.has(line.from) && !list.has(line.from))
        addLine(line.from, line.from, 'cm-blank');
    });
  for (const [from, names] of lines) open.push(lineOf(names.join(' ')).range(from));
  return Decoration.set(open, true);
}

const shownMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = drawn(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.state.field(carets) !== update.startState.field(carets) ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      )
        this.decorations = drawn(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** A cell of a table's source: its words, and the offset of them in the row. */
const cellsOf = (row: string) => {
  const cells: { text: string; at: number }[] = [];
  const body = /^\s*\|?/.exec(row)![0].length;
  let start = body;
  for (let i = body; i <= row.length; i++) {
    const end = i === row.length;
    if (!end && (row[i] !== '|' || row[i - 1] === '\\')) continue;
    if (!end || row.slice(start).trim()) {
      const raw = row.slice(start, i);
      cells.push({ text: raw.trim(), at: start + raw.length - raw.trimStart().length });
    }
    start = i + 1;
  }
  return cells;
};
/** A cell's words as they read: its emphasis, code and links, and the rest as text. */
const inline = (into: HTMLElement, source: string) => {
  const pattern = /(\*\*|__)(.+?)\1|([*_])(.+?)\3|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g;
  let last = 0;
  for (const found of source.matchAll(pattern)) {
    into.append(source.slice(last, found.index));
    last = found.index + found[0].length;
    const [, , strong, , em, code, label, href] = found;
    const tag = strong ? 'strong' : em ? 'em' : code ? 'code' : 'a';
    const part = into.appendChild(document.createElement(tag));
    if (tag === 'a') {
      part.className = 'cm-link';
      part.dataset.href = href;
    }
    inline(part, strong ?? em ?? '');
    if (code) part.textContent = code;
    if (label) inline(part, label);
  }
  into.append(source.slice(last));
};

class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number,
  ) {
    super();
  }
  override eq(other: TableWidget) {
    return other.source === this.source && other.from === this.from;
  }
  override get estimatedHeight() {
    return this.source.split('\n').length * 36;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('div');
    box.className = 'cm-table-box';
    const table = box.appendChild(document.createElement('table'));
    const rows = this.source.split('\n');
    const aligns = cellsOf(rows[1] ?? '').map(({ text }) =>
      text.endsWith(':') ? (text.startsWith(':') ? 'center' : 'right') : 'left',
    );
    let offset = 0;
    rows.forEach((row, index) => {
      if (index !== 1) {
        const tr = table.appendChild(document.createElement('tr'));
        cellsOf(row).forEach(({ text, at }, column) => {
          const cell = tr.appendChild(document.createElement(index ? 'td' : 'th'));
          cell.style.textAlign = aligns[column] ?? 'left';
          cell.dataset.at = String(offset + at);
          inline(cell, text);
        });
      }
      offset += row.length + 1;
    });
    // A press lands in the source of the cell pressed, unless the press was on a link to follow.
    box.addEventListener('mousedown', (event) => {
      if (view.state.readOnly || event.button) return;
      const cell = (event.target as Element).closest<HTMLElement>('[data-at]');
      if (!cell) return;
      event.preventDefault();
      view.focus();
      const at = view.posAtDOM(box) + Number(cell.dataset.at);
      view.dispatch({ selection: { anchor: Math.min(at, view.state.doc.length) } });
    });
    return box;
  }
  override ignoreEvent() {
    return true;
  }
}

/** Every table of the text, drawn whole unless the caret is in its source. */
const tablesOf = (state: EditorState) => {
  const widgets: Range<Decoration>[] = [];
  const { at } = state.field(carets);
  const cursor = syntaxTree(state).cursor();
  if (cursor.firstChild())
    do {
      if (cursor.name !== 'Table') continue;
      const { from, to } = cursor;
      if (at.some((spot) => spot >= from && spot <= to)) continue;
      widgets.push(
        Decoration.replace({
          widget: new TableWidget(state.sliceDoc(from, to), from),
          block: true,
        }).range(from, to),
      );
    } while (cursor.nextSibling());
  return Decoration.set(widgets);
};
const tables = StateField.define<DecorationSet>({
  create: tablesOf,
  update: (was, tr) =>
    tr.docChanged ||
    tr.state.field(carets) !== tr.startState.field(carets) ||
    syntaxTree(tr.state) !== syntaxTree(tr.startState)
      ? tablesOf(tr.state)
      : was,
  provide: (field) => EditorView.decorations.from(field),
});

/** Follows a link on a modified press, or any press where nobody edits. */
const follow = (event: MouseEvent, view: EditorView) => {
  const link = (event.target as Element).closest?.<HTMLElement>('[data-href]');
  if (!link || (!event.metaKey && !event.ctrlKey && !view.state.readOnly)) return false;
  const safe = safeHref(link.dataset.href ?? '');
  if (safe) window.open(safe.href, '_blank', 'noopener');
  event.preventDefault();
  return !!safe;
};

export const preview = [
  carets,
  tables,
  shownMarks,
  EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing)),
  EditorView.domEventHandlers({
    click: follow,
    mousedown(event, view) {
      if (event.button) return false;
      view.dispatch({ effects: setPress.of(true) });
      addEventListener(
        'mouseup',
        () => view.dom.isConnected && view.dispatch({ effects: setPress.of(false) }),
        { once: true, capture: true },
      );
      return false;
    },
  }),
];
