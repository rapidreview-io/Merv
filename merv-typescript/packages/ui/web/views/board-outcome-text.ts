/**
 * What an outcome's pane reckons with text (views/board-outcome.tsx). The person's typing reaches
 * Board as one hunk, in the paper's contract: a find occurring exactly once, and what replaces it.
 * Whatever else moved the text meanwhile, that same hunk is applied to it on the page.
 */

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

/** Where a caret stands once `was` has become `now`: text before it moves it, text after does not. */
export function caretAfter(was: string, now: string, at: number): number {
  const { head, tail } = edges(was, now);
  if (at <= head) return at;
  if (at >= was.length - tail) return at + now.length - was.length;
  // Changes on both sides of it: it stays with the words around it, while they stand.
  const before = was.slice(Math.max(0, at - 40), at);
  const found = now.indexOf(before + was.slice(at, at + 40));
  return found < 0 ? now.length - tail : found + before.length;
}

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
