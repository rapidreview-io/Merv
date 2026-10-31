/**
 * What an outcome's pane reckons with text (views/board-outcome.tsx). The person's typing reaches
 * Board as one hunk, in the paper's contract: a find occurring exactly once, and what replaces it.
 * Whatever else moved the text meanwhile, that same hunk is applied to it on the page, and what
 * then differs reaches the editor as the fewest changes, so nothing else in it moves.
 */

/** How far apart two changes must stand, in characters, to be told apart within a line. */
const APART = 8;

/** How much two texts share at each end. */
const edges = (a: string, b: string) => {
  const most = Math.min(a.length, b.length);
  let head = 0;
  while (head < most && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < most - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { head, tail };
};

/**
 * What turned `saved` into `draft`, as whole lines, so that its find names the sentence and never
 * a stray digit, widened a line at a time until it occurs once. Null in an empty text, where there
 * is nothing to find.
 */
export function hunkOf(saved: string, draft: string) {
  if (!saved) return null;
  const { head, tail } = edges(saved, draft);
  const lineEnd = (at: number) => {
    const end = saved.indexOf('\n', at);
    return end < 0 ? saved.length : end;
  };
  let from = head ? saved.lastIndexOf('\n', head - 1) + 1 : 0;
  let to = lineEnd(saved.length - tail);
  const once = () => {
    const find = saved.slice(from, to);
    return !!find && saved.indexOf(find) === saved.lastIndexOf(find);
  };
  while (!once() && (from || to < saved.length)) {
    from = from > 1 ? saved.lastIndexOf('\n', from - 2) + 1 : 0;
    to = lineEnd(to + 1);
  }
  return {
    find: saved.slice(from, to),
    replace: draft.slice(from, draft.length - (saved.length - to)),
  };
}

/**
 * `mine`, written against `base`, on what the text has become. Where the same lines were changed
 * both ways, both stand, the person's first, for them to settle: nobody's words go unsaid.
 */
export function rebased(base: string, mine: string, theirs: string): string {
  if (mine === base || mine === theirs) return theirs;
  if (theirs === base) return mine;
  if (!base) return `${theirs}\n\n${mine}`;
  // Apart, even in one paragraph, each stands where it was made. Touching, neither can say which
  // characters are whose, so the lines decide below.
  const [a, b] = [spanOf(base, mine), spanOf(base, theirs)];
  const [first, second] = a.from <= b.from ? [a, b] : [b, a];
  if (second.from - first.to >= APART)
    return (
      base.slice(0, first.from) +
      first.insert +
      base.slice(first.to, second.from) +
      second.insert +
      base.slice(second.to)
    );
  const { find, replace } = hunkOf(base, mine)!;
  const at = theirs.indexOf(find);
  if (at >= 0 && at === theirs.lastIndexOf(find))
    return theirs.slice(0, at) + replace + theirs.slice(at + find.length);
  // After the nearest line above that still stands, or else at the top.
  const above = base.slice(0, base.indexOf(find)).trimEnd().split('\n').at(-1)!;
  const after = above && theirs.includes(above) ? theirs.indexOf(above) + above.length + 2 : 0;
  const lead = theirs.slice(0, after).padEnd(after, '\n');
  return `${lead}${replace}\n\n${theirs.slice(after).replace(/^\n+/, '')}`;
}

export interface Span {
  from: number;
  to: number;
  insert: string;
}
/** The one stretch of `a` that turns it into `b`. */
const spanOf = (a: string, b: string): Span => {
  const { head, tail } = edges(a, b);
  return { from: head, to: a.length - tail, insert: b.slice(head, b.length - tail) };
};
/** Past this many lines or words each way, a change is one stretch: a rewrite has nothing to keep. */
const MOST_PIECES = 1500;

/**
 * What turned `a` into `b`, as few and as small as lines let it be told: words added on either side
 * of a caret leave it where it is, which one stretch from the first change to the last would not.
 */
export function hunksBetween(a: string, b: string): Span[] {
  if (a === b) return [];
  const { head, tail } = edges(a, b);
  // Whole lines, each with its own newline: what is the same line is the same string.
  const start = head ? a.lastIndexOf('\n', head - 1) + 1 : 0;
  const lines = (text: string) => {
    const end = tail ? text.indexOf('\n', text.length - tail) : -1;
    return text.slice(start, end < 0 ? text.length : end + 1).split(/(?<=\n)/);
  };
  const [was, now] = [lines(a), lines(b)];
  if (was.length > MOST_PIECES || now.length > MOST_PIECES) return [spanOf(a, b)];
  // Within what differs, word by word: two changes in one paragraph are two changes.
  return changesIn(was, now, start).flatMap((hunk) => {
    const cut = spanOf(a.slice(hunk.from, hunk.to), hunk.insert);
    const [from, to] = [hunk.from + cut.from, hunk.from + cut.to];
    const [gone, come] = [words(a.slice(from, to)), words(cut.insert)];
    return gone.length > MOST_PIECES || come.length > MOST_PIECES || !to || from === to
      ? [{ from, to, insert: cut.insert }]
      : changesIn(gone, come, from).map((part) => {
          const edge = spanOf(a.slice(part.from, part.to), part.insert);
          return { from: part.from + edge.from, to: part.from + edge.to, insert: edge.insert };
        });
  });
}
const words = (text: string) => text.split(/(?<=\s)(?=\S)|(?<=\S)(?=\s)/);

/** What differs between two lists of pieces, by their longest common run, at offsets from `at`. */
function changesIn(was: string[], now: string[], at: number): Span[] {
  const [n, m] = [was.length, now.length];
  // Read from the end, so that the walk below goes forward.
  const common = new Uint16Array((n + 1) * (m + 1));
  const cell = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      common[cell(i, j)] =
        was[i] === now[j]
          ? common[cell(i + 1, j + 1)]! + 1
          : Math.max(common[cell(i + 1, j)]!, common[cell(i, j + 1)]!);
  const spans: Span[] = [];
  let [i, j] = [0, 0];
  const same = () => i < n && j < m && was[i] === now[j];
  while (i < n || j < m) {
    if (same()) {
      at += was[i++]!.length;
      j++;
      continue;
    }
    const [from, added] = [at, [] as string[]];
    while ((i < n || j < m) && !same()) {
      if (j < m && (i >= n || common[cell(i, j + 1)]! >= common[cell(i + 1, j)]!))
        added.push(now[j++]!);
      else at += was[i++]!.length;
    }
    spans.push({ from, to: at, insert: added.join('') });
  }
  return spans;
}

/** The document's own title: the words of the heading it opens with, where it opens with one. */
export const openingTitle = (text: string) =>
  /^\s*# +([^\n]*)/.exec(text)?.[1]?.replace(/\s+#*\s*$/, '') || null;

/** The fixed sentence that asks Pi for a first draft, as the person could say it; the note says which. */
export const draftAsk = (kind: string) =>
  `Draft ${kind} from this board, in the outcome open beside it. Name it, and write one section a call.`;

export interface Handoff {
  projectId: string;
  boardId: string;
  title: string;
  origin: string;
}
/** A title stays on its line and in its quotes, and a deep link refuses control characters. */
const named = (title: string) =>
  title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replaceAll('"', "'");
const foot = (origin: string) =>
  `Ask me only what the plan leaves open.\nNo Merv tools? ${origin}/ui/settings/keys explains \`claude mcp add\`.`;

/** The prompt for the receiving agent, naming the frozen plan. */
export const handoffPrompt = ({ projectId, boardId, title, origin }: Handoff, artifactId: string) =>
  `Merv handoff: project ${projectId}, board ${boardId}, plan ${artifactId} ("${named(title)}").
Use the Merv MCP tools and pass projectId ${projectId} to every call. Read the plan with
artifact.read content ${artifactId}; it was agreed on the board, so carry it out rather than
re-planning it. board.read get ${boardId} says what the board holds; board.read look ${boardId}
shows it. ${foot(origin)}`;

/** The same for one who may not keep a file: the plan goes with it. */
export const handoffInline = ({ projectId, boardId, title, origin }: Handoff, text: string) =>
  `Merv handoff: project ${projectId}, board ${boardId}, plan "${named(title)}", given below.
Use the Merv MCP tools and pass projectId ${projectId} to every call. It was agreed on the board,
so carry it out rather than re-planning it. board.read get ${boardId} says what the board holds;
board.read look ${boardId} shows it. ${foot(origin)}

${text}`;

/** Claude Code's own link: its parser (2.1.310) takes q up to 5,000 characters, newlines included. */
export const deepLink = (prompt: string) => `claude-cli://open?q=${encodeURIComponent(prompt)}`;
