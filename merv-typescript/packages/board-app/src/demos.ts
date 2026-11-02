/**
 * What the landing page plays: a person asks, and the agent answers on the board, explaining as it
 * goes. Each is ordinary board content, one call a thought, as Pi is told to draw. An image names a
 * file in ../assets, which the server keeps as a file of the host project when it draws the demo.
 */
export interface Demo {
  title: string;
  /** What the person says first, printed before anything is drawn. */
  ask: string;
  /** The operations of each call, in order. */
  calls: object[][];
}

/** A line as a demo plays it: what the person says, printed as they say it, then the agent's answer. */
const talk = (person: string, agent: string) => `${person}\n${agent}`;
type At = [number, number];
const words = (text: string, at: At, size: string, say?: string) => ({
  op: 'text',
  text,
  size,
  at,
  ...(say && { say }),
});
/** A few pen strokes, in board coordinates. */
const draw = (paths: string[], say?: string, color?: string) => ({
  op: 'sketch',
  size: 'native',
  at: [0, 0],
  strokes: paths.map((path) => ({ path, width: 'medium', ...(color && { color }) })),
  ...(say && { say }),
});
const line = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1} L${x2} ${y2}`;
const circle = (x: number, y: number, r: number) =>
  `M${x - r} ${y} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
const rect = (x: number, y: number, w: number, h: number) =>
  `M${x} ${y} L${x + w} ${y} L${x + w} ${y + h} L${x} ${y + h} Z`;
/** A video call, as a window of faces. */
const call = (x: number) => [
  rect(x, 75, 230, 150),
  ...[50, 115].flatMap((dx) => [
    circle(x + dx, 130, 22),
    `M${x + dx - 10} ${136} Q${x + dx} ${148} ${x + dx + 10} ${136}`,
  ]),
];
const robot = (x: number) => [
  rect(x, 110, 44, 40),
  circle(x + 13, 125, 4),
  circle(x + 31, 125, 4),
  line(x + 12, 140, x + 32, 140),
  line(x + 22, 110, x + 22, 94),
  circle(x + 22, 90, 4),
];
const stick = (x: number) => [
  circle(x, 430, 10),
  line(x, 440, x, 472),
  line(x - 12, 452, x + 12, 452),
  line(x, 472, x - 10, 492),
  line(x, 472, x + 10, 492),
];
/** One row of the market map: its logo and, in hand, the one thing to know. */
const company = (y: number, asset: string, name: string, fact: string, say: string) => [
  { op: 'image', asset, at: [0, y], width: 52, alt: `${name} logo`, say },
  words(name, [68, y], 'm'),
  words(fact, [68, y + 30], 's'),
];

/** Market research with a person, ending on what to go and find out. */
const market: Demo = {
  title: 'AI note takers: who is out there',
  ask: 'Research the AI note taker market.',
  calls: [
    [
      words(
        'AI meeting note takers',
        [0, 0],
        'l',
        'Let us map it. Here are four you will run into first.',
      ),
    ],
    company(
      70,
      'granola.png',
      'Granola',
      'runs on your computer, no bot in the call',
      'Granola records from your own computer, so nothing joins the call.',
    ),
    company(
      170,
      'otter.png',
      'Otter',
      'joins your meetings, known for live transcripts',
      'Otter joins your meetings and is known for live transcripts.',
    ),
    company(
      270,
      'fireflies.png',
      'Fireflies',
      'a bot joins, sends notes into tools like Salesforce',
      'Fireflies sends a bot and pushes notes into sales tools.',
    ),
    company(
      370,
      'fathom.png',
      'Fathom',
      'a bot joins by default, known for its free plan',
      'Fathom joins by default too, and is known for its free plan.',
    ),
    [
      words(
        'One question splits them: does a bot join your call?',
        [640, 10],
        'm',
        talk(
          'They sound the same to me. What is the real difference?',
          'One question splits this market. Does a bot join your call?',
        ),
      ),
    ],
    [
      draw(call(640), 'Picture a normal call.'),
      draw(robot(800), 'With most of them, a bot sits in the call with you.', 'red'),
      words('A bot joins', [640, 240], 'm'),
      words('Otter, Fireflies, Fathom', [640, 275], 's'),
      words('everyone sees it, but it plugs into work tools', [640, 300], 's'),
    ],
    [
      draw(call(1070), 'With Granola, there is nobody extra.'),
      words('No bot', [1070, 240], 'm'),
      words('Granola', [1070, 275], 's'),
      words('discreet, but you must tell people yourself', [1070, 300], 's'),
    ],
    [
      words(
        'So what do we go and find out?',
        [640, 360],
        'm',
        talk(
          'So where is the opening for me?',
          'I would not guess yet. Here is what I would go and find out.',
        ),
      ),
      draw(
        Array.from({ length: 10 }, (_, i) => stick(660 + i * 60)).flat(),
        'Find ten people who stopped using one.',
      ),
    ],
    [
      words('Why did you stop?', [640, 510], 's', 'Ask why they stopped.'),
      words(
        'Are you even allowed to bring a bot to work?',
        [860, 510],
        's',
        'And whether they are allowed to bring a bot at all.',
      ),
    ],
    [
      words(
        'Next: talk to ten people who stopped.',
        [640, 560],
        'l',
        talk('Okay. Who should I talk to first?', 'Those ten people. Let us write the questions.'),
      ),
    ],
  ],
};

export const DEMOS: Demo[] = [market];
