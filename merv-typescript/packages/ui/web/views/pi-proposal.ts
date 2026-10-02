/**
 * A call the agent proposed, in the product's words: the act it performs, titled from the verb
 * table (docs/UI_DESIGN.md, "Verbs"), and its input as facts a person reads. Then what Run told
 * the agent in the person's name, recognised again so the transcript draws it as what came back
 * and never as something the person typed. Pure: names, inputs and messages in, words out.
 */
import type { PiCommand, PiProposal } from '../pi-stream';

type Input = Record<string, unknown>;
const fields = (value: unknown): Input =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Input) : {};
const spaced = (name: string) => name.replaceAll('_', ' ');
const sentence = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

/** What the product calls a record a tool names otherwise. */
const NOUN: Record<string, string> = {
  artifact: 'file',
  research: 'cycle',
  fleet: 'machine',
  instance: 'unit',
};
const noun = (object: string) => NOUN[object] ?? spaced(object);

/** The acts the verb table names, by tool; some read the input to know which act. */
const ACTS: Record<string, (input: Input) => string> = {
  'session.dispatch': (input) => (input.enabled === false ? 'Pause dispatch' : 'Start dispatch'),
  'session.halt': (input) => (input.sessionId ? 'Halt lease' : 'Halt all leases'),
  'research.advance': () => 'Start next step',
  'review.start': () => 'Claim review',
  'review.submit': () => 'Submit verdict',
  'task.submit_delivery': () => 'Submit delivery',
  'task.mark_failed': () => 'Mark task failed',
  'artifact.read': ({ mode }) => (mode === 'download' ? 'Download file' : 'Read file'),
  'experiment.transition': ({ transition }) =>
    ({ abandon: 'Abandon experiment', mark_failed: 'Mark experiment failed' })[
      String(transition)
    ] ?? sentence(spaced(String(transition))),
  'code.publication.control': ({ action }) => `${sentence(String(action))} publication`,
  'code.local.bind': () => 'Bind repository',
  'fleet.workflow_retry': () => 'Retry on Fleet',
  'sandbox.extend': () => 'Extend lease',
  'sandbox.release': () => 'Release machine',
};
/** The input an act's own words have said, which its facts do not say again. */
const SAID: Record<string, string> = {
  'session.dispatch': 'enabled',
  'artifact.read': 'mode',
  'experiment.transition': 'transition',
  'code.publication.control': 'action',
};

/**
 * The act a call performs: the table's words where it names the act, `New <object>` for anything
 * that creates one, and otherwise the tool's own words — an action with an underscore says itself
 * (`usage.set_budget` is `Set budget`), any other comes before its object, in the product's word
 * for it (`research.end` is `End cycle`, `artifact.read` is `Read file`).
 */
export function actOf(name: string, input: unknown): string {
  const named = ACTS[name];
  if (named) return named(fields(input));
  const [action = name, object] = name.split('.').reverse();
  if (object && action === 'create') return `New ${noun(object)}`;
  return sentence(object && !action.includes('_') ? `${action} ${noun(object)}` : spaced(action));
}

/** What makes a request safe to send twice: machinery, never a fact the person reads. */
const MACHINERY = new Set(['requestId', 'expectedRevision']);

/** One fact of an input: words to read, a row of plain values, or something nested to unfold. */
export type Fact = { key: string; label: string } & (
  { text: string } | { list: string[] } | { tree: object }
);
const plain = (value: unknown) =>
  typeof value === 'boolean'
    ? value
      ? 'Yes'
      : 'No'
    : typeof value === 'number' || typeof value === 'string'
      ? String(value)
      : undefined;

/**
 * A key in words: `ownMachines` reads `Own machines`. A field that holds a record's id is named
 * by the record, in the product's word for it, since what it holds is shown as that record's
 * name — `sessionId` is `Session`, `artifactIds` is `Files` — and a bare `id` is the record the
 * tool acts on.
 */
export function labelOf(name: string, key: string): string {
  const said = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .toLowerCase();
  const object = name.split('.').at(-2);
  const [, words, many = ''] = /^(.*?)(?: id(s?))?$/.exec(
    said === 'id' && object ? `${object} id` : said,
  )!;
  return sentence(noun(words!) + many);
}

/** The input as facts in its own order, without its machinery, what the act said, or anything empty. */
export function factsOf(name: string, input: unknown): Fact[] {
  return Object.entries(fields(input)).flatMap(([key, value]): Fact[] => {
    if (
      MACHINERY.has(key) ||
      key === SAID[name] ||
      value === null ||
      value === undefined ||
      value === ''
    )
      return [];
    const label = labelOf(name, key);
    const text = plain(value);
    if (text !== undefined) return [{ key, label, text }];
    if (typeof value !== 'object' || !Object.keys(value).length) return [];
    const list = Array.isArray(value) ? value.map(plain) : [];
    return list.length && list.every((item) => item !== undefined)
      ? [{ key, label, list: list as string[] }]
      : [{ key, label, tree: value }];
  });
}

/*
 * What Run tells the agent in the person's name (`run` in views/pi.tsx): a result, as much of its
 * JSON as Run sends; the sentence that stands for a result shown only to the person; a refusal and
 * why; and research.advance's own receipt, which ends by saying where to read on.
 */
const RAN = /^Ran (\S+): ([^]*)$/;
const SECRET = /^Ran (\S+); its result is shown only to me\.$/;
const REFUSED = /^(\S+) was refused: ([^]*)$/;
const ADVANCED = '. Re-read research.get and workflow.status_and_next for current details.';

/** What came back for a call the person ran: its result as it was told, if any, or the refusal. */
export type Receipt = { proposal: PiProposal } & ({ result?: string } | { refused: string });

/** What a turn's first message tells of a call, where it says what Run says. */
function toldOf(command?: PiCommand) {
  const message = command?.messages[0];
  if (message?.role !== 'user' || message.text.includes('\n\n')) return null;
  const [secret, ran, refused] = [SECRET, RAN, REFUSED].map((said) => said.exec(message.text));
  const tool = (secret ?? ran ?? refused)?.[1];
  if (!tool) return null;
  if (secret) return { tool };
  if (refused) return { tool, refused: refused[2]! };
  const told = ran![2]!;
  return { tool, result: told.endsWith(ADVANCED) ? told.slice(0, -ADVANCED.length) : told };
}

/**
 * The receipt the first message of turn `at` is, or null where the person wrote it. It must say
 * what Run says, and answer a call that ran among the latest the agent proposed before it: the
 * only cards that offer Run. Calls of one tool are answered in the order they ran. A receipt that
 * waited in the composer and went with words of the person's own after it is theirs.
 */
export function receiptOf(commands: PiCommand[], at: number): Receipt | null {
  const told = toldOf(commands[at]);
  if (!told) return null;
  const { tool, ...outcome } = told;
  const from = commands
    .slice(0, at)
    .map((command) => !!command.proposals?.length)
    .lastIndexOf(true);
  const ran = (commands[from]?.proposals ?? [])
    .filter((call) => call.name === tool && call.ran)
    .sort((a, b) => a.ran!.at.localeCompare(b.ran!.at));
  const earlier = commands.slice(from + 1, at).filter((turn) => toldOf(turn)?.tool === tool);
  const proposal = ran[Math.min(earlier.length, ran.length - 1)];
  return proposal ? { proposal, ...outcome } : null;
}
