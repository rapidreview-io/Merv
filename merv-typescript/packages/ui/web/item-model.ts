/**
 * What an item's card says, worked out without drawing it: a task's or an experiment's state
 * as one of four marks, the question it answers in one line, its plan as arms or steps, what it
 * found in one sentence and whether it passed. Pure, so the list, the page, the board and the
 * autoresearch timeline say it the same way, and a test reads it without a browser.
 */

/** The four marks every task and experiment wears, wherever it is shown. */
export type ItemState = 'working' | 'needs' | 'failed' | 'done';
export const STATE_WORDS: Record<ItemState, string> = {
  working: 'Working',
  needs: 'Needs you',
  failed: 'Failed',
  done: 'Done',
};

/** Ended well is done; ended any other way failed; waiting on a person needs you; else working. */
export function itemState(item: {
  settled?: boolean;
  failed?: boolean;
  /** A person holds it up: a question, an approval, a pause. */
  attention?: boolean;
}): ItemState {
  if (item.failed) return 'failed';
  if (item.settled) return 'done';
  if (item.attention) return 'needs';
  return 'working';
}

/** The first sentence of a text, on one line, at most `max` characters. */
export function oneLine(text: string | null | undefined, max = 160): string {
  const plain = (text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

export interface Arm {
  name: string;
  /** What it varies, or how many seeds stand behind it. */
  detail?: string;
}
export interface Plan {
  question?: string;
  arms: Arm[];
  measure?: string;
  success?: string;
  budget?: string;
}

/** The lines of a Markdown section, by its heading's words, up to the next heading of its rank. */
function section(markdown: string, heading: RegExp): string | undefined {
  const lines = markdown.split('\n');
  const at = lines.findIndex((line) => /^#{1,4}\s/.test(line) && heading.test(line));
  if (at < 0) return undefined;
  const rank = /^#+/.exec(lines[at])![0].length;
  const end = lines.findIndex(
    (line, i) => i > at && /^#{1,4}\s/.test(line) && /^#+/.exec(line)![0].length <= rank,
  );
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
}
const field = (markdown: string, name: string) =>
  new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${name}(?:\\*\\*)?\\s*:\\s*(.+)$`, 'im')
    .exec(markdown)?.[1]
    ?.replace(/\*\*/g, '')
    .trim();

/**
 * An experiment plan in the shape its brief asks for: `Question:`, the `| Arm | What it varies |`
 * table, `Primary measure:`, `Success:` and `Budget:`. Whatever is missing stays out.
 */
export function parsePlan(markdown: string | undefined): Plan {
  if (!markdown) return { arms: [] };
  const arms: Arm[] = [];
  const lines = markdown.split('\n');
  const head = lines.findIndex((line) => /^\s*\|\s*arm\b/i.test(line));
  if (head >= 0)
    for (const line of lines.slice(head + 1)) {
      if (!/^\s*\|/.test(line)) break;
      const cells = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.replace(/[*_`]/g, '').trim());
      if (cells.every((cell) => /^:?-*:?$/.test(cell))) continue;
      if (cells[0]) arms.push({ name: cells[0], ...(cells[1] && { detail: cells[1] }) });
    }
  const question = field(markdown, 'Question');
  return {
    ...(question && !/^<.*>$/.test(question) && { question }),
    arms: arms.filter((arm) => !/^<.*>$/.test(arm.name)).slice(0, 8),
    ...optional('measure', field(markdown, 'Primary measure')),
    ...optional('success', field(markdown, 'Success')),
    ...optional('budget', field(markdown, 'Budget')),
  };
}
const optional = <K extends string>(key: K, value: string | undefined) =>
  value && !/^<.*>$/.test(value) ? ({ [key]: value } as Record<K, string>) : {};

/** What a report found, in one sentence: its Summary's first, else its first. */
export function findingOf(markdown: string | undefined): string | undefined {
  if (!markdown) return undefined;
  // A rendered report opens with YAML front matter: its answer is below it.
  markdown = markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const summary = section(markdown, /summary|answer|result|what (was )?found/i);
  const line = oneLine(summary ?? markdown.replace(/^#.*$/m, ''));
  return line || undefined;
}

/**
 * Arms from the runs an item logged, where its plan names none: runs are grouped by name with
 * their seed taken off (`baseline-seed2` is `baseline`), so three seeds read as one arm ×3.
 */
export function armsOfRuns(runs: readonly { run: string }[]): Arm[] {
  const groups = new Map<string, number>();
  for (const { run } of runs) {
    const arm = run.replace(/[-_ .]?(seed|s|rep|trial|run)[-_ ]?\d+$/i, '') || run;
    groups.set(arm, (groups.get(arm) ?? 0) + 1);
  }
  return [...groups].map(([name, n]) => ({ name, ...(n > 1 && { detail: `×${n} seeds` }) }));
}

/** One step of an item's way, as the progress trail draws it. */
export interface Step {
  label: string;
  at: 'done' | 'now' | 'next';
}
const STAGES: Record<'experiment' | 'task', [string, string][]> = {
  experiment: [
    ['planned', 'Design'],
    ['design_review', 'Design review'],
    ['running', 'Run'],
    ['experiment_review', 'Results review'],
  ],
  task: [
    ['in_progress', 'Work'],
    ['in_review', 'Review'],
  ],
};
/** Its stages in order, the one it stands at marked, and Done at the end. */
export function stagesOf(kind: 'experiment' | 'task', state: string, ended: boolean): Step[] {
  const stages = STAGES[kind];
  const now = ended ? stages.length : stages.findIndex(([name]) => name === state);
  return [
    ...stages.map(([, label], i): Step => ({
      label,
      at: i < now || now < 0 ? (now < 0 ? 'next' : 'done') : i === now ? 'now' : 'next',
    })),
    { label: 'Done', at: ended ? 'done' : 'next' },
  ];
}
/** A stage's own word for a workflow state, else the state's name in plain words. */
export function stageWord(kind: 'experiment' | 'task', state: string): string {
  return (
    STAGES[kind].find(([name]) => name === state)?.[1] ??
    state.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  );
}

/** The retained key figure among an item's files: what metrics.write export kept. */
export const isMetricsFigure = (path: string) =>
  /(^|\/)metrics\/trackio-[^/]*\.(png|jpe?g|webp|svg)$/i.test(path);
export const isMetricsData = (path: string) => /(^|\/)metrics\/trackio-[^/]*\.json$/i.test(path);

/** Dollars, as a receipt says them: cents under a hundred, whole dollars above. */
export function usd(value: number | undefined | null): string | undefined {
  if (value === undefined || value === null || !Number.isFinite(value)) return undefined;
  return value >= 100 ? `$${Math.round(value).toLocaleString('en-US')}` : `$${value.toFixed(2)}`;
}
