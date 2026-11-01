import { z } from 'zod';
import { idSchema, jsonBytes, parsed, visible } from '@merv/contracts';

export const id = idSchema;
export const title = z.string().trim().min(1).max(200).refine(visible);
const text = z.string().trim().min(1).max(2_000).refine(visible);
/** A shape this call keys, or the id of one already on the board. */
const shape = z.string().min(1).max(100);
/** A name this call gives what it draws, for its later operations and its answer. */
const name = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const key = name.optional();
/** A short line heard as the pen reaches the op that carries it, which keeps it on what it makes. */
const say = z.string().trim().min(1).max(100).refine(visible).optional();
export const COLORS = {
  yellow: '#ffec99',
  blue: '#a5d8ff',
  green: '#b2f2bb',
  red: '#ffc9c9',
  orange: '#ffd8a8',
  gray: '#e9ecef',
  white: '#ffffff',
} as const;
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const color = z.union([z.enum(Object.keys(COLORS) as [keyof typeof COLORS]), hex]);
/** A pen's colours, and the stronger ones a sketch fills with: the palette Excalidraw offers. */
export const INKS = {
  black: '#1e1e1e',
  red: '#e03131',
  green: '#2f9e44',
  blue: '#1971c2',
  yellow: '#f08c00',
  orange: '#e8590c',
  pink: '#c2255c',
  gray: '#868e96',
  white: '#ffffff',
} as const;
export const PAINTS = {
  black: '#343a40',
  red: '#ff8787',
  green: '#69db7c',
  blue: '#74c0fc',
  yellow: '#ffd43b',
  orange: '#ffa94d',
  pink: '#f783ac',
  gray: '#ced4da',
  white: '#ffffff',
} as const;
const ink = z.union([z.enum(Object.keys(INKS) as [keyof typeof INKS]), hex]);
export const paint = (palette: Record<string, string>, value: string) => palette[value] ?? value;
/** One pen stroke of a sketch: an SVG path in the sketch's own coordinates. */
const stroke = z.strictObject({
  path: z.string().trim().min(2).max(20_000),
  color: ink.optional(),
  /** Filled, a closed stroke is a painted shape; without, it is a pen line. */
  fill: ink.optional(),
  width: z.enum(['thin', 'medium', 'bold']).optional(),
});
/** Where a new shape goes: beside a shape, inside a frame, or (neither) the next free place. */
const place = {
  near: shape.optional(),
  in: shape.optional(),
  /** Which side of `near` to try first. */
  side: z.enum(['right', 'left', 'above', 'below']).optional(),
  /** Exactly here: the top-left corner in board coordinates, as board.read reports them. */
  at: z.tuple([z.number().finite(), z.number().finite()]).optional(),
};
const node = z.strictObject({
  key: name,
  text,
  shape: z.enum(['rectangle', 'ellipse', 'diamond']).optional(),
  color: color.optional(),
});
const edge = z.strictObject({
  from: z.string().min(1).max(40),
  to: z.string().min(1).max(40),
  label: text.optional(),
});

/** A guess for the person to keep or dismiss: faint and dashed, one group a call (elements.ts). */
const proposed = z.boolean().optional();
/** What a card opens: a Merv record's id, or a web address. */
const opens = z.union([
  id,
  z
    .string()
    .url()
    .max(2_000)
    .refine((v) => /^https?:\/\//.test(v)),
]);
export const opSchema = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('note'), key, say, text, color: color.optional(), proposed, ...place })
    .strict(),
  z.strictObject({
    op: z.literal('box'),
    key,
    say,
    text: z
      .string()
      .trim()
      .max(2_000)
      .refine((value) => value === '' || visible(value)),
    width: z.number().finite().min(1).max(10_000).optional(),
    height: z.number().finite().min(1).max(10_000).optional(),
    fontSize: z.number().finite().min(8).max(96).optional(),
    shape: z.enum(['rectangle', 'ellipse', 'diamond']).optional(),
    color: color.optional(),
    proposed,
    ...place,
  }),
  z.strictObject({
    op: z.literal('text'),
    key,
    say,
    color: ink.optional(),
    text,
    size: z.enum(['s', 'm', 'l']).optional(),
    fontSize: z.number().finite().min(8).max(96).optional(),
    proposed,
    ...place,
  }),
  z.strictObject({
    op: z.literal('link'),
    key,
    say,
    /** A Merv record's id or a web address, or a list of them that one card holds. */
    target: z.union([opens, z.array(opens).min(1).max(50)]),
    text,
    /** The one short fact the card shows beside its icon; by default, what kind of thing it is. */
    fact: z.string().trim().max(80).optional(),
    /** Optional readable content kept with the reference. Preview metadata is caller supplied. */
    details: z
      .strictObject({
        title: z.string().max(300).optional(),
        text: z.string().max(20000).optional(),
        preview: z
          .strictObject({
            title: z.string().max(300),
            description: z.string().max(2000).optional(),
          })
          .optional(),
        artifactId: id.optional(),
      })
      .optional(),
    ...place,
  }),
  z.strictObject({
    op: z.literal('arrow'),
    key,
    say,
    from: shape,
    to: shape,
    label: z.union([z.literal(''), text]).optional(),
    fontSize: z.number().finite().min(8).max(96).optional(),
  }),
  z.strictObject({
    op: z.literal('frame'),
    key,
    say,
    title,
    holds: z.array(shape).max(200).optional(),
    near: shape.optional(),
  }),
  z.strictObject({
    op: z.literal('flow'),
    key,
    say,
    nodes: z.array(node).min(1).max(40),
    edges: z.array(edge).max(80).default([]),
    direction: z.enum(['right', 'down']).optional(),
    ...place,
  }),
  z.strictObject({
    op: z.literal('edit'),
    say,
    id: shape,
    text: text.optional(),
    color: color.optional(),
    ink: ink.optional(),
    /** An arrow turned to go the other way, its bends and label kept. */
    reverse: z.literal(true).optional(),
  }),
  z.object({ op: z.literal('move'), say, id: shape, ...place }).strict(),
  z.object({ op: z.literal('delete'), say, ids: z.array(shape).min(1).max(200) }).strict(),
  z.strictObject({
    op: z.literal('sketch'),
    key,
    say,
    strokes: z.array(stroke).min(1).max(80),
    size: z.enum(['s', 'm', 'l', 'native']).optional(),
    proposed,
    ...place,
  }),
  z.strictObject({
    op: z.literal('image'),
    key,
    say,
    /** An image artifact, or a PDF artifact with the page to take. */
    artifactId: z.string().regex(/^art_[A-Za-z0-9_-]{1,190}$/),
    page: z.number().int().min(1).optional(),
    /** The part to crop, in the coordinates artifact.read look reports for that page or image. */
    region: z
      .strictObject({
        x: z.number().finite().min(0).max(100_000),
        y: z.number().finite().min(0).max(100_000),
        width: z.number().min(1).max(100_000),
        height: z.number().min(1).max(100_000),
      })
      .optional(),
    /** What it shows, in a few words: what board.read get says of it. */
    alt: z.string().trim().min(1).max(200).refine(visible).optional(),
    /** Its width on the board, its height following. */
    width: z.number().finite().min(20).max(4_000).optional(),
    ...place,
  }),
]);
export type DrawOp = z.infer<typeof opSchema>;
export const drawSchema = z.strictObject({
  board: id.optional(),
  title: title.optional(),
  ops: z.array(opSchema).max(100).default([]),
});
export type DrawInput = z.input<typeof drawSchema>;

/** Shapes a page may save. Embeds and iframes load outside the board, and are not taken. */
const DRAWN = [
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'arrow',
  'line',
  'freedraw',
  'frame',
  'image',
] as const;
/** The name Excalidraw gives an image's file: the hash of what the person chose. */
export const fileIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
/** What an image's own bytes say it is, whatever it claims. No SVG: it can carry script. */
const IMAGE_MARKS = [
  [/^\x89PNG\r\n\x1a\n/, 'image/png'],
  [/^\xff\xd8\xff/, 'image/jpeg'],
  [/^GIF8[79]a/, 'image/gif'],
  [/^RIFF.{4}WEBP/s, 'image/webp'],
] as const;
export const imageType = (bytes: Buffer) =>
  IMAGE_MARKS.find(([mark]) => mark.test(bytes.subarray(0, 12).toString('latin1')))?.[1];
const link = z
  .string()
  .max(2_000)
  .refine((v) => /^(https?:\/\/|merv:|\/)/.test(v), 'A link is a web address or a Merv record')
  .nullable()
  .optional();
export const elementSchema = z
  .object({
    id: z.string().min(1).max(100),
    type: z.enum(DRAWN),
    version: z.number().int().min(1),
    versionNonce: z.number().int(),
    isDeleted: z.boolean(),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite(),
    height: z.number().finite(),
    link,
    fileId: fileIdSchema.nullish(),
    // A line's points are drawn into the picture an agent looks at, so they are numbers only.
    points: z.array(z.tuple([z.number().finite(), z.number().finite()])).optional(),
    boundElements: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()).nullish(),
    groupIds: z.array(z.string()).optional(),
  })
  .passthrough()
  .refine((el) => el.type !== 'image' || el.fileId, 'An image names its file')
  // Every read of a board holds all of it; an agent's longest sketch stroke is about 150 KiB.
  .refine((el) => jsonBytes(el) <= 256 * 1024, 'A shape is at most 256 KiB');
export const saveSchema = z.strictObject({ id, elements: z.array(elementSchema).min(1).max(500) });
export const setSchema = z.strictObject({
  id,
  title: title.optional(),
  archived: z.boolean().optional(),
});

/** Postgres text holds no NUL. */
const outcomeText = z.string().refine((value) => !value.includes('\0'), 'Text holds no NUL');
export const outcomeSchema = z.strictObject({
  board: id,
  /** Without it, a new outcome, which needs a title. */
  outcome: id.optional(),
  title: title.optional(),
  /** The whole text: at exactly expectedRevision, or to begin a new outcome. */
  content: outcomeText.optional(),
  /** In turn at any revision, each find occurring exactly once in the text before it. */
  edits: z
    .array(z.strictObject({ find: z.string().min(1), replace: outcomeText }))
    .min(1)
    .max(50)
    .optional(),
  expectedRevision: z.number().int().safe().min(1).optional(),
});
export type OutcomeInput = z.input<typeof outcomeSchema>;
export const outcomeSentSchema = z.strictObject({
  board: id,
  outcome: id,
  how: z.enum(['claude', 'copy', 'fleet']),
  artifactId: z.string().regex(/^art_[A-Za-z0-9_-]{1,190}$/),
  revision: z.number().int().safe().min(1),
});
export type OutcomeSentInput = z.input<typeof outcomeSentSchema>;

export const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown) =>
  parsed(schema, value, 'invalid_board_input', { nodes: 200_000, depth: 10, bytes: 4_000_000 });
