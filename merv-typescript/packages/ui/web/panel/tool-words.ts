import { type Step } from './chat-events';

const TOOL_NAME =
  /^(Bash|Read|Edit|MultiEdit|Write|NotebookEdit|NotebookRead|Grep|Glob|LS|WebFetch|WebSearch|Task|Agent|TodoWrite)\b:?\s*/;
const base = (path: string) =>
  path
    .replace(/[\s'"]+$/, '')
    .split('/')
    .filter(Boolean)
    .at(-1) ?? path;

/** The browser's tools, as what they did. */
const BROWSER: Record<string, string> = {
  browser_open: 'Opened a page',
  browser_read: 'Read the page',
  browser_look: 'Looked at the page',
  browser_clip: 'Kept a source',
  browser_act: 'Used the page',
  board_look: 'Looked at the board',
  board_get: 'Read the board',
  board_draw: 'Drew on the board',
};

/** Merv's own tools (the hosted agent's), as what they did: by tool and action, else by tool. */
const MERV: Record<string, string> = {
  'board_read.get': 'Read the board',
  'board_read.look': 'Looked at the board',
  'board_read.list': 'Listed the boards',
  'board_read.rewind': "Read the board's history",
  'board_read.transcript': 'Read a session',
  board_read: 'Read the board',
  board_write: 'Drew on the board',
  'desk_read.thread': 'Read a session',
  'desk_read.report': 'Read a session',
  'desk_read.question': 'Read a question',
  'desk_read.asks': 'Read what waits on you',
  'desk_read.configuration': 'Read the models',
  desk_read: 'Read your projects',
  'desk_write.manager': 'Asked a manager',
  'desk_write.message': 'Messaged a session',
  'desk_write.start': 'Started a session',
  'desk_write.stop': 'Stopped a session',
  'desk_write.unit': 'Sent work to your Mac',
  'desk_write.answer': 'Passed on your answer',
  desk_write: 'Worked with your Mac',
  web_read: 'Searched the web',
  'browser.open': 'Opened a page',
  'browser.act': 'Used the page',
  'browser.look': 'Looked at the page',
  'browser.shot': 'Put a page on the board',
  browser: 'Read the page',
  artifact_read: 'Read a file',
  artifact_write: 'Saved a file',
  project_read: 'Read the project',
  persona_read: 'Read your preferences',
  persona_edit: 'Changed a preference',
};
/** Merv's research product's own tools: what each noun is called when said aloud. */
const THINGS: Record<string, [one: string, many: string]> = {
  artifact: ['a file', 'the files'],
  board: ['the board', 'the boards'],
  code: ['the code', 'the code'],
  experiment: ['an experiment', 'the experiments'],
  feed: ['the feed', 'the feed'],
  history: ['the history', 'the history'],
  intake: ['an intake', 'the intakes'],
  metrics: ['the metrics', 'the metrics'],
  paper: ['the paper', 'the paper'],
  project: ['the project', 'the project'],
  autoresearch: ['the autoresearch', 'the autoresearch'],
  report: ['a report', 'the reports'],
  research: ['the research', 'the research rounds'],
  review: ['a review', 'the reviews'],
  session: ['a session', 'the sessions'],
  task: ['a task', 'the tasks'],
  workflow: ['the work', 'the work'],
  system: ['the system', 'the system'],
};
/** What a write's action did, said in the past: "Created a task". */
const DID: Record<string, string> = {
  create: 'Created',
  draw: 'Drew on',
  delete: 'Deleted',
  submit: 'Submitted',
  message: 'Messaged',
  set: 'Changed',
  update: 'Changed',
  edit: 'Changed',
  start: 'Started',
  end: 'Ended',
  advance: 'Moved on',
  claim: 'Claimed',
};
/** One of Merv's tools by its noun and action, where the table above has no line of its own. */
function mervNoun(tool: string, action: string): string | undefined {
  if (tool === 'screen_read' || tool === 'pi_screen') return 'Looked at your screen';
  if (tool === 'web_read') return 'Searched the web';
  if (/^sandboxes_/.test(tool)) return 'Used a machine';
  const [, noun = '', verb = ''] =
    /^([a-z]+)_(read|write|look|status.*|status_and_next|[a-z_]+)$/.exec(tool) ?? [];
  const thing = THINGS[noun];
  if (!thing) return undefined;
  if (verb === 'look') return `Looked at ${thing[0].replace(/^an? /, 'the ')}`;
  if (verb.startsWith('status')) return `Checked ${thing[1]}`;
  if (verb === 'read')
    return action === 'list' || action === 'find'
      ? `Listed ${thing[1]}`
      : `Read ${thing[0].replace(/^an? /, 'the ')}`;
  if (verb === 'write')
    return `${DID[action] ?? 'Changed'} ${DID[action] ? thing[0] : thing[0].replace(/^an? /, 'the ')}`;
  return undefined;
}
/** A step of Merv's own, by its tool and the action it took: its title is `merv:<tool>.<action>`. */
export const MERV_STEP = 'merv:';
function mervSaid(title: string): string {
  const [tool = '', action = ''] = title.slice(MERV_STEP.length).split('.');
  return (
    MERV[`${tool}.${action}`] ??
    MERV[tool] ??
    mervNoun(tool, action) ??
    (tool.replace(/_/g, ' ') || 'Used a tool')
  );
}
/** What kind of step a tool of Merv's is, for its glyph and for whether its output opens. */
export function mervKind(tool: string): Step['kind'] {
  if (tool === 'web_read' || tool.startsWith('browser')) return 'web';
  if (/^sandboxes_/.test(tool)) return 'run';
  if (/_(read|look)$|^screen_read$|_status/.test(tool)) return 'read';
  if (/_write$/.test(tool)) return 'edit';
  return 'tool';
}

/** A step still under way, or waiting on the person, says so: "Editing app.tsx", not "Edited". */
const UNDER_WAY: [RegExp, string][] = [
  [/^Read /, 'Reading '],
  [/^Edited /, 'Editing '],
  [/^Searched /, 'Searching '],
  [/^Ran /, 'Running '],
  [/^Looked up /, 'Looking up '],
];
const tense = (said: string, done: boolean) =>
  done ? said : UNDER_WAY.reduce((text, [past, now]) => text.replace(past, now), said);

/** A tool call in a few plain words, the way a person would say what happened: "Read app.tsx". */
function label(step: Step, live = false): string {
  return tense(said(step), step.done || !live);
}

export function said(step: Step): string {
  if (step.title.startsWith(MERV_STEP)) return mervSaid(step.title);
  // A helper is what it was sent to do, in its own words.
  if (step.agent) return step.title.replace(/^(Task|Agent)\b:?\s*/, '').trim() || 'Task';
  const rest = step.title.replace(TOOL_NAME, '').trim();
  const first = rest.split(/\s+/)[0] ?? '';
  switch (step.kind) {
    case 'read':
      return `Read ${base(first)}`;
    case 'edit':
      return `Edited ${base(first)}`;
    case 'search':
      return `Searched ${rest.length > 32 ? `${rest.slice(0, 32)}…` : rest}`;
    case 'run': {
      return didWhat(unshell(rest));
    }
    case 'web':
      return `Looked up ${/https?:\/\/([^/\s]+)/.exec(rest)?.[1] ?? rest.slice(0, 32)}`;
    case 'think':
      return 'Thinking';
    default: {
      // mcp__server__tool_name and server.tool_name read as the tool's own words.
      const name = step.title.split(/\s+/)[0] ?? step.title;
      const tool = (name.split('__').at(-1) ?? name).split('.').at(-1) ?? name;
      return BROWSER[tool] ?? tool.replace(/_/g, ' ');
    }
  }
}

/** What the board handed over, as the person would say it: never the agent's instructions, ids or pasted material. */
export const boardAsk = (text: string) =>
  text
    .split(/\n{2,}/)
    .find((part) => !/^Start by looking at where this comes/.test(part))
    ?.split('\n')[0] ?? text;

/** Codex runs each command inside a login shell: what counts is the command it was given. */
export const unshell = (text: string) => {
  const line = text.replace(/^(?:Run|exec)\s+/, '');
  const shell = /^(?:\/bin\/)?(?:zsh|bash|sh) -l?c\s+(?:(['"])([\s\S]*)\1|([\s\S]*))$/.exec(line);
  return (shell?.[2] ?? shell?.[3] ?? line).replace(/^cd\s+\S+\s*(&&|;)\s*/, '');
};

/** A shell command as the thing it did: "Listed files", "Read app.tsx", "Ran the tests". Never the command. */
export function didWhat(command: string): string {
  const first =
    command
      .replace(/\s+/g, ' ')
      .trim()
      .split(/\s*(?:&&|\|\||;|\|)\s*/)[0] ?? '';
  const [name = '', ...args] = first.split(' ');
  const file = args
    .filter((arg) => !arg.startsWith('-'))
    .map(base)
    .find((arg) => /\.\w{1,5}$/.test(arg));
  if (/^(pwd|ls|tree|find|fd)$/.test(name) || /^(rg|grep) --files/.test(first))
    return 'Listed files';
  if (/^(rg|grep|ag|ack)$/.test(name)) return 'Searched files';
  if (/^(cat|head|tail|less|bat|sed|awk|wc|nl)$/.test(name))
    return file ? `Read ${file}` : 'Read files';
  if (/^(python3?|node|ruby|perl|bash|sh|zsh|deno|bun)$/.test(name))
    return file && !/^-/.test(args[0] ?? '') ? `Ran ${file}` : 'Ran a script';
  if (
    /^(npm|pnpm|yarn|npx|cargo|go|make|pytest|jest|vitest|mocha|tsc|eslint|prettier)$/.test(name)
  ) {
    const task = args.find((arg) => !arg.startsWith('-')) ?? '';
    return /test/.test(task) || /^(pytest|jest|vitest|mocha)$/.test(name)
      ? 'Ran the tests'
      : /tsc|lint|check|eslint|prettier/.test(`${name} ${task}`)
        ? 'Checked the code'
        : /build/.test(task)
          ? 'Built it'
          : `Ran ${name}${task ? ` ${task}` : ''}`;
  }
  if (name === 'git') return `Git ${args.find((arg) => !arg.startsWith('-')) ?? ''}`.trim();
  if (/^(mkdir|touch|cp|mv|rm|chmod|ln)$/.test(name))
    return file ? `Changed ${file}` : 'Changed files';
  if (/^(curl|wget|http)$/.test(name))
    return `Fetched ${/https?:\/\/([^/\s]+)/.exec(first)?.[1] ?? 'a page'}`;
  if (/^(echo|printf|test|\[|true|which|command|type|env|export)$/.test(name))
    return 'Checked something';
  return `Ran ${name}`;
}

/** Neighbouring calls of one kind are one line: "Read 3 files", "Edited app.tsx, styles.css". */
export function groupLabel(steps: Step[], live = false): string {
  if (steps.length === 1) return label(steps[0]!, live);
  return tense(groupSaid(steps), !live || steps.every((step) => step.done));
}

function groupSaid(steps: Step[]): string {
  const names = [...new Set(steps.map((s) => said(s).replace(/^(Looked up|\S+)\s/, '')))];
  const listed =
    names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
  switch (steps[0]!.kind) {
    case 'read':
      return `Read ${names.length} files`;
    case 'edit':
      return `Edited ${listed}`;
    case 'search':
      return `Searched ${steps.length} times`;
    case 'run':
      return `${said(steps[0]!)} ×${steps.length}`;
    case 'web':
      return `Looked up ${listed}`;
    default:
      return `${steps.length} steps`;
  }
}
