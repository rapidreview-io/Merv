/**
 * What an outcome's pane reckons with text (views/board-outcome.tsx). The person's typing reaches
 * Board as one hunk, in the paper's contract: a find occurring exactly once, and what replaces it.
 * Whatever else moved the text meanwhile, that same hunk is applied to it on the page.
 */

/** How much two texts share at each end, never parting a surrogate pair. */
const edges = (a: string, b: string) => {
  const most = Math.min(a.length, b.length);
  let head = 0;
  while (head < most && a[head] === b[head]) head++;
  if (head && /[\ud800-\udbff]/.test(a[head - 1]!)) head--;
  let tail = 0;
  while (tail < most - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (tail && /[\udc00-\udfff]/.test(a[a.length - tail]!)) tail--;
  return { head, tail };
};

/**
 * What turned `saved` into `draft`, widened a line at a time until its find occurs once. Null
 * where there is nothing to find, as in an empty text.
 */
export function hunkOf(saved: string, draft: string) {
  const { head, tail } = edges(saved, draft);
  let [from, to] = [head, saved.length - tail];
  const once = () => {
    const find = saved.slice(from, to);
    return !!find && saved.indexOf(find) === saved.lastIndexOf(find);
  };
  while (!once() && (from || to < saved.length)) {
    from = from > 1 ? saved.lastIndexOf('\n', from - 2) + 1 : 0;
    const end = saved.indexOf('\n', to + 1);
    to = end < 0 ? saved.length : end;
  }
  if (!saved) return null;
  return {
    find: saved.slice(from, to),
    replace: draft.slice(from, draft.length - (saved.length - to)),
  };
}

/**
 * `mine`, written against `base`, on what the text has become. Where the same words were changed
 * both ways the last hunk wins, which is the person's: it is what they are looking at, and what
 * the other wrote elsewhere stays.
 */
export function rebased(base: string, mine: string, theirs: string): string {
  if (mine === base || mine === theirs) return theirs;
  if (theirs === base) return mine;
  if (!base) return `${theirs}\n\n${mine}`;
  const { find, replace } = hunkOf(base, mine)!;
  const at = theirs.indexOf(find);
  if (at >= 0 && at === theirs.lastIndexOf(find))
    return theirs.slice(0, at) + replace + theirs.slice(at + find.length);
  const [m, t] = [edges(base, mine), edges(base, theirs)];
  const from = Math.min(m.head, t.head);
  const after = Math.min(m.tail, t.tail);
  return (
    theirs.slice(0, from) +
    mine.slice(from, mine.length - after) +
    theirs.slice(theirs.length - after)
  );
}

/** Where a caret stands once `was` has become `now`: text before it moves it, text after does not. */
export function caretAfter(was: string, now: string, at: number): number {
  const { head, tail } = edges(was, now);
  if (at <= head) return at;
  return at >= was.length - tail ? at + now.length - was.length : now.length - tail;
}

export interface Handoff {
  projectId: string;
  boardId: string;
  title: string;
  origin: string;
}
/** A title stays on its line of the prompt, and a deep link refuses control characters in it. */
const named = (title: string) => title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
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
