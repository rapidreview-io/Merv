import { z } from 'zod';
export const viewSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('fit') }).strict(),
  z
    .object({
      action: z.literal('region'),
      x: z.number().finite().min(-100000).max(100000),
      y: z.number().finite().min(-100000).max(100000),
      width: z.number().min(1).max(100000),
      height: z.number().min(1).max(100000),
    })
    .strict(),
  z
    .object({
      action: z.literal('pan'),
      dx: z.number().finite().min(-100000).max(100000),
      dy: z.number().finite().min(-100000).max(100000),
    })
    .strict(),
  z
    .object({
      action: z.literal('zoom'),
      factor: z.number().min(0.25).max(4),
      center: z
        .tuple([
          z.number().finite().min(-100000).max(100000),
          z.number().finite().min(-100000).max(100000),
        ])
        .optional(),
    })
    .strict(),
]);
export type View = z.infer<typeof viewSchema>;
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Board-coordinate camera; independent from scene mutations. */
export function camera(bounds: Region, current?: Region, view?: View): Region {
  const fit = {
    x: bounds.x - 40,
    y: bounds.y - 40,
    width: Math.max(1, bounds.width) + 80,
    height: Math.max(1, bounds.height) + 80,
  };
  const base = current ?? fit;
  if (!view) return current ?? fit;
  if (view.action === 'fit') return fit;
  if (view.action === 'region')
    return { x: view.x, y: view.y, width: view.width, height: view.height };
  if (view.action === 'pan') return { ...base, x: base.x + view.dx, y: base.y + view.dy };
  const width = Math.max(1, Math.min(100000, base.width / view.factor)),
    height = Math.max(1, Math.min(100000, base.height / view.factor));
  const [x, y] = view.center ?? [base.x + base.width / 2, base.y + base.height / 2];
  return { x: x - width / 2, y: y - height / 2, width, height };
}

/** A look (a board's, an image's, the screen's) as an agent is shown it: its image as an image, the
 *  rest as text. */
export const pictured = (value: unknown) => {
  const { image, ...metadata } = value as { image?: { data: string; mimeType: string } };
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(metadata) },
      ...(image ? [{ type: 'image' as const, ...image }] : []),
    ],
  };
};
