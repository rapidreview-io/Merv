/** The person owns their profile; chat history adds evidenced detail. */
import { z } from 'zod';
import { LOOK_NAMES, lookInstruction, type LookName } from './looks.js';
import { redact } from './redact.js';

// PostgreSQL jsonb rejects NUL and lone surrogates; the Unicode flag keeps emoji pairs intact.
const wellFormed = (text: string) => text.replace(/[\u0000\uD800-\uDFFF]/gu, '\uFFFD');
const text = z.string().transform(wellFormed);

/** Redact decoded strings, never serialized JSON (which may contain escaped quotes). */
export function redactPersona<T>(value: T): T {
  if (typeof value === 'string') return wellFormed(redact(value)) as T;
  if (Array.isArray(value)) return value.map(redactPersona) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [wellFormed(key), redactPersona(item)]),
    ) as T;
  return value;
}

/** Person first, then how to communicate and work with them. Answers keeps legacy tone/depth traits. */
export const GROUPS = [
  'person',
  'decisions',
  'avoid',
  'reading',
  'answers',
  'visual',
  'process',
] as const;
export const MAX_TRAITS = 24;
/** How Merv draws for them: a chosen look (protocol looks.ts), not an inference. */
export const VISUAL_STYLES = Object.fromEntries(
  LOOK_NAMES.map((name) => [name, lookInstruction(name)]),
) as Record<LookName, string>;
export type VisualStyle = LookName;
export const visualInstruction = (style: VisualStyle) => VISUAL_STYLES[style];
/** The only dials there are: four, each starting at the middle and dragged from there. Every other preference is a line. */
export const PRESETS: Record<
  (typeof GROUPS)[number],
  { id: string; name: string; left: string; right: string; instructions: [string, string] }[]
> = {
  person: [],
  reading: [
    {
      id: 'reading-length',
      name: 'length',
      left: 'brief',
      right: 'thorough',
      instructions: [
        'Answer briefly; the gist first, detail only when asked.',
        'Answer thoroughly, with the reasoning and the edge cases.',
      ],
    },
    {
      id: 'reading-format',
      name: 'format',
      left: 'prose',
      right: 'bullets',
      instructions: [
        'Use connected prose, one idea per paragraph.',
        'Use short bullets, one idea per item.',
      ],
    },
  ],
  visual: [],
  answers: [
    {
      id: 'answers-depth',
      name: 'depth',
      left: 'plain',
      right: 'technical',
      instructions: [
        'Explain in plain words, without jargon.',
        'Explain technically, with the exact terms and mechanisms.',
      ],
    },
  ],
  process: [
    {
      id: 'process-autonomy',
      name: 'autonomy',
      left: 'ask first',
      right: 'just do it',
      instructions: [
        'Ask before each step that changes something; wait for a yes.',
        'Act without asking on reversible work; ask only before destructive or outside actions.',
      ],
    },
  ],
  decisions: [],
  avoid: [],
};
/** Older ids a dial answers to: a saved value stays on its slider. */
export const DIAL_ALIASES: Record<string, string> = {
  'answers-length': 'reading-length',
  'process-initiative': 'process-autonomy',
};
const DIALS = new Map(
  Object.values(PRESETS)
    .flat()
    .map((preset) => [preset.id, preset]),
);
/** The dial a preference sits on, if it is one of the four. */
const presetOf = (item: Pick<Trait, 'id' | 'scale'>) =>
  item.scale === null ? undefined : DIALS.get(DIAL_ALIASES[item.id] ?? item.id);
/** The sentence a dial at scale means, with the leaning named. */
export const dialInstruction = (
  preset: { left: string; right: string; instructions: [string, string] },
  scale: number,
) =>
  scale === 0.5
    ? ''
    : `${preset.instructions[scale < 0.5 ? 0 : 1]} (${Math.round(scale * 100)}% toward ${preset.right})`.slice(
        0,
        140,
      );
/** A dial that is no longer one (tone, structure, examples, choices, density…) is read as a plain line when it leaned
 *  clearly, without its "(80% toward …)", and is not read at all when it sat near the middle. Stored data is untouched:
 *  editing the line saves it as a line; removing it removes it. An older id on a kept dial speaks with that dial's words. */
export function foldTrait(item: Trait): Trait | undefined {
  if (item.scale === null) return item;
  const preset = presetOf(item);
  if (preset)
    return DIAL_ALIASES[item.id] && item.scale !== 0.5
      ? {
          ...item,
          name: preset.name,
          left: preset.left,
          right: preset.right,
          instruction: dialInstruction(preset, item.scale),
        }
      : item;
  const instruction = item.instruction.replace(/\s*\(\d+% toward [^)]*\)\s*$/, '').trim();
  return Math.round(Math.abs(item.scale - 0.5) * 100) >= 20 && instruction
    ? { ...item, scale: null, left: null, right: null, instruction }
    : undefined;
}
const foldTraits = (traits: Trait[]) =>
  traits.map(foldTrait).filter((item): item is Trait => !!item);
const line = (max: number) =>
  text.pipe(
    z
      .string()
      .trim()
      .min(1)
      .max(max)
      .refine((text) => !/[\r\n]/.test(text), 'One line'),
  );
const words = (max: number) =>
  line(100).refine((text) => text.split(/\s+/).length <= max, `At most ${max} words`);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const evidence = z
  .object({
    quote: line(160),
    date,
    provider: z.enum(['claude', 'codex', 'person', 'merv']),
    project: line(120),
    kind: z.enum(['correction', 'praise', 'ruling', 'ask']),
  })
  .strict();
const inferredTrait = z
  .object({
    id: line(100),
    group: z.enum(GROUPS),
    name: words(4),
    value: words(3),
    scale: z.number().min(0).max(1).nullable(),
    left: words(3).nullable(),
    right: words(3).nullable(),
    instruction: z.union([line(140), z.literal('')]),
    evidence: z.array(evidence).min(1).max(3),
    confidence: z.number().min(0).max(1),
    lastSeen: date,
  })
  .strict()
  .refine(
    (trait) =>
      (trait.scale === null || !!(trait.left && trait.right)) &&
      (!!trait.instruction || trait.scale === 0.5),
    'Dials need endpoints; only neutral dials may have no instruction',
  );
export const trait = inferredTrait.innerType().extend({
  source: z.enum(['built', 'person', 'merv']),
  pinnedAt: z.string().datetime().nullable(),
});
export type Trait = z.infer<typeof trait>;
/** Deeper facts (what they build and value) are person traits: evidenced, editable and pinnable. */
// Released Macs cap roles by UTF-16 units; drop a high surrogate left by the cut.
export const person = z
  .object({
    role: text.transform((value) =>
      value
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160)
        .replace(/[\uD800-\uDBFF]$/, '')
        .trimEnd(),
    ),
    domains: z.array(line(80)).max(12),
    projects: z
      .array(
        z
          .object({ name: line(120), what: text.pipe(z.string().max(300)), lastSeen: date })
          .strict(),
      )
      .max(60),
  })
  .strict();
const builtPersona = z
  .object({
    person,
    traits: z.array(inferredTrait).max(MAX_TRAITS),
    rejected: z.array(z.object({ why: line(300), example: line(160) }).strict()).max(5),
  })
  .strict();
export type BuiltPersona = z.infer<typeof builtPersona>;
export const emptyPerson = (): BuiltPersona['person'] => ({ role: '', domains: [], projects: [] });
/** A model's answer: one entry out of bounds (a line too long, a repeated id, a list past its limit) is dropped, and the
 *  rest of an hour's build stands; a person that is not one still fails. */
export function parsePersona(text: string, excerpts?: string[]): BuiltPersona {
  const raw = redactPersona(JSON.parse(text)) as {
    traits?: unknown;
    rejected?: unknown;
    person?: { role?: unknown; domains?: unknown; projects?: unknown };
  };
  const kept = (items: unknown, list: z.ZodArray<z.ZodTypeAny>, max: number) =>
    (Array.isArray(items) ? items : [])
      .filter((item) => list.element.safeParse(item).success)
      .slice(0, max);
  const who =
    raw?.person && typeof raw.person === 'object'
      ? {
          ...raw.person,
          domains: kept(raw.person.domains, person.shape.domains, 12),
          projects: kept(raw.person.projects, person.shape.projects, 60),
        }
      : raw?.person;
  const ids = new Set<string>();
  const traits = (Array.isArray(raw?.traits) ? raw.traits : [])
    .filter((item) => {
      const trait = inferredTrait.safeParse(item);
      if (!trait.success || ids.has(trait.data.id)) return false;
      ids.add(trait.data.id);
      return true;
    })
    .slice(0, MAX_TRAITS);
  const built = builtPersona.parse({
    ...raw,
    person: who,
    traits,
    rejected: kept(raw?.rejected, builtPersona.shape.rejected, 5),
  });
  if (excerpts) {
    const normal = (text: string) =>
      text
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[‐‑‒–—−]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
    const shown = excerpts.map((text) =>
      normal(text.replace(/^\[(?:claude|codex) · .*? · \d{4}-\d{2}-\d{2} · [^\]\r\n]*\] /, '')),
    );
    const matches = (quote: string) => {
      const parts = normal(quote)
        .replace(/^(?:["']|\s|\.{3,})+|(?:["']|\s|\.{3,})+$/g, '')
        .split(/\.{3,}/)
        .map((part) => part.trim());
      if (
        parts.length > 2 ||
        parts.some(
          (part) => !part || (parts.length > 1 && part.length < 12 && part.split(' ').length < 2),
        )
      )
        return false;
      const spans = parts.map(
        (part) =>
          new RegExp(
            `(?<![\\p{L}\\p{M}\\p{N}_])${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{M}\\p{N}_])`,
            'u',
          ),
      );
      // One cut may omit words, but cannot stitch fragments, split words or combine excerpts.
      return shown.some((text) => {
        let after = 0;
        return spans.every((span) => {
          const match = span.exec(text.slice(after));
          after += (match?.index ?? 0) + (match?.[0].length ?? 0);
          return !!match;
        });
      });
    };
    built.traits = built.traits
      .map((item) => ({ ...item, evidence: item.evidence.filter((quote) => matches(quote.quote)) }))
      .filter((item) => item.evidence.length);
  }
  return built;
}
const revision = z.number().int().nonnegative();
const editStamp = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ at: z.string().datetime(), value }).strict();
const removedValues = z.record(text, z.string().datetime()).optional();
/** Keep authored values separately from learned additions, including deliberate empty values. */
export const personEdits = z
  .object({
    role: editStamp(person.shape.role).optional(),
    domains: editStamp(person.shape.domains).extend({ removed: removedValues }).optional(),
    projects: editStamp(person.shape.projects).extend({ removed: removedValues }).optional(),
  })
  .strict();
export type PersonaEdit = { revision: number } & (
  | { trait: BuiltPersona['traits'][number]; chatLine: string }
  | { remove: string }
  | { text: string; group?: (typeof GROUPS)[number] }
  | { person: Partial<BuiltPersona['person']> }
);
export const personaEdit = z
  .object({
    revision,
    trait: inferredTrait.optional(),
    chatLine: line(1500).optional(),
    remove: line(100).optional(),
    text: line(140).optional(),
    group: z.enum(GROUPS).optional(),
    person: person
      .partial()
      .refine((value) => Object.keys(value).length > 0)
      .optional(),
  })
  .strict()
  .refine(
    (edit) =>
      [edit.trait, edit.remove, edit.text, edit.person].filter((value) => value !== undefined)
        .length === 1 && !!edit.trait === !!edit.chatLine,
    'Choose one edit',
  )
  .transform((edit) => edit as PersonaEdit);
export const personaView = z.object({
  enabled: z.boolean(),
  revision,
  markdown: text.pipe(z.string().max(20_000)),
  person,
  traits: z
    .array(trait)
    .refine(
      (items) => items.length <= MAX_TRAITS || items.every((item) => item.source !== 'built'),
      'Only authored traits may exceed the limit',
    ),
  builtAt: z.string().datetime().nullable(),
  messages: z.number().int().nonnegative(),
  ignored: z.number().int().nonnegative(),
  rejected: builtPersona.shape.rejected,
  personEdits: personEdits.optional(),
  removedTraits: removedValues,
  /** Live from the Mac and never stored: a build is reading their chats, or how the last one ended. */
  building: z.boolean().optional(),
  failed: z.string().max(60).optional(),
});
export type PersonaView = z.infer<typeof personaView>;
export const priority = (a: Trait, b: Trait) =>
  ({ person: 0, merv: 1, built: 2 })[a.source] - { person: 0, merv: 1, built: 2 }[b.source] ||
  b.confidence - a.confidence ||
  b.lastSeen.localeCompare(a.lastSeen);
/** Concurrent accepted owner edits must survive; only inferred additions share the remaining room. */
function fitPersonaTraits(traits: Trait[]): Trait[] {
  const sorted = [...traits].sort(priority),
    owned = sorted.filter((item) => item.source !== 'built');
  return [
    ...owned,
    ...sorted
      .filter((item) => item.source === 'built')
      .slice(0, Math.max(0, MAX_TRAITS - owned.length)),
  ];
}
export const markdown = (data: Pick<PersonaView, 'person' | 'traits'>) =>
  [
    'Use these preferences quietly. The current request takes precedence.',
    [
      data.person.role && `Role: ${data.person.role}`,
      data.person.domains.length && `Works in: ${data.person.domains.join(', ')}`,
      ...[...data.person.projects]
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
        .slice(0, 8)
        .map((project) => `Building: ${project.name}${project.what ? ` — ${project.what}` : ''}`),
    ]
      .filter(Boolean)
      .join('\n'),
    ...GROUPS.map((group) => {
      const items = foldTraits(data.traits)
        .filter((item) => item.group === group && item.scale !== 0.5 && item.instruction)
        .sort(priority);
      return items.length
        ? `## ${group}\n${items.map((item) => `- ${item.instruction} [${item.id}]`).join('\n')}`
        : '';
    }),
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 20_000);

/** A profile can be filled in before chat learning is enabled or a Mac is paired. */
export const emptyPersona = (): PersonaView => ({
  enabled: false,
  revision: 0,
  markdown: '',
  person: emptyPerson(),
  traits: [],
  builtAt: null,
  messages: 0,
  ignored: 0,
  rejected: [],
});
const keyOf = (text: string) => text.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const union = <T>(owned: T[], built: T[], key: (value: T) => string, limit: number) =>
  [...owned, ...built]
    .filter((value, index, all) => all.findIndex((other) => key(other) === key(value)) === index)
    .slice(0, limit);
/** Owned role and project descriptions win; new supported domains and projects are additions. */
export function augmentPerson(
  built: BuiltPersona['person'],
  edits: PersonaView['personEdits'],
): BuiltPersona['person'] {
  return {
    role: edits?.role?.value ?? built.role,
    domains: union(
      edits?.domains?.value ?? [],
      built.domains.filter((value) => !edits?.domains?.removed?.[keyOf(value)]),
      keyOf,
      12,
    ),
    projects: union(
      edits?.projects?.value ?? [],
      built.projects.filter((value) => !edits?.projects?.removed?.[keyOf(value.name)]),
      (project) => keyOf(project.name),
      60,
    ),
  };
}
const authoredPerson = (view: PersonaView) => ({
  role: view.personEdits?.role?.value ?? '',
  domains: view.personEdits?.domains?.value ?? [],
  projects: view.personEdits?.projects?.value ?? [],
});
export const withMarkdown = (view: PersonaView): PersonaView => ({
  ...view,
  markdown:
    view.person.role ||
    view.person.domains.length ||
    view.person.projects.length ||
    view.traits.length
      ? markdown(view)
      : '',
});
const authoredTrait = (item: Trait): Trait => {
  const evidence = item.evidence.filter(
    (quote) => quote.provider === 'person' || quote.provider === 'merv',
  );
  return {
    ...item,
    evidence: evidence.length
      ? evidence
      : [
          {
            quote: item.instruction || item.name,
            date: (item.pinnedAt ?? item.lastSeen).slice(0, 10),
            provider: item.source === 'person' ? 'person' : 'merv',
            project: 'You',
            kind: 'ruling',
          },
        ],
  };
};
/** Learning consent hides learned history, without hiding what the person wrote themselves. */
export function visiblePersona(view: PersonaView, enabled = view.enabled): PersonaView {
  return withMarkdown(
    enabled
      ? { ...view, enabled }
      : {
          ...view,
          enabled,
          person: authoredPerson(view),
          traits: view.traits.filter((item) => item.source !== 'built').map(authoredTrait),
          builtAt: null,
          messages: 0,
          ignored: 0,
          rejected: [],
        },
  );
}
export function fromText(
  text: string,
  source: Trait['source'],
  id: string = crypto.randomUUID(),
  group: Trait['group'] = 'answers',
): Trait {
  const now = new Date().toISOString();
  return {
    id,
    group,
    name: text.split(/\s+/).slice(0, 4).join(' ').slice(0, 100),
    value: 'As requested',
    scale: null,
    left: null,
    right: null,
    instruction: text.slice(0, 140),
    evidence: [
      {
        quote: text.slice(0, 160),
        date: now.slice(0, 10),
        provider: source === 'person' ? ('person' as const) : ('merv' as const),
        project: source === 'person' ? 'You' : 'Merv',
        kind: 'ruling',
      },
    ],
    confidence: 1,
    lastSeen: now.slice(0, 10),
    source,
    pinnedAt: source === 'built' ? null : now,
  };
}

/** A local edit timestamp advances even when two changes happen in one millisecond. */
const nextStamp = (view: PersonaView) =>
  new Date(
    Math.max(
      Date.now(),
      ...[
        ...Object.values(view.personEdits ?? {}).map((field) => field.at),
        ...Object.values(view.removedTraits ?? {}),
        ...view.traits.map((item) => item.pinnedAt),
      ]
        .filter((at): at is string => !!at)
        .map((at) => Date.parse(at) + 1),
    ),
  ).toISOString();
export function applyPersonaEdit(
  view: PersonaView,
  input: unknown,
  source: 'person' | 'merv' = 'person',
): PersonaView {
  const edit = redactPersona(personaEdit.parse(input));
  if (edit.revision !== view.revision) throw new Error('persona_changed');
  const at = nextStamp(view),
    date = at.slice(0, 10);
  let result = { ...view, revision: view.revision + 1 };
  if ('person' in edit) {
    const fields = { ...view.personEdits };
    for (const key of Object.keys(edit.person) as (keyof BuiltPersona['person'])[]) {
      const value = edit.person[key];
      if (key === 'role') {
        fields.role = { at, value: value as string };
        continue;
      }
      const removed = { ...fields[key]?.removed };
      const name = (item: string | BuiltPersona['person']['projects'][number]) =>
        keyOf(typeof item === 'string' ? item : item.name);
      const kept = (value as (string | BuiltPersona['person']['projects'][number])[]).map(name);
      for (const old of view.person[key]) if (!kept.includes(name(old))) removed[name(old)] = at;
      Object.assign(fields, {
        [key]: { at, value, ...(Object.keys(removed).length && { removed }) },
      });
    }
    result = { ...result, person: { ...view.person, ...edit.person }, personEdits: fields };
  } else if ('remove' in edit) {
    result = {
      ...result,
      traits: view.traits.filter((item) => item.id !== edit.remove),
      removedTraits: { ...view.removedTraits, [edit.remove]: at },
    };
  } else {
    const text = 'text' in edit ? edit.text : edit.chatLine;
    const ruling = {
      quote: text.slice(0, 160),
      date,
      provider: source,
      project: source === 'person' ? 'You' : 'Merv',
      kind: 'ruling' as const,
    };
    const item: Trait =
      'text' in edit
        ? {
            ...fromText(text, source, crypto.randomUUID(), edit.group),
            evidence: [ruling],
            lastSeen: date,
            pinnedAt: at,
          }
        : {
            ...edit.trait,
            source,
            pinnedAt: at,
            confidence: 1,
            lastSeen: date,
            evidence: [ruling, ...edit.trait.evidence].slice(0, 3),
          };
    const others = view.traits.filter((current) => current.id !== item.id);
    if (
      !view.traits.some((current) => current.id === item.id && current.source !== 'built') &&
      others.filter((current) => current.source !== 'built').length >= MAX_TRAITS
    )
      throw new Error('persona_too_large');
    result = { ...result, traits: fitPersonaTraits([item, ...others]) };
  }
  return withMarkdown(result);
}
export type Identity = Pick<Trait, 'id' | 'group' | 'name' | 'value'>;
export type Removed = string | Identity;
export const identity = ({ id, group, name, value }: Identity): Identity => ({
  id,
  group,
  name,
  value,
});
const normal = (text: string) =>
  [
    ...new Set(
      text
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\b(concise|conciseness|brevity|brief|briefness)\b/g, 'short')
        .split(/\s+/)
        .filter(Boolean),
    ),
  ]
    .sort()
    .join(' ');
// Splitting reading from answers must not resurrect a removed preference under its new group.
const family = (group: Trait['group']) => (group === 'reading' ? 'answers' : group);
export const same = (a: Identity, b: Removed) =>
  typeof b === 'string'
    ? a.id === b
    : a.id === b.id ||
      (family(a.group) === family(b.group) &&
        (normal(a.name) === normal(b.name) ||
          normal(`${a.name} ${a.value}`) === normal(`${b.name} ${b.value}`)));

export function mergePersona(
  current: Trait[],
  built: BuiltPersona['traits'],
  tombstones: Removed[],
): Trait[] {
  const incoming = new Map<string, BuiltPersona['traits'][number]>();
  for (const item of built) {
    if (tombstones.some((removed) => same(item, removed))) continue;
    // A new spelling must not undo a correction or create a second preference.
    const previous =
      current.find((old) => old.id === item.id) ??
      current.find((old) => same(item, old)) ??
      [...incoming.values()].find((old) => same(item, old));
    const id = previous?.id ?? item.id;
    incoming.set(id, { ...item, id });
  }
  const merged: Trait[] = [];
  for (const item of current) {
    if (item.source === 'built' && tombstones.some((removed) => same(item, removed))) continue;
    const next = incoming.get(item.id);
    incoming.delete(item.id);
    if (item.source !== 'built') {
      const quotes = [...item.evidence, ...(next?.evidence ?? [])].filter(
        (quote, index, all) =>
          all.findIndex((other) => JSON.stringify(other) === JSON.stringify(quote)) === index,
      );
      merged.push({
        ...item,
        evidence: quotes.length <= 3 ? quotes : [quotes[0], ...quotes.slice(-2)],
        lastSeen: next && next.lastSeen > item.lastSeen ? next.lastSeen : item.lastSeen,
      });
    } else if (next) merged.push({ ...next, source: 'built', pinnedAt: null });
    else if (item.confidence * 0.7 >= 0.3)
      merged.push({ ...item, confidence: item.confidence * 0.7 });
  }
  for (const item of incoming.values()) merged.push({ ...item, source: 'built', pinnedAt: null });
  return fitPersonaTraits(merged);
}

// Evidence and lastSeen can grow during collection without changing the owned instruction.
const traitEditKey = ({ evidence, confidence, lastSeen, ...item }: Trait) => JSON.stringify(item);
/** Bring owner edits to either replica; inferred content and consent always come from base. */
export function mergeOwnedPersona(base: PersonaView, incoming: PersonaView): PersonaView {
  const fields = { ...base.personEdits },
    removed = { ...base.removedTraits };
  for (const key of ['role', 'domains', 'projects'] as const) {
    const next = incoming.personEdits?.[key],
      current = fields[key];
    if (
      next &&
      (!current ||
        next.at > current.at ||
        (next.at === current.at && JSON.stringify(next.value) > JSON.stringify(current.value)))
    )
      Object.assign(fields, { [key]: next });
  }
  for (const key of ['domains', 'projects'] as const) {
    const field = fields[key];
    if (!field) continue;
    const removed = { ...base.personEdits?.[key]?.removed };
    for (const [id, at] of Object.entries(incoming.personEdits?.[key]?.removed ?? {}))
      if (!removed[id] || at > removed[id]) removed[id] = at;
    if (Object.keys(removed).length) Object.assign(fields, { [key]: { ...field, removed } });
  }
  for (const [id, at] of Object.entries(incoming.removedTraits ?? {}))
    if (!removed[id] || at > removed[id]) removed[id] = at;
  const traits = new Map(base.traits.map((item) => [item.id, item]));
  for (const next of incoming.traits.filter((item) => item.source !== 'built')) {
    const old = traits.get(next.id);
    if (
      !old ||
      old.source === 'built' ||
      (next.source === 'person' && old.source !== 'person') ||
      (next.source === old.source &&
        ((next.pinnedAt ?? '') > (old.pinnedAt ?? '') ||
          (next.pinnedAt === old.pinnedAt && traitEditKey(next) > traitEditKey(old))))
    )
      traits.set(next.id, next);
  }
  for (const [id, item] of traits)
    if (removed[id] && (!item.pinnedAt || removed[id] >= item.pinnedAt)) traits.delete(id);
  if (
    JSON.stringify(fields) === JSON.stringify(base.personEdits ?? {}) &&
    JSON.stringify(removed) === JSON.stringify(base.removedTraits ?? {}) &&
    JSON.stringify([...traits.values()]) === JSON.stringify(base.traits)
  )
    return base;
  const learned = {
    ...base.person,
    domains: base.person.domains.filter(
      (value) => !base.personEdits?.domains?.value.some((old) => keyOf(old) === keyOf(value)),
    ),
    projects: base.person.projects.filter(
      (value) =>
        !base.personEdits?.projects?.value.some((old) => keyOf(old.name) === keyOf(value.name)),
    ),
  };
  const result = withMarkdown({
    ...base,
    person: augmentPerson(learned, fields),
    traits: fitPersonaTraits([...traits.values()]),
    ...(Object.keys(fields).length ? { personEdits: fields } : {}),
    ...(Object.keys(removed).length ? { removedTraits: removed } : {}),
  });
  return { ...result, revision: Math.max(base.revision + 1, incoming.revision) };
}

/** Owned instructions first; inferred visual and reading coverage share the remaining budget. */
const PERSONA_WORD_BUDGET = 150;
export function personaContext(data: Pick<PersonaView, 'person' | 'traits'>): string {
  const lines = ['Use these preferences quietly. The current request takes precedence.'];
  let room = PERSONA_WORD_BUDGET - lines[0].split(/\s+/).length;
  const owned = (item: Trait) => item.source !== 'built' || !!item.pinnedAt;
  const currentTraits = foldTraits(data.traits).map((item) =>
    item.id.startsWith('visual-style-') && (LOOK_NAMES as readonly string[]).includes(item.value)
      ? { ...item, instruction: lookInstruction(item.value as LookName) }
      : item,
  );
  const sure = currentTraits
    .filter(
      (item) => item.scale !== 0.5 && item.instruction && (owned(item) || item.confidence >= 0.5),
    )
    .sort(priority);
  const groups = [
    'visual',
    'reading',
    'answers',
    'person',
    'decisions',
    'avoid',
    'process',
  ] as const;
  const chosen = new Map<string, string[]>();
  const add = (group: string, instruction: string) => {
    instruction = instruction.replace(/\s+/g, ' ').trim();
    const cost = instruction.trim().split(/\s+/).length + (chosen.has(group) ? 0 : 1);
    if (cost > room) return;
    room -= cost;
    chosen.set(group, [...(chosen.get(group) ?? []), instruction]);
  };
  // Reserve space globally for explicit instructions before considering inferred coverage.
  for (const item of sure
    .filter(owned)
    .sort((a, b) => priority(a, b) || groups.indexOf(a.group) - groups.indexOf(b.group)))
    add(item.group, item.instruction);
  const inferred = sure.filter((item) => !owned(item));
  // One instruction per supported group before filling out the highest-priority sections.
  // This keeps a dense visual profile from swallowing reading or person depth entirely.
  for (const group of groups) {
    const first = inferred.find((item) => item.group === group);
    if (first) add(group, first.instruction);
  }
  for (const group of groups)
    for (const item of inferred.filter((item) => item.group === group).slice(1))
      add(group, item.instruction);
  if (data.person.role) add('person', `Role: ${data.person.role}`);
  for (const group of groups)
    if (chosen.has(group)) lines.push(`${group}:\n${chosen.get(group)!.join('\n')}`);
  return lines.join('\n');
}
