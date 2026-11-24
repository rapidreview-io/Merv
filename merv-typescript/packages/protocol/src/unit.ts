/** Frozen board work and the result of one turn on the Mac. */
import { z } from 'zod';
import { speakDrawChunk } from './board.js';

export const COMMAND_IMAGE_BYTES = 1_500_000;
export const artifactImageIds = z
  .array(
    z
      .string()
      .max(200)
      .regex(/^art_[A-Za-z0-9_-]+$/),
  )
  .max(4);
export const picture = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg']),
  data: z
    .string()
    .min(4)
    .max(4 * Math.ceil(COMMAND_IMAGE_BYTES / 3))
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
const id = z.string().min(1).max(200);
const words = z.array(z.string().min(1).max(8000)).max(100);
const point = z.tuple([z.number().finite(), z.number().finite()]);
export const binding = z.object({
  unit: id,
  revision: z.number().int().positive(),
  run: z.number().int().min(0).max(2),
  parent: id.optional(),
});
export type Binding = z.infer<typeof binding>;
const region = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive(),
  height: z.number().positive(),
});
export const unit = z.object({
  id,
  board: id,
  frame: id.optional(),
  /** Frameless: where on the board the work comes from, as it stood when sent. Nothing marks it. */
  root: region.extend({ shapes: z.array(id).max(1200) }).optional(),
  context: z.string().max(4000).optional(),
  revision: z.number().int().positive(),
  parent: id.optional(),
  request: z.string().max(8000).optional(),
  note: id.optional(),
  changes: z.string().max(2000).optional(),
  title: z.string().min(1).max(200),
  brief: z.string().min(1).max(8000),
  picture: picture.optional(),
  attachments: artifactImageIds.optional(),
  imageStatus: z.enum(['attached', 'no_selection', 'failed']).optional(),
  shapes: z
    .array(
      z.object({
        id,
        kind: z.string(),
        text: z.string().optional(),
        at: point.optional(),
        size: point.optional(),
        from: id.optional(),
        to: id.optional(),
        target: z.union([z.string(), z.array(z.string())]).optional(),
        details: z.object({ title: z.string().optional(), text: z.string().optional() }).optional(),
      }),
    )
    .max(1200),
  checks: words,
  constraints: words,
  decisions: words,
  links: z
    .array(
      z.object({
        kind: z.enum(['artifact', 'url', 'thread', 'board']),
        target: z.string(),
        title: z.string(),
        excerpt: z.string().optional(),
      }),
    )
    .max(600),
  place: z.object({ project: id, branch: z.enum(['own', 'here']) }),
  configurationResolved: z.literal(true).optional(),
  dispatch: z
    .array(
      z.object({
        provider: z.enum(['claude', 'codex']),
        model: z.string().max(200).optional(),
        effort: z.string().max(40).optional(),
        variant: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .min(1)
    .max(3),
});
export type Unit = z.infer<typeof unit>;
export const returned = binding.extend({
  id,
  thread: id,
  kind: z.enum(['diff', 'answer', 'document', 'table', 'screenshot', 'figure', 'sources']),
  title: z.string().min(1).max(200),
  summary: z.string().max(100_000),
  files: z
    .array(
      z.object({
        path: z.string(),
        added: z.number().int().nonnegative(),
        removed: z.number().int().nonnegative(),
      }),
    )
    .max(40)
    .optional(),
  checks: words.optional(),
  evidence: z.array(z.string().max(2000)).max(20).optional(),
});
export type Return = z.infer<typeof returned>;

export function unitPrompt(work: Unit) {
  // The agent's first act is its own look at where the work comes from: the person watches its cursor take that picture.
  const look =
    work.imageStatus === 'failed'
      ? undefined
      : work.root
        ? `board_look {board: "${work.board}", region: {x: ${Math.round(work.root.x)}, y: ${Math.round(work.root.y)}, width: ${Math.round(work.root.width)}, height: ${Math.round(work.root.height)}}}`
        : work.frame
          ? `board_look {board: "${work.board}", focus: "${work.frame}"}`
          : undefined;
  return [
    ...(look
      ? [
          `Start by looking at where this comes from on the board, before anything else: ${look}. The person watches your cursor take that picture. Read the rest of that board with board_get or board_look if you need more. Your result is your final message in this session: the board marks the task done by itself, and that mark opens this session at your answer, so put the answer there in full. Draw on that board with board_draw only when a drawing is the answer (the person asked for a sketch or diagram, or the result is something to look at): then draw it beside where it came from in a few small board_draw calls and talk the person through it while it appears. ${speakDrawChunk} Never a card, page or note that reports, summarises or lists what you did; otherwise draw nothing.`,
        ]
      : []),
    work.brief,
    ...(work.context ? [`What we were discussing:\n${work.context}`] : []),
    ...(work.note || work.imageStatus === 'failed'
      ? [
          `Board material:\n${work.shapes
            .filter((shape) => shape.id !== work.note && shape.text)
            .map((shape) => shape.text)
            .join('\n\n')}`,
        ]
      : []),
    ...(work.changes ? [`What changed:\n${work.changes}`] : []),
    ...(
      [
        ['Done means:', work.checks],
        ['Constraints:', work.constraints],
        ['Decisions:', work.decisions],
      ] as const
    )
      .filter(([, lines]) => lines.length)
      .map(([title, lines]) => `${title}\n${lines.map((line) => `- ${line}`).join('\n')}`),
    ...work.shapes
      .filter((shape) => shape.details?.text && !shape.target)
      .slice(0, 40)
      .map((shape) => `${shape.text ?? shape.kind}:\n${shape.details!.text!.slice(0, 8000)}`),
    ...work.links.map(
      (link) => `${link.title}: ${link.target}${link.excerpt ? `\n${link.excerpt}` : ''}`,
    ),
  ].join('\n\n');
}
