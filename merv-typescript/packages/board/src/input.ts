import { z } from 'zod';
import { idSchema, parsed, visible } from '@merv/contracts';

export const id = idSchema;
export const title = z.string().trim().min(1).max(200).refine(visible);
const text = z.string().trim().min(1).max(2_000).refine(visible);
/** A shape this call keys, or the id of one already on the board. */
const shape = z.string().min(1).max(100);
/** A name this call gives what it draws, for its later operations and its answer. */
const key = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/)
  .optional();
export const COLORS = {
  yellow: '#ffec99',
  blue: '#a5d8ff',
  green: '#b2f2bb',
  red: '#ffc9c9',
  purple: '#d0bfff',
  orange: '#ffd8a8',
  gray: '#e9ecef',
  white: '#ffffff',
} as const;
const color = z.enum(Object.keys(COLORS) as [keyof typeof COLORS]);
/** Where a new shape goes: beside a shape, inside a frame, or (neither) the next free place. */
const place = { near: shape.optional(), in: shape.optional() };
const node = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    text,
    shape: z.enum(['rectangle', 'ellipse', 'diamond']).optional(),
    color: color.optional(),
  })
  .strict();
const edge = z
  .object({
    from: z.string().min(1).max(40),
    to: z.string().min(1).max(40),
    label: text.optional(),
  })
  .strict();

export const opSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('note'), key, text, color: color.optional(), ...place }).strict(),
  z
    .object({
      op: z.literal('box'),
      key,
      text,
      shape: z.enum(['rectangle', 'ellipse', 'diamond']).optional(),
      color: color.optional(),
      ...place,
    })
    .strict(),
  z
    .object({
      op: z.literal('text'),
      key,
      text,
      size: z.enum(['s', 'm', 'l']).optional(),
      ...place,
    })
    .strict(),
  z
    .object({
      op: z.literal('link'),
      key,
      /** A Merv record's id, or a web address. */
      target: z.union([
        id,
        z
          .string()
          .url()
          .max(2_000)
          .refine((v) => /^https?:\/\//.test(v)),
      ]),
      text,
      ...place,
    })
    .strict(),
  z
    .object({ op: z.literal('arrow'), key, from: shape, to: shape, label: text.optional() })
    .strict(),
  z
    .object({
      op: z.literal('frame'),
      key,
      title,
      holds: z.array(shape).max(200).optional(),
      near: shape.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('flow'),
      key,
      nodes: z.array(node).min(1).max(40),
      edges: z.array(edge).max(80).default([]),
      direction: z.enum(['right', 'down']).optional(),
      ...place,
    })
    .strict(),
  z
    .object({ op: z.literal('edit'), id: shape, text: text.optional(), color: color.optional() })
    .strict(),
  z.object({ op: z.literal('move'), id: shape, ...place }).strict(),
  z.object({ op: z.literal('delete'), ids: z.array(shape).min(1).max(200) }).strict(),
]);
export type DrawOp = z.infer<typeof opSchema>;
export const drawSchema = z
  .object({
    board: id.optional(),
    title: title.optional(),
    ops: z.array(opSchema).max(100).default([]),
  })
  .strict();
export type DrawInput = z.input<typeof drawSchema>;

/** Shapes a page may save. Images, embeds and iframes load outside the board, and are not taken. */
const DRAWN = [
  'rectangle',
  'ellipse',
  'diamond',
  'text',
  'arrow',
  'line',
  'freedraw',
  'frame',
] as const;
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
  })
  .passthrough();
export const saveSchema = z
  .object({ id, elements: z.array(elementSchema).min(1).max(500) })
  .strict();
export const setSchema = z
  .object({ id, title: title.optional(), archived: z.boolean().optional() })
  .strict();

export const parse = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown) =>
  parsed(schema, value, 'invalid_board_input', { nodes: 200_000, depth: 10, bytes: 4_000_000 });
