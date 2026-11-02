/**
 * What the board shows before anyone has done anything: true ideas that click when they are drawn,
 * as a pen says them. Each is ordinary board content, one call a thought, as Pi is told to draw:
 * the first is also the board a person starts with, and the landing page plays them all in turn.
 */
export interface Demo {
  title: string;
  /** The operations of each call, in order. */
  calls: object[][];
}

/** A line as a demo plays it: what the person says, printed as they say it, then what the agent says. */
export const talk = (person: string, agent: string) => `${person}\n${agent}`;
/** The agent's part of a line, for a demo drawn as an ordinary board. */
export const agentsPart = (ops: object[]) =>
  ops.map((op) => ('say' in op ? { ...op, say: String(op.say).split('\n').at(-1) } : op));

const circle = (x: number, y: number, r: number) =>
  `M${(x - r).toFixed(1)} ${y.toFixed(1)} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
const segment = (x1: number, y1: number, x2: number, y2: number) =>
  `M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`;
const sketch = (paths: string[], stroke: object, extra: object = {}) => ({
  op: 'sketch',
  size: 'native',
  at: [0, 0],
  strokes: paths.map((path) => ({ path, ...stroke })),
  ...extra,
});
const words = (text: string, at: [number, number], size: string, say?: string) => ({
  op: 'text',
  text,
  size,
  at,
  ...(say && { say }),
});
/** A call holds so many strokes: long runs come in a few, the first of them saying what they are. */
const inCalls = (paths: string[], stroke: object, say: string, size = 80) =>
  Array.from({ length: Math.ceil(paths.length / size) }, (_, part) => [
    sketch(paths.slice(part * size, (part + 1) * size), stroke, part ? {} : { say }),
  ]);

/** A room of 23: people picture 23, a match needs a pair, and the pairs, drawn, fill the circle. */
function birthdays(): Demo {
  const [PEOPLE, R, Y] = [23, 170, 90];
  const spot = (i: number): [number, number] => {
    const turn = (i / PEOPLE) * 2 * Math.PI - Math.PI / 2;
    return [R + R * Math.cos(turn), Y + R + R * Math.sin(turn)];
  };
  const chord = (a: number, b: number) => segment(...spot(a), ...spot(b));
  const pairs: string[] = [];
  for (let a = 0; a < PEOPLE; a++)
    for (let b = a + 1; b < PEOPLE; b++) if (a || b !== 9) pairs.push(chord(a, b));
  // The chance of a match by people in the room, as bars.
  const odds = [
    [5, 3],
    [10, 12],
    [15, 25],
    [23, 51],
    [30, 71],
    [40, 89],
    [50, 97],
  ] as const;
  const [BARS, FLOOR] = [420, 560];
  return {
    title: 'Why 23 people are enough',
    calls: [
      [
        words(
          'In a room of 23, two share a birthday. Even odds.\nWhy so few?',
          [0, 0],
          'm',
          talk(
            'Two people here share a birthday. Is that weird?',
            'Everyone guesses you would need far more people.',
          ),
        ),
      ],
      [
        sketch(
          Array.from({ length: PEOPLE }, (_, i) => circle(...spot(i), 6)),
          { fill: 'black', width: 'thin' },
          { key: 'room', say: 'Here are the 23 people. It looks like a small room.' },
        ),
      ],
      [
        sketch(
          [chord(0, 9)],
          { color: 'red', width: 'medium' },
          {
            key: 'pair',
            say: talk('Hang on, only 23 of us?', 'But a match needs a pair, not a person.'),
          },
        ),
      ],
      ...inCalls(
        pairs,
        { color: 'blue', width: 'thin' },
        talk('How many pairs is that?', 'So count the pairs. Every line is one.'),
      ),
      [
        words(
          '253 pairs',
          [420, 170],
          'l',
          'Two hundred and fifty three chances, not twenty three.',
        ),
        words(
          'each one a 1 in 365 shot',
          [420, 225],
          's',
          'Each is a long shot. Together they are a coin flip.',
        ),
      ],
      [
        words(
          'Chance of a match, by people in the room',
          [BARS, FLOOR - 250],
          's',
          talk('So how fast does it climb?', 'Faster than anyone expects.'),
        ),
        sketch([segment(BARS, FLOOR, BARS + 400, FLOOR)], { width: 'medium' }),
      ],
      ...odds.map(([people, percent], i) => {
        const x = BARS + 14 + i * 56;
        const top = FLOOR - percent * 2;
        return [
          sketch(
            [`M${x} ${FLOOR} L${x} ${top} L${x + 34} ${top} L${x + 34} ${FLOOR} Z`],
            {
              color: people === 23 ? 'red' : 'blue',
              fill: people === 23 ? 'red' : 'blue',
              width: 'thin',
            },
            people === 23
              ? { say: 'Twenty three is where it crosses one half.' }
              : people === 50
                ? { say: 'By fifty it is nearly certain.' }
                : {},
          ),
          words(`${percent}%`, [x, top - 28], 's'),
          words(`${people}`, [x + 6, FLOOR + 8], 's'),
        ];
      }),
      [
        words(
          'We count people. Chance counts pairs.',
          [0, FLOOR + 70],
          'l',
          talk('Oh. I was counting the wrong thing.', 'We count people. Chance counts pairs.'),
        ),
      ],
    ],
  };
}

/** A two-joint arm: the hand sweeps out a ring, and the hole in it is the links' difference. */
function arm(): Demo {
  const [X, Y, UPPER, FORE] = [270, 330, 150, 90];
  const elbow = (turn: number): [number, number] => [
    X + UPPER * Math.cos(turn),
    Y + UPPER * Math.sin(turn),
  ];
  const sweep = (x: number, y: number, a: number, b: number, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const turn = (i / count) * 2 * Math.PI;
      return circle(x + a * Math.cos(turn), y + a * Math.sin(turn), b);
    });
  const [ex, ey] = elbow(-0.7);
  const hand: [number, number] = [ex + FORE * Math.cos(0.5), ey + FORE * Math.sin(0.5)];
  const [X2, A] = [860, 120];
  return {
    title: 'Why a robot arm can’t touch its own shoulder',
    calls: [
      [
        words(
          'Two links, two joints.\nWhere can the hand reach?',
          [0, 0],
          'm',
          talk(
            'Draw me the simplest robot arm.',
            'Two links and two joints. That is all it takes.',
          ),
        ),
      ],
      [
        sketch(
          [circle(X, Y, 10)],
          { fill: 'black', width: 'thin' },
          {
            say: 'The shoulder is bolted down.',
          },
        ),
      ],
      [
        sketch(
          [segment(X, Y, ex, ey)],
          { width: 'bold' },
          {
            say: 'A long upper arm.',
          },
        ),
        sketch([circle(ex, ey, 7)], { fill: 'black', width: 'thin' }),
      ],
      [
        sketch(
          [segment(ex, ey, ...hand)],
          { width: 'bold', color: 'orange' },
          {
            say: 'And a shorter forearm, with the hand at its tip.',
          },
        ),
        sketch([circle(...hand, 7)], { fill: 'orange', color: 'orange', width: 'thin' }),
      ],
      [
        sketch(
          [circle(ex, ey, FORE)],
          { color: 'orange', width: 'medium' },
          {
            say: 'Hold the shoulder still and swing the elbow. The hand draws a circle.',
          },
        ),
      ],
      ...inCalls(
        sweep(X, Y, UPPER, FORE, 48),
        { color: 'blue', width: 'thin' },
        talk(
          'What if the shoulder moves too?',
          'Every position gives another circle, and they pile up.',
        ),
        8,
      ),
      [
        sketch(
          [circle(X, Y, UPPER + FORE)],
          { color: 'red', width: 'medium' },
          {
            say: 'The outside edge is the arm stretched straight out.',
          },
        ),
        words('fully stretched', [X + 150, Y - 250], 's'),
      ],
      [
        sketch(
          [circle(X, Y, UPPER - FORE)],
          { color: 'red', width: 'medium' },
          {
            say: talk('What is that hole in the middle?', 'A place nothing ever touches.'),
          },
        ),
        words('never reached', [X - 44, Y + 74], 's'),
      ],
      [
        words(
          'Folded all the way, the hand is still\nupper minus fore away from the shoulder.',
          [X2 - A - 60, Y - 300],
          's',
          'Fold it as tight as it goes, and the hand still stops short. That gap is the difference between the two links.',
        ),
      ],
      [
        words(
          'So make them equal.',
          [X2 - A - 60, Y - 230],
          'm',
          talk('What if both links were the same length?', 'Let us try it.'),
        ),
        sketch([circle(X2, Y, 10)], { fill: 'black', width: 'thin' }),
      ],
      ...inCalls(
        sweep(X2, Y, A, A, 48),
        { color: 'green', width: 'thin' },
        'Same sweep. Watch the middle.',
        8,
      ),
      [
        sketch(
          [circle(X2, Y, 2 * A)],
          { color: 'red', width: 'medium' },
          {
            say: 'The hole closes. The hand can reach its own shoulder.',
          },
        ),
      ],
      [
        words(
          'The hole is the difference between the links.',
          [0, Y + 290],
          'l',
          talk('So the hole is just the difference?', 'Yes. It was never about the joints.'),
        ),
      ],
    ],
  };
}

export const DEMOS: Demo[] = [birthdays(), arm()];
