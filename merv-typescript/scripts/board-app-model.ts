import { act, plan, scriptedBy, type Step } from './ui-demo-agent.js';

/** The gestures the demo's model already draws: their asks, as the board page sends them. */
const KNOWN = /\brose\b|^Draft |in steps|\b(finish|continue|complete)\b|another way|variant/i;

/**
 * Pi with no model key (`npm run board` without MERV_PI_MODEL_API_KEY): what it is asked goes on the
 * board in pen, in small calls that talk as they draw, as the real model is told to do, so the
 * whole app can be seen working with nothing leaving this computer.
 */
function drawn(asked: string, read: (tool: string) => unknown, note = ''): Step[] {
  if (KNOWN.test(asked)) return plan(asked, read, note);
  const board = /\[board ([\w-]+)/.exec(note)?.[1];
  const on = board ? { board } : { title: asked.slice(0, 60) };
  const made = read('board.write') as { board?: { id: string } } | undefined;
  const where = { board: board ?? made?.board?.id ?? 'none' };
  return [
    act('board.write', 'draw', {
      ...on,
      ops: [{ op: 'text', key: 'idea', text: asked.slice(0, 80), size: 'l', say: 'Start with the question itself.' }],
    }),
    act('board.write', 'draw', {
      ...where,
      ops: [
        {
          op: 'sketch',
          key: 'bulb',
          size: 'm',
          near: 'idea',
          side: 'below',
          strokes: [
            { path: 'M30 60 C10 45 10 15 40 10 C70 15 70 45 50 60 Z', color: 'yellow', fill: 'yellow' },
            { path: 'M32 66 L48 66 M34 72 L46 72' },
          ],
          say: 'Here is the spark we keep coming back to.',
        },
        { op: 'note', key: 'why', text: 'Why it matters', near: 'bulb', side: 'right' },
        { op: 'note', key: 'how', text: 'What would show it', near: 'why', side: 'right', color: 'blue' },
        { op: 'arrow', from: 'why', to: 'how', say: 'One leads to the other.' },
      ],
    }),
    { say: 'It is on the board. Mark anything and I will redraw it there.' },
  ];
}

export const boardModel = scriptedBy(drawn);
