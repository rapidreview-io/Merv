/**
 * A call the agent proposed, in the product's words: the act it performs, titled by the tool's
 * owner (docs/UI_DESIGN.md, "Verbs"), and its input as facts a person reads. Then what Run told
 * the agent in the person's name, recognised again so the transcript draws it as what came back
 * and never as something the person typed. Pure: names, inputs and messages in, words out.
 */
import type { PiCommand, PiProposal } from '@merv/pi/models';

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

/**
 * The act a call performs: its tool's own title where the tool's owner declared one (`act`), `New
 * <object>` for anything that creates one, and otherwise the tool's own words — an action with an
 * underscore says itself (`usage.set_budget` is `Set budget`), any other comes before its object,
 * in the product's word for it (`research.end` is `End cycle`, `fleet.halt` is `Halt machine`).
 */
export function actOf({ name, act }: Pick<PiProposal, 'name' | 'act'>): string {
  if (act) return act.title;
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
export function factsOf({ name, input, act }: Pick<PiProposal, 'name' | 'input' | 'act'>): Fact[] {
  return Object.entries(fields(input)).flatMap(([key, value]): Fact[] => {
    if (
      MACHINERY.has(key) ||
      key === act?.says ||
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

/**
 * The call whose outcome the first message of turn `at` told the agent, or null where the person
 * wrote it: the message is exactly what Pi kept as told (`ran.told`) for a call among the latest
 * the agent proposed before it, the only cards that offer Run. Calls told alike are answered in
 * the order they ran. A receipt that waited in the composer and went with the person's own words
 * after it is theirs.
 */
export function receiptOf(commands: PiCommand[], at: number): PiProposal | null {
  const told = (command?: PiCommand) => {
    const message = command?.messages[0];
    return message?.role === 'user' ? message.text : undefined;
  };
  const text = told(commands[at]);
  if (text === undefined) return null;
  const from = commands
    .slice(0, at)
    .map((command) => !!command.proposals?.length)
    .lastIndexOf(true);
  const ran = (commands[from]?.proposals ?? [])
    .filter((call) => call.ran?.told === text)
    .sort((a, b) => a.ran!.at.localeCompare(b.ran!.at));
  const earlier = commands.slice(from + 1, at).filter((turn) => told(turn) === text);
  return ran[Math.min(earlier.length, ran.length - 1)] ?? null;
}
