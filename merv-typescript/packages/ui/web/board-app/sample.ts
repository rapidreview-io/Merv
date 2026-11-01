import type { BoardSummary } from '@merv/board/models';
import { call, refreshTools } from '../api';

/**
 * The one board everybody starts with: a true idea that clicks when it is drawn. Press play and a
 * pen says it. People picture 23 people; a match needs only a pair; and the pairs, drawn, fill the
 * circle. Each call is one thought, as Pi is told to draw, and it is ordinary board content.
 */
const PEOPLE = 23;
const R = 170;
const spot = (i: number): [number, number] => {
  const turn = (i / PEOPLE) * 2 * Math.PI - Math.PI / 2;
  return [R + R * Math.cos(turn), R + R * Math.sin(turn)];
};
const dot = (i: number) => {
  const [x, y] = spot(i);
  return `M${x - 6} ${y} a6 6 0 1 0 12 0 a6 6 0 1 0 -12 0 Z`;
};
const chord = (a: number, b: number) => {
  const [[x1, y1], [x2, y2]] = [spot(a), spot(b)];
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`;
};

export async function drawSample() {
  const at = [0, 90];
  const draw = (board: string | undefined, ops: object[]) =>
    call<{ board: BoardSummary }>('board.write:draw', {
      ...(board ? { board } : { title: 'Why 23 people are enough' }),
      ops,
    });
  const { board } = await draw(undefined, [
    {
      op: 'text',
      key: 'q',
      text: 'In a room of 23, two share a birthday. Even odds.\nWhy so few?',
      size: 'm',
      at: [0, 0],
      say: 'Everyone guesses you would need far more people.',
    },
  ]);
  const stroke = (paths: string[], extra: object) => ({
    op: 'sketch',
    size: 'native',
    at,
    strokes: paths.map((path) => ({ path, ...extra })),
  });
  await draw(board.id, [
    {
      ...stroke(
        Array.from({ length: PEOPLE }, (_, i) => dot(i)),
        { fill: 'black', width: 'thin' },
      ),
      key: 'room',
      say: 'Here are the 23 people. It looks like a small room.',
    },
  ]);
  await draw(board.id, [
    {
      ...stroke([chord(0, 9)], { color: 'red', width: 'medium' }),
      key: 'pair',
      say: 'But a match needs a pair, not a person.',
    },
  ]);
  const others: string[] = [];
  for (let a = 0; a < PEOPLE; a++)
    for (let b = a + 1; b < PEOPLE; b++) if (a || b !== 9) others.push(chord(a, b));
  // A call holds so many strokes; the pairs come in a few of them, faster as they go.
  for (let from = 0, part = 0; from < others.length; from += 80, part++)
    await draw(board.id, [
      {
        ...stroke(others.slice(from, from + 80), { color: 'blue', width: 'thin' }),
        ...(part === 0 && { say: 'So count the pairs. Every line is one.' }),
      },
    ]);
  await draw(board.id, [
    {
      op: 'text',
      text: '253 pairs',
      size: 'l',
      at: [420, 170],
      say: 'Two hundred and fifty three chances, not twenty three.',
    },
    {
      op: 'text',
      text: 'each one a 1 in 365 shot',
      size: 's',
      at: [420, 225],
      say: 'Each is a long shot. Together they are a coin flip.',
    },
  ]);
  refreshTools('board.read');
  return board.id;
}
