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

/** The acts the verb table names, by tool; two of them read the input to know which act. */
const ACTS: Record<string, (input: Input) => string> = {
  'session.dispatch': (input) => (input.enabled === false ? 'Pause dispatch' : 'Start dispatch'),
  'session.halt': (input) => (input.sessionId ? 'Halt lease' : 'Halt all leases'),
  'research.advance': () => 'Start next step',
  'review.start': () => 'Claim review',
  'review.submit': () => 'Submit verdict',
  'task.submit_delivery': () => 'Submit delivery',
  'sandbox.extend': () => 'Extend lease',
  'sandbox.release': () => 'Release machine',
  // What research.create makes is a cycle.
  'research.create': () => 'New cycle',
};

/**
 * The act a call performs: the table's words where it names the act, `New <object>` for anything
 * that creates one, and otherwise the tool's own words — an action with an underscore says itself
 * (`usage.set_budget` is `Set budget`), any other comes before its object (`research.end` is
 * `End research`).
 */
export function actOf(name: string, input: unknown): string {
  const named = ACTS[name];
  if (named) return named(fields(input));
  const [action = name, object] = name.split('.').reverse();
  if (object && action === 'create') return `New ${spaced(object)}`;
  return sentence(object && !action.includes('_') ? `${action} ${spaced(object)}` : spaced(action));
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
 * by the record, since what it holds is shown as that record's name — `sessionId` is `Session`,
 * `artifactIds` is `Artifacts` — and a bare `id` is the record the tool acts on.
 */
export function labelOf(name: string, key: string): string {
  const said = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .toLowerCase();
  const object = name.split('.').at(-2);
  return sentence(said === 'id' && object ? spaced(object) : said.replace(/ id(s?)$/, '$1'));
}

/** The input as facts in its own order, with its machinery and anything empty left out. */
export function factsOf(name: string, input: unknown): Fact[] {
  return Object.entries(fields(input)).flatMap(([key, value]): Fact[] => {
    if (MACHINERY.has(key) || value === null || value === undefined || value === '') return [];
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
 * What Run tells the agent in the person's name (`run` in views/pi.tsx): a result, at most TOLD
 * characters of its JSON; the sentence that stands for a result shown only to the person; a
 * refusal and why; and research.advance's own receipt, which ends by saying where to read on.
 */
const RAN = /^Ran (\S+): ([^]*)$/;
const SECRET = /^Ran (\S+); its result is shown only to me\.$/;
const REFUSED = /^(\S+) was refused: ([^]*)$/;
const ADVANCED = '. Re-read research.get and workflow.status_and_next for current details.';
export const TOLD = 4000;
const parses = (text: string) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/** What came back for a call the person ran: its result as it was told, if any, or the refusal. */
export type Receipt = { proposal: PiProposal } & ({ result?: string } | { refused: string });

/**
 * The receipt the first message of turn `at` is, or null where the person wrote it. It must say
 * exactly what Run says, and answer a call that ran among the latest the agent proposed before it:
 * the only cards that offer Run. A receipt that waited in the composer and went with words of
 * the person's own after it is theirs, and so is a result that neither parses nor was cut short.
 */
export function receiptOf(commands: PiCommand[], at: number): Receipt | null {
  const message = commands[at]?.messages[0];
  if (message?.role !== 'user' || message.text.includes('\n\n')) return null;
  const { text } = message;
  const [secret, ran, refused] = [SECRET.exec(text), RAN.exec(text), REFUSED.exec(text)];
  const tool = (secret ?? ran ?? refused)?.[1];
  if (!tool) return null;
  const proposal = commands
    .slice(0, at)
    .filter((command) => command.proposals?.length)
    .at(-1)
    ?.proposals?.find((call) => call.name === tool && call.ran);
  if (!proposal) return null;
  if (secret) return { proposal };
  if (refused) return { proposal, refused: refused[2]! };
  const told = ran![2]!;
  const result =
    tool === 'research.advance' && told.endsWith(ADVANCED) ? told.slice(0, -ADVANCED.length) : told;
  return result.length === TOLD || parses(result) ? { proposal, result } : null;
}
