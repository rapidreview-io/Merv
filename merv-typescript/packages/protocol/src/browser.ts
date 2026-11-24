/** Browser calls share one shape on the local MCP server and the device link. */
import { z } from 'zod';

export const browserTool = z.enum(['open', 'read', 'look', 'act', 'clip', 'shot']);
export type BrowserTool = z.infer<typeof browserTool>;
/** Everything an agent can do to a page. The first three are the ones every Merv.app understands. */
const browserDo = [
  'click',
  'type',
  'press',
  'double_click',
  'right_click',
  'hover',
  'fill',
  'select',
  'scroll',
  'drag',
  'wait',
  'dialog',
  'back',
  'forward',
  'reload',
  'close',
] as const;
type BrowserDo = (typeof browserDo)[number];
/** One action: on an element by its ref, or at a point of the page as browser_look shows it. */
const step = (zod: typeof z) => {
  const at = zod.number().min(0).max(100_000).optional(),
    by = zod.number().int().min(-100_000).max(100_000).optional();
  return {
    do: zod.enum(browserDo),
    ref: zod.string().max(40).optional(),
    x: at,
    y: at,
    text: zod.string().max(20_000).optional(),
    to_ref: zod.string().max(40).optional(),
    to_x: at,
    to_y: at,
    dx: by,
    dy: by,
    accept: zod.boolean().optional(),
    ms: zod.number().int().min(0).max(10_000).optional(),
  };
};
export type BrowserStep = {
  do: BrowserDo;
  ref?: string;
  x?: number;
  y?: number;
  text?: string;
  to_ref?: string;
  to_x?: number;
  to_y?: number;
  dx?: number;
  dy?: number;
  accept?: boolean;
  ms?: number;
};
/** The contract a Mac's app speaks, said in its hello: 1 is click, type and press on a ref and a
 *  plain read; 2 adds the rest. A Mac that says nothing speaks 1. */
export const browserContract = 2;
/** Whether a call asks only for what every Merv.app understands. */
export function fitsFirstContract(tool: string, input: Record<string, unknown>): boolean {
  if (tool === 'read') return input.find === undefined;
  if (tool !== 'act') return true;
  return (
    input.steps === undefined &&
    typeof input.ref === 'string' &&
    ['click', 'type', 'press'].includes(String(input.do)) &&
    ['x', 'y', 'to_ref', 'to_x', 'to_y', 'dx', 'dy', 'accept', 'ms'].every(
      (key) => input[key] === undefined,
    )
  );
}
export const olderApp =
  "This Mac's Merv.app is an older one: it takes only click, type and press on a ref, one action at a time, and reads without find. Work within that, or ask the person to update Merv.app.";
/** An action as the person reads it before saying yes. */
export function actWords(input: Partial<BrowserStep> & { steps?: BrowserStep[] }): string {
  const one = (step: Partial<BrowserStep>) =>
    `${step.do ?? ''}${step.ref ? ` ${step.ref}` : step.x !== undefined ? ` at ${step.x}, ${step.y}` : ''}${step.text === undefined ? '' : `: ${step.text}`}`.slice(
      0,
      300,
    );
  return input.steps
    ? `${input.steps.length} actions: ${input.steps.map(one).join('; ')}`.slice(0, 1500)
    : one(input);
}
export function browserSchemas(zod: typeof z) {
  const page = { tab: zod.string().optional() };
  const region = zod
    .object({
      x: zod.number().int().nonnegative(),
      y: zod.number().int().nonnegative(),
      width: zod.number().int().positive().max(4096),
      height: zod.number().int().positive().max(4096),
    })
    .strict()
    .optional();
  return {
    open: zod.object({ url: zod.string(), ...page }).strict(),
    look: zod.object(page).strict(),
    clip: zod
      .object({
        ...page,
        quote: zod.string().min(1).max(2000).optional(),
        region,
        board: zod.string().optional(),
        frame: zod.string().optional(),
      })
      .strict()
      .refine((input) => !!input.quote || !!input.region, 'Give an exact quote or page region'),
    read: zod.object({ ...page, find: zod.string().min(1).max(200).optional() }).strict(),
    act: zod
      .object({
        ...page,
        ...step(zod),
        do: zod.enum(browserDo).optional(),
        steps: zod
          .array(zod.object(step(zod)).strict())
          .min(1)
          .max(20)
          .optional(),
      })
      .strict()
      .refine(
        (input) => !!input.steps !== !!input.do,
        'Give one action as do, or several as steps',
      ),
    shot: zod.object({ ...page, region }).strict(),
  };
}
export const browserInputs = browserSchemas(z);
export const clip = z.object({
  url: z
    .string()
    .url()
    .refine((url) => /^https?:/.test(url)),
  title: z.string().max(200),
  quote: z.string().min(1).max(2000),
  image: z
    .string()
    .min(4)
    .max(4 * Math.ceil((4 * 1024 * 1024) / 3)),
  width: z.number().positive().max(4096),
  height: z.number().positive().max(4096),
});
export type Clip = z.infer<typeof clip>;
export const browserAnswer = z.union([
  z.object({ clip }),
  z.object({ text: z.string() }),
  z.object({ image: z.string(), pageText: z.string().optional() }),
  z.object({ error: z.string() }),
]);
export type BrowserAnswer = z.infer<typeof browserAnswer>;
export function browserResult(answer: BrowserAnswer) {
  if ('clip' in answer) {
    const { image, ...source } = answer.clip;
    return {
      content: [
        { type: 'image' as const, data: image, mimeType: 'image/png' as const },
        { type: 'text' as const, text: JSON.stringify({ kind: 'sources', sources: [source] }) },
      ],
    };
  }
  if ('image' in answer)
    return {
      ...(answer.pageText && { pageText: answer.pageText }),
      content: [{ type: 'image' as const, data: answer.image, mimeType: 'image/png' as const }],
    };
  if ('error' in answer)
    return { content: [{ type: 'text' as const, text: answer.error }], isError: true };
  return { content: [{ type: 'text' as const, text: answer.text }] };
}

const region = {
  type: 'object',
  properties: {
    x: { type: 'integer' },
    y: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
  },
  required: ['x', 'y', 'width', 'height'],
};
const tab = {
  type: 'string',
  description:
    'Tab id returned by open. Omit to use your most recent tab; open creates a new tab when omitted.',
};
const stepProperties = {
  ref: { type: 'string', description: 'Element ref from browser_read, such as r12' },
  x: { type: 'number', description: 'Point in the page as browser_look shows it, instead of ref' },
  y: { type: 'number' },
  text: {
    type: 'string',
    description:
      'What to type or fill, the key to press, the option to select, the words to wait for, or the answer to a prompt',
  },
  to_ref: { type: 'string', description: 'Where a drag ends' },
  to_x: { type: 'number' },
  to_y: { type: 'number' },
  dx: { type: 'integer' },
  dy: { type: 'integer', description: 'Pixels to scroll: positive is down' },
  accept: { type: 'boolean', description: 'For dialog: true to accept, false to dismiss' },
  ms: { type: 'integer', description: 'For wait: the longest to wait, at most 10000' },
};
const tools: {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, object>; required?: string[] };
}[] = [
  {
    name: 'browser_open',
    description:
      'Open a web page in the browser beside the board, where the person can see it. Creates a new tab by default and returns its id. Takes a URL, or words to search for. To put the tab on the board, draw op browser with its url and this tab id.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, tab },
      required: ['url'],
    },
  },
  {
    name: 'browser_read',
    description:
      'Read the open page as text: its title, headings, text, and every control with a ref like [r12] to use with browser_act, with its state (checked, expanded, disabled) and value. Covers frames and page components. A long page is cut: give find with a few words to get the matching lines and their refs from the whole page.',
    inputSchema: {
      type: 'object',
      properties: {
        tab,
        find: {
          type: 'string',
          description: 'Words to search the whole page for, instead of reading it from the top',
        },
      },
    },
  },
  {
    name: 'browser_look',
    description:
      'See the open page as a picture, with its text. A point in the picture is the same x, y that browser_act takes, for a canvas, map or chart that has no ref.',
    inputSchema: { type: 'object', properties: { tab } },
  },
  {
    name: 'browser_clip',
    description:
      "Keep evidence only when the person asked for sources: crop a visible page region or find an exact text quote, and name the board and frame. The crop, exact quote and source link land together in the frame's bay.",
    inputSchema: {
      type: 'object',
      properties: {
        tab,
        quote: { type: 'string' },
        region,
        board: { type: 'string' },
        frame: { type: 'string' },
      },
      required: ['board', 'frame'],
    },
  },
  {
    name: 'browser_shot',
    description:
      'Keep a picture of the open page, or a region of it in page pixels, as an image file, and get its artifact id: put it on the board with draw op image, anywhere and at any width. For a screenshot of a site or product.',
    inputSchema: { type: 'object', properties: { tab, region } },
  },
  {
    name: 'browser_act',
    description:
      "Act on the open page, on an element by its ref from browser_read, or at a point x, y as browser_look shows it. do: click, double_click, right_click, hover; type (adds text at the cursor) or fill (replaces what is there); press (a key such as Enter, Tab, Escape, ArrowDown, or a chord such as Meta+A); select (text is the option, in a dropdown of any kind); scroll (dy pixels, or to a ref); drag (to to_ref or to_x, to_y); wait (for text to appear, at most ms); dialog (accept true or false, answering a page's question); back, forward, reload; close (this tab). Give steps to run several in one call, in order, stopping at the first that fails. The answer says what changed on the page, so read again only when it says the page changed a lot. Password, payment and file fields are the person's.",
    inputSchema: {
      type: 'object',
      properties: {
        tab,
        do: { type: 'string', enum: [...browserDo] },
        ...stepProperties,
        steps: {
          type: 'array',
          maxItems: 20,
          description: 'Several actions in one call, instead of do',
          items: {
            type: 'object',
            properties: { do: { type: 'string', enum: [...browserDo] }, ...stepProperties },
            required: ['do'],
          },
        },
      },
    },
  },
];
export const browserTools = tools.map((tool) => ({
  ...tool,
  description: `${tool.description} Use this when a page needs the person's own logins or a live look; prefer web.read for plain public search.`,
}));
