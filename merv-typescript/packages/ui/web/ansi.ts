/**
 * What a terminal printed, as a page can show it. Logs, check output and notebook
 * tracebacks carry SGR escapes for colour and weight; those become class names on
 * runs of text (the colours are the app's own inks, per theme, in styles.css), and
 * every other escape a program wrote — cursor moves, titles, links — is dropped, so
 * nothing of the machine's control language is ever printed as text.
 */

/** One stretch of text printed in one style; `className` is absent where the style is plain. */
interface AnsiRun {
  text: string;
  className?: string;
}

/** A CSI sequence, an OSC string, or an escape and whatever one character follows it. */
// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[^]?)/g;

export const hasAnsi = (text: string) => text.includes('\x1b');

interface Style {
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
}
const classOf = ({ fg, bg, bold, dim }: Style) =>
  [
    fg !== undefined && `ansi-fg${fg}`,
    bg !== undefined && `ansi-bg${bg}`,
    bold && 'ansi-bold',
    dim && 'ansi-dim',
  ]
    .filter(Boolean)
    .join(' ') || undefined;

/** One SGR sequence applied to the style before it. 256-colour and true-colour forms are read past. */
function apply(style: Style, params: string): Style {
  const codes = params.split(/[;:]/).map((code) => (code ? Number(code) : 0));
  const next = { ...style };
  for (let at = 0; at < codes.length; at++) {
    const code = codes[at]!;
    if (code === 0) for (const key of Object.keys(next)) delete next[key as keyof Style];
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) next.bold = next.dim = undefined;
    else if (code === 39) next.fg = undefined;
    else if (code === 49) next.bg = undefined;
    // The basic eight and their bright eight: bright is told apart by weight of ink, not hue.
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 90 && code <= 97) next.fg = code - 90;
    else if (code >= 40 && code <= 47) next.bg = code - 40;
    else if (code >= 100 && code <= 107) next.bg = code - 100;
    else if (code === 38 || code === 48)
      at += codes[at + 1] === 5 ? 2 : codes[at + 1] === 2 ? 4 : 1;
  }
  return next;
}

/** A terminal's text to its styled runs, escapes gone. Plain text is one run of itself. */
export function parseAnsi(text: string): AnsiRun[] {
  if (!hasAnsi(text)) return text ? [{ text }] : [];
  const runs: AnsiRun[] = [];
  let style: Style = {};
  let from = 0;
  const push = (to: number) => {
    const piece = text.slice(from, to);
    if (!piece) return;
    const className = classOf(style);
    const last = runs[runs.length - 1];
    if (last && last.className === className) last.text += piece;
    else runs.push(className ? { text: piece, className } : { text: piece });
  };
  for (const match of text.matchAll(ESCAPE)) {
    push(match.index);
    from = match.index + match[0].length;
    if (match[2] === 'm') style = apply(style, match[1]!);
  }
  push(text.length);
  return runs;
}
