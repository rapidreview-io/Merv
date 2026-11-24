import { z } from 'zod';
import { LOOK_NAMES } from '@merv/protocol/looks';

/** One of the five looks a board can wear. */
const look = z.enum(LOOK_NAMES);
import { idSchema, jsonBytes, parsed, visible } from '@merv/contracts';

export const id = idSchema;
export const title = z.string().trim().min(1).max(200).refine(visible);
const text = z.string().trim().min(1).max(2_000).refine(visible);
/**
 * Why a page's body names a picture no reader will ever see, or undefined. A page shows
 * `![alt](art_…)`, an https address or a raster data URI (packages/ui/web/markdown-links.ts);
 * a path on someone's computer and a plain http address never show, so the call says so rather
 * than leave a picture's words where the picture was meant to be. Merv.app on a Mac uploads a
 * local picture before the call arrives here, so a path that reaches the board was not uploaded.
 */
export function pageImageProblem(body: string): string | undefined {
  // What is written as code is shown as code: a picture's syntax there is an example, not a picture.
  const prose = body
    .replace(/(^|\n) {0,3}(`{3,}|~{3,})[^]*?(\n {0,3}\2[^\n]*|$)/g, '\n')
    .replace(/(`+)[^`]*?\1/g, '');
  for (const [, address = ''] of prose.matchAll(/!\[(?:[^\]\\]|\\.)*\]\(\s*<?([^\s)>]+)/g)) {
    if (/^http:\/\//i.test(address))
      return `Page image ${address.slice(0, 120)} is plain http and will not show: use https, or upload it with artifact.write and write ![alt](art_…).`;
    const local =
      /^(?:file:|~\/|\.{1,2}\/)/i.test(address) ||
      (address.startsWith('/') && !/^\/(?:ui\/)?artifacts\/art_/.test(address)) ||
      (!/^[a-z][a-z0-9+.-]*:/i.test(address) &&
        !address.startsWith('art_') &&
        /\.(?:png|jpe?g|gif|webp|svg)$/i.test(address));
    if (local)
      return `Page image ${address.slice(0, 120)} is a file on a computer, which the board cannot read: upload it with artifact.write (create, or upload_begin for a file on disk) and write ![alt](art_…) with the id it returns.`;
  }
  return undefined;
}

/** A shape this call keys, or the id of one already on the board. */
const shape = z.string().min(1).max(100);
/** A name this call gives what it draws, for its later operations and its answer. */
const name = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const key = name.optional();
/** A short line heard as the pen reaches the op that carries it, which keeps it on what it makes. */
const say = z.string().trim().min(1).max(160).refine(visible).optional();
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
  /** Find room right or below at when that spot is occupied. */
  free: z.boolean().optional(),
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
const opSchema = z.discriminatedUnion('op', [
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
    op: z.literal('page'),
    key,
    say,
    /** Its title, on the card; what it opens to read needs no record or address behind it. */
    text,
    body: z
      .string()
      .trim()
      .min(1)
      .max(100_000)
      .superRefine((body, ctx) => {
        const problem = pageImageProblem(body);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
      }),
    fact: z.string().trim().max(80).optional(),
    ...place,
  }),
  z.strictObject({
    op: z.literal('browser'),
    key,
    say,
    /** A live web page on the board; in Merv.app it is also a tab of the browser, `tab` that tab. */
    url: z
      .string()
      .url()
      .max(2_000)
      .refine((v) => /^https?:\/\//.test(v)),
    tab: z.string().min(1).max(100).optional(),
    width: z.number().finite().min(200).max(4_000).optional(),
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
    /** An empty frame's size, as for a variant at the size of what it stands beside. */
    width: z.number().finite().min(40).max(10_000).optional(),
    height: z.number().finite().min(40).max(10_000).optional(),
    near: shape.optional(),
    side: place.side,
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
    opacity: z.number().int().min(0).max(100).optional(),
  }),
  z.object({ op: z.literal('move'), say, id: shape, ...place }).strict(),
  z.object({ op: z.literal('delete'), say, ids: z.array(shape).min(1).max(200) }).strict(),
  z.strictObject({
    op: z.literal('sketch'),
    key,
    say,
    strokes: z.array(stroke).min(1).max(80),
    size: z.enum(['s', 'm', 'l', 'native']).optional(),
    /** A stroke whose pen (colour, width, roughness) these strokes take, unless one sets its own:
     *  how a continuation of a person's lines looks like theirs. */
    like: shape.optional(),
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
    target: z
      .string()
      .url()
      .refine((url) => /^https?:/.test(url))
      .optional(),
    fact: z.string().min(1).max(2000).optional(),
    /** Its width on the board; an explicit height fits a comparison sketch. */
    width: z.number().finite().min(20).max(4_000).optional(),
    height: z.number().finite().min(20).max(4_000).optional(),
    ...place,
  }),
]);
export type DrawOp = z.infer<typeof opSchema>;
export const drawSchema = z.strictObject({
  board: id.optional(),
  title: title.optional(),
  /** Preferred drawing guidance only; it never changes paper or existing shapes. */
  look: look.optional(),
  paper: hex.optional(),
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
/** A line said aloud on a board: by the person or an agent's voice, named, in its own words. */
export const saidSchema = z.strictObject({
  by: z.enum(['person', 'agent']),
  name: z.string().trim().min(1).max(40).optional(),
  words: z.string().trim().min(1).max(4000),
});
export const saidInputSchema = saidSchema.extend({ id });
/** How far back one rewind goes, in steps. */
const MOST_REWOUND = 100;
export const rewindSchema = z.strictObject({
  board: id,
  step: z.number().int().safe().min(0),
  back: z.number().int().min(0).max(MOST_REWOUND),
});
export const setSchema = z.strictObject({
  id,
  title: title.optional(),
  archived: z.boolean().optional(),
  /** Preferred drawing guidance; null removes it. */
  look: look.nullable().optional(),
  paper: hex.optional(),
});

export const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown) =>
  parsed(schema, value, 'invalid_board_input', { nodes: 200_000, depth: 10, bytes: 4_000_000 });
