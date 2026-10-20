import { boardViewSchema, check, type Caller } from '@merv/contracts';
import { pictured } from '@merv/contracts/pictured';
import type { z } from 'zod';
import type { View } from '@merv/contracts/board-view';
import type { Picture, ToolDefinition, Tools } from '@merv/api/types';
import { showInput } from './schema.js';
import type { ScreenLook } from './types.js';

const input = showInput
  .omit({ page: true })
  .required({ record: true })
  .extend({ view: boardViewSchema.optional() })
  .strict();

/** A record with a picture drawer (a board, an image artifact) as drawn for an agent, without
 *  anyone's screen: its image when it has one, else the drawn page; undefined where none draws it. */
export async function drawRecord(
  tools: Pick<Tools, 'picture'>,
  caller: Caller,
  record: string,
  focus?: string,
  view?: View,
): Promise<ScreenLook | Picture | undefined> {
  const drawn = await tools.picture(caller, record, focus, view);
  if (!drawn?.image) return drawn;
  return {
    page: drawn.path,
    seen: record.startsWith('art_')
      ? 'Actual reference image. Viewport coordinates are source pixels; use region for readable details.'
      : 'Actual Excalidraw board image. Coordinates in viewport are board units.',
    image: drawn.image,
    viewport: drawn.viewport,
  };
}

/** record.look: the pixels of a board or image artifact for any caller, as MCP image content. */
export const recordLookTool = (tools: Pick<Tools, 'picture'>): ToolDefinition => ({
  name: 'record.look',
  description:
    'See a board or a JPEG, PNG or WebP image artifact as an image, drawn by Merv without anyone’s screen. focus: a board frame, group or shape id. view: fit, region (board units or source pixels), pan or zoom. Does not change the record.',
  inputSchema: input,
  readOnly: true,
  handler: async (caller: Caller, { record, focus, view }: z.infer<typeof input>) => {
    const seen = await drawRecord(tools, caller, record, focus, view);
    check(
      seen && 'seen' in seen,
      'invalid_input',
      'record.look sees boards and JPEG, PNG or WebP image artifacts',
    );
    return seen;
  },
  present: pictured,
});
