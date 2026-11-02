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
  title: 'AI note takers',
  ask: "What's out there for AI note takers?",
  calls: [
    [words('AI note takers', [0, 0], 'l', "Four names you'll hear the most.")],
    company(
      70,
      'granola.png',
      'Granola',
      'no bot, records on your computer',
      'Granola records on your laptop, so nothing shows up in the call.',
    ),
    company(
      170,
      'otter.png',
      'Otter',
      'joins the call, live transcript',
      'Otter joins the call. People mostly use it for the live transcript.',
    ),
    company(
      270,
      'fireflies.png',
      'Fireflies',
      'joins the call, sends notes to Salesforce',
      'Fireflies joins too, and sends the notes to Salesforce and tools like that.',
    ),
    company(
      370,
      'fathom.png',
      'Fathom',
      'joins the call, has a free plan',
      'Fathom joins too. People like the free plan.',
    ),
    [
      words(
        'Is there a bot in the call?',
        [640, 10],
        'm',
        talk(
          'They all sound the same to me.',
          'Pretty much. The big difference is whether a bot shows up in your call.',
        ),
      ),
    ],
    [
      draw(call(640), "Here's a normal call."),
      draw(robot(800), 'With most of them, this guy sits in it with you.', 'red'),
      words('Bot', [640, 240], 'm'),
      words('Otter, Fireflies, Fathom', [640, 275], 's'),
      words('everyone sees it, hooks into your tools', [640, 300], 's'),
    ],
    [
      draw(call(1070), "With Granola it's just the people on the call."),
      words('No bot', [1070, 240], 'm'),
      words('Granola', [1070, 275], 's'),
      words(
        'you have to tell people yourself',
        [1070, 300],
        's',
        "Nobody can see it, so it's on you to say you're recording.",
      ),
    ],
    [
      words(
        'Talk to people who quit one',
        [640, 360],
        'm',
        talk("So where's the gap?", "No idea yet. I'd go ask people who quit using one."),
      ),
      draw(Array.from({ length: 10 }, (_, i) => stick(660 + i * 60)).flat(), 'Ten is plenty.'),
    ],
    [
      words('Why did you stop?', [640, 510], 's', 'Ask why they stopped.'),
      words(
        'Does work let you use a bot?',
        [860, 510],
        's',
        'And whether work even lets them bring a bot.',
      ),
    ],
    [
      words(
        'First: find 10 of them',
        [640, 560],
        'l',
        talk('Okay, what do I do first?', 'Find those ten people. I can help with the questions.'),
      ),
    ],
  ],
};

export const DEMOS: Demo[] = [market];
